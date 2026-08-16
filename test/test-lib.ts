import * as PM from "../lib/project-memory-lib"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-test-"))
const dbPath = path.join(dir, "memory.sqlite")
const db = PM.openMemory(dbPath)
const fts = PM.ftsAvailable(db)
console.log("FTS available:", fts)

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log("PASS", name) } else { fail++; console.log("FAIL", name, extra) }
}

// 1. NEW + claim
let r = PM.preflight(db, { task: "analyze widget X", claim: true, ownerSession: "ses_A", projectDir: dir, fts })
check("NEW claim", r.status === "NEW" && !!r.ticket, JSON.stringify(r))
const ticket1 = r.ticket!
check("scratch created", !!r.scratch && fs.existsSync(r.scratch!), r.scratch)

// 2. same session re-preflight → IN_PROGRESS
r = PM.preflight(db, { task: "analyze widget X", claim: true, ownerSession: "ses_A", projectDir: dir, fts })
check("re-claim own → IN_PROGRESS", r.status === "IN_PROGRESS", JSON.stringify(r))

// 3. other session → IN_PROGRESS with owner
r = PM.preflight(db, { task: "analyze widget X", claim: true, ownerSession: "ses_B", projectDir: dir, fts })
check("other session → IN_PROGRESS owner", r.status === "IN_PROGRESS" && r.owner_session === "ses_A", JSON.stringify(r))

// 4. record done → COVERED
let rec = PM.recordResult(db, { ticket: ticket1, status: "done", summary: "widget X analyzed: no vuln", evidence: ["report_widget_x.md"], facts: [{ key: "widget.x", value: "no vuln" }] })
check("record ok", rec.ok, JSON.stringify(rec))
r = PM.preflight(db, { task: "analyze widget X", claim: true, ownerSession: "ses_C", projectDir: dir, fts })
check("done → COVERED", r.status === "COVERED", JSON.stringify(r))
check("COVERED evidence", r.evidence.includes("report_widget_x.md"), JSON.stringify(r.evidence))

// 5. alias match
const c5 = PM.claimWorkItem(db, { canonicalKey: "widget Y", ownerSession: "ses_A" })
check("claim widget Y", c5.ok)
const y = db.query("SELECT * FROM work_items WHERE canonical_key='widget y'").get() as any
db.run("INSERT INTO aliases (work_item_id, alias) VALUES (?,?)", [y.id, "wy"])
r = PM.preflight(db, { task: "wy", claim: false, ownerSession: "ses_A", projectDir: dir, fts })
check("alias match → IN_PROGRESS", r.status === "IN_PROGRESS", JSON.stringify(r))

// 6. gate
let g = PM.gateDecision(db, { sessionID: "ses_C", args: { subagent_type: "subagent" } })
check("gate block (no claim)", g.action === "block", JSON.stringify(g))
g = PM.gateDecision(db, { sessionID: "ses_C", args: { subagent_type: "vision" } })
check("gate allow vision", g.action === "allow")
g = PM.gateDecision(db, { sessionID: "ses_C", args: { task_id: "ses_123" } })
check("gate allow steering", g.action === "allow")
g = PM.gateDecision(db, { sessionID: "ses_A", args: { subagent_type: "subagent" } })
check("gate allow (has claim)", g.action === "allow", JSON.stringify(g))

// 7. failure append
const f = PM.appendFailure(db, { projectDir: dir, symptom: "s", cause: "c", lesson: "l", topic: "widget X", fts })
check("failure id format", /^FAIL-\d{8}-[A-Z0-9]{8}$/.test(f.id), f.id)
check("failure file exists", fs.existsSync(f.path))
r = PM.preflight(db, { task: "widget X", claim: false, ownerSession: "ses_D", projectDir: dir, fts })
check("failure topic → COVERED", r.status === "COVERED", JSON.stringify(r))

// 8. goal checkpoint
const cp = PM.checkpointGoal(dir, "# goal-state\n\nupdated")
check("checkpoint file", fs.existsSync(cp.path) && fs.readFileSync(cp.path, "utf8").includes("updated"))

// 9. bootstrap idempotent
const b1 = PM.bootstrap(db, dir, fts)
const b2 = PM.bootstrap(db, dir, fts)
check("bootstrap idempotent", b1.imported === b2.imported, `${b1.imported} vs ${b2.imported}`)

// 10. PARTIAL via FTS candidate
const c10 = PM.claimWorkItem(db, { canonicalKey: "network probe of device", summary: "ports scanned", ownerSession: "ses_A" })
PM.recordResult(db, { ticket: c10.ok ? c10.item.id : c10.inProgress.id, status: "done", summary: "ports scanned: 53,80,443 open" })
r = PM.preflight(db, { task: "probe device ports deeper", claim: true, ownerSession: "ses_E", projectDir: dir, fts })
check("FTS candidate → PARTIAL", r.status === "PARTIAL", JSON.stringify(r))

// 11. in_progress candidate dedup (different wording → IN_PROGRESS, no 2nd claim)
const c11 = PM.claimWorkItem(db, { canonicalKey: "inspect widget alpha for flaws", ownerSession: "ses_A" })
const t11 = c11.ok ? c11.item.id : c11.inProgress.id
r = PM.preflight(db, { task: "determine whether flaws occur in widget alpha", claim: true, ownerSession: "ses_F", projectDir: dir, fts })
check("in_progress candidate → IN_PROGRESS same ticket", r.status === "IN_PROGRESS" && r.ticket === t11, JSON.stringify(r))

// 12. concurrent failure ids all unique (collision-safe)
const ids12: string[] = []
await Promise.all(Array.from({ length: 20 }, async (_, i) => {
  const f12 = PM.appendFailure(db, { projectDir: dir, symptom: `s${i}`, cause: `c${i}`, lesson: `l${i}`, fts })
  ids12.push(f12.id)
}))
check("concurrent failure ids unique", new Set(ids12).size === ids12.length, ids12.join(" "))

// 13. FTS sync staleness race: same-ms insert after a sync is missed by max-updated_at-only tracking
const dir13 = fs.mkdtempSync(path.join(os.tmpdir(), "pm-fts-"))
const db13 = PM.openMemory(path.join(dir13, "memory.sqlite"))
const fts13 = PM.ftsAvailable(db13)
PM.claimWorkItem(db13, { canonicalKey: "widget alpha", ownerSession: "ses_A" })
PM.syncAllFts(db13, fts13)
const maxUpd13 = (db13.query("SELECT MAX(updated_at) AS m FROM work_items").get() as { m: string }).m
db13.run("INSERT INTO meta (key, value) VALUES ('last_fts_sync', ?)", [maxUpd13])
db13.run("INSERT INTO work_items (id, canonical_key, status, summary, unresolved, notes, owner_session, parent_key, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", ["idB13", "widget beta", "in_progress", "beta item", "", "", "ses_A", null, "agent", maxUpd13, maxUpd13])
PM.maybeSyncFts(db13, fts13)
const n13 = (db13.query("SELECT COUNT(*) AS n FROM memory_fts WHERE canonical_key='widget beta'").get() as { n: number }).n
check("fts staleness race: same-ms insert synced", n13 === 1, `count=${n13}`)

// 14-17. goal checkpoint managed section (G1 history preserve, G2 replace, G3 tiny, G5 no tmp files)
const GS = "<!-- PROJECT-MEMORY:CURRENT-START -->"
const GE = "<!-- PROJECT-MEMORY:CURRENT-END -->"
const dirG = fs.mkdtempSync(path.join(os.tmpdir(), "pm-goal-"))
const gdir = path.join(dirG, ".opencode")
fs.mkdirSync(gdir, { recursive: true })
const hist = Array.from({ length: 200 }, (_, i) => `historical line ${i}`).join("\n")
fs.writeFileSync(path.join(gdir, "goal-state.md"), hist, "utf8")
PM.checkpointGoal(dirG, "checkpoint v1")
let g1 = fs.readFileSync(path.join(gdir, "goal-state.md"), "utf8")
check("G1 history preserved + section appended", g1.startsWith(hist) && g1.includes(GS) && g1.includes(GE) && g1.includes("checkpoint v1"))
PM.checkpointGoal(dirG, "checkpoint v2")
g1 = fs.readFileSync(path.join(gdir, "goal-state.md"), "utf8")
check("G2 section replaced in place", g1.startsWith(hist) && g1.includes("checkpoint v2") && !g1.includes("checkpoint v1"))
PM.checkpointGoal(dirG, "x")
g1 = fs.readFileSync(path.join(gdir, "goal-state.md"), "utf8")
check("G3 tiny checkpoint keeps history", g1.startsWith(hist) && g1.includes(GS + "\nx\n" + GE))
const tmpLeft = fs.readdirSync(gdir).filter((f) => f.startsWith(".goal-state.md.tmp-")).length
check("G5 no tmp files left behind", tmpLeft === 0, `left=${tmpLeft}`)

// 18: failure append authorization matrix
{
  const primaries = ["orchestrator", "orchestrator-goal"]
  check("auth orchestrator can append failures", PM.canAppendFailure("orchestrator", primaries) === true)
  check("auth orchestrator-goal can append failures", PM.canAppendFailure("orchestrator-goal", primaries) === true)
  check("auth subagent can append failures", PM.canAppendFailure("subagent", primaries) === true)
  check("auth verifier cannot append failures", PM.canAppendFailure("verifier", primaries) === false)
  check("auth vision cannot append failures", PM.canAppendFailure("vision", primaries) === false)
  check("auth unknown agent cannot append failures", PM.canAppendFailure("", primaries) === false)
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)