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
let rec = PM.recordResult(db, { ticket: ticket1, status: "done", summary: "widget X analyzed: no vuln", evidence: ["report_widget_x.md"], ownerSession: "ses_A" })
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

// 6. failure append
const f = PM.appendFailure(db, { projectDir: dir, symptom: "s", cause: "c", lesson: "l", topic: "widget X", fts })
check("failure id format", /^FAIL-\d{8}-[A-Z0-9]{8}$/.test(f.id), f.id)
check("failure file exists", fs.existsSync(f.path))
r = PM.preflight(db, { task: "widget X", claim: false, ownerSession: "ses_D", projectDir: dir, fts })
check("failure topic → COVERED", r.status === "COVERED", JSON.stringify(r))

// 7. bootstrap indexes markdown only — never imports or rewrites work_items
const b1 = PM.bootstrap(db, dir, fts)
const b2 = PM.bootstrap(db, dir, fts)
check("bootstrap never imports work items", b1.imported === 0 && b2.imported === 0, `${b1.imported} vs ${b2.imported}`)
check("bootstrap idempotent sources", JSON.stringify(b1.sources) === JSON.stringify(b2.sources))

// 8. PARTIAL via FTS candidate (related context)
const c10 = PM.claimWorkItem(db, { canonicalKey: "network probe of device", summary: "ports scanned", ownerSession: "ses_A" })
PM.recordResult(db, { ticket: c10.ok ? c10.item.id : c10.inProgress.id, status: "done", summary: "ports scanned: 53,80,443 open", ownerSession: "ses_A" })
r = PM.preflight(db, { task: "probe device ports deeper", claim: true, ownerSession: "ses_E", projectDir: dir, fts })
check("FTS candidate → PARTIAL", r.status === "PARTIAL", JSON.stringify(r))

// 9. FTS-related ACTIVE work never becomes IN_PROGRESS automatically
// A different wording FTS-matches the active ticket but must NOT inherit it:
// the request claims its own NEW ticket and the active item stays untouched.
// Isolated DB so the only FTS candidate is the active item itself.
{
  const dir9 = fs.mkdtempSync(path.join(os.tmpdir(), "pm-active-"))
  const db9 = PM.openMemory(path.join(dir9, "memory.sqlite"))
  const fts9 = PM.ftsAvailable(db9)
  const c11 = PM.claimWorkItem(db9, { canonicalKey: "inspect widget alpha for flaws", ownerSession: "ses_A" })
  const t11 = c11.ok ? c11.item.id : c11.inProgress.id
  const r = PM.preflight(db9, { task: "determine whether flaws occur in widget alpha", claim: true, ownerSession: "ses_F", projectDir: dir9, fts: fts9 })
  check("FTS active candidate NOT auto-IN_PROGRESS", r.status === "NEW", JSON.stringify(r))
  check("FTS active candidate claims its own ticket", !!r.ticket && r.ticket !== t11, JSON.stringify(r))
  const activeRow = db9.query("SELECT * FROM work_items WHERE id=?").get(t11) as any
  check("FTS active item untouched", activeRow.status === "in_progress" && activeRow.owner_session === "ses_A", JSON.stringify(activeRow))
  db9.close()
}

// 10. concurrent failure ids all unique (collision-safe)
const ids12: string[] = []
await Promise.all(Array.from({ length: 20 }, async (_, i) => {
  const f12 = PM.appendFailure(db, { projectDir: dir, symptom: `s${i}`, cause: `c${i}`, lesson: `l${i}`, fts })
  ids12.push(f12.id)
}))
check("concurrent failure ids unique", new Set(ids12).size === ids12.length, ids12.join(" "))

// 11. FTS sync staleness race: same-ms insert after a sync is missed by max-updated_at-only tracking
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

// 12: failure append authorization matrix
{
  const primaries = ["orchestrator", "orchestrator-goal"]
  check("auth orchestrator can append failures", PM.canAppendFailure("orchestrator", primaries) === true)
  check("auth orchestrator-goal can append failures", PM.canAppendFailure("orchestrator-goal", primaries) === true)
  check("auth subagent cannot append failures", PM.canAppendFailure("subagent", primaries) === false)
  check("auth verifier cannot append failures", PM.canAppendFailure("verifier", primaries) === false)
  check("auth vision cannot append failures", PM.canAppendFailure("vision", primaries) === false)
  check("auth unknown agent cannot append failures", PM.canAppendFailure("", primaries) === false)
}

// 13: failed record → re-claimable on the SAME ticket with PARTIAL semantics
// (prior failure context + do_not_repeat + evidence returned, not fresh NEW work)
const c19 = PM.claimWorkItem(db, { canonicalKey: "widget failed retry", ownerSession: "ses_A", summary: "widget failed retry" })
const t19 = c19.ok ? c19.item.id : c19.inProgress.id
const rec19 = PM.recordResult(db, { ticket: t19, status: "failed", summary: "retry failed", evidence: ["fail_log.txt"], ownerSession: "ses_A" })
check("19 record failed ok", rec19.ok, JSON.stringify(rec19))
r = PM.preflight(db, { task: "widget failed retry", claim: true, ownerSession: "ses_G", projectDir: dir, fts })
check("19 failed → PARTIAL same ticket", r.status === "PARTIAL" && r.ticket === t19, JSON.stringify(r))
check("19 PARTIAL keeps prior failure context", r.established.some((e) => e.includes("prior failed attempt") && e.includes("retry failed")), JSON.stringify(r.established))
check("19 PARTIAL carries do_not_repeat", r.do_not_repeat.some((d) => /Prior attempt failed/i.test(d)), JSON.stringify(r.do_not_repeat))
check("19 PARTIAL keeps prior evidence", r.evidence.includes("fail_log.txt"), JSON.stringify(r.evidence))
check("19 PARTIAL unresolved is the retried work", r.unresolved.some((u) => u.includes("widget failed retry")), JSON.stringify(r.unresolved))
check("19 count 1", (db.query("SELECT COUNT(*) AS n FROM work_items WHERE canonical_key='widget failed retry'").get() as any).n === 1)
// stored unresolved delta on the failed row is preferred over the request text
const rec19b = PM.recordResult(db, { ticket: t19, status: "failed", summary: "still failing", unresolved: "fix the sink function only", ownerSession: "ses_G" })
check("19b record failed with delta ok", rec19b.ok, JSON.stringify(rec19b))
r = PM.preflight(db, { task: "widget failed retry", claim: true, ownerSession: "ses_H", projectDir: dir, fts })
check("19b PARTIAL carries stored delta", r.status === "PARTIAL" && r.ticket === t19 && r.unresolved.some((u) => u.includes("fix the sink function only")), JSON.stringify(r.unresolved))

console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)