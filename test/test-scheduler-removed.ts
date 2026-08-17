// test-scheduler-removed.ts — regression: project-memory is a MEMORY plugin, not
// a scheduler. Proven:
//   1. The plugin exposes EXACTLY five public tools (no project_goal_update).
//   2. No tool.execute.before/after task hooks, no event (session.created) hooks.
//   3. project_work_save has no `facts` argument.
//   4. No gateDecision/gateSafe/bindClaimToChild exports remain in the lib.
//   5. FTS-related ACTIVE work never becomes IN_PROGRESS automatically.
//   6. FTS still supplies useful PARTIAL context.
//   7. Bootstrap no longer deletes/recreates historical work items.
//   8. Markdown read_first safely returns no matches when FTS is unavailable.
//   9. failure_save still works for a subagent (plugin level).
//  10. work_check semantics stay obvious (NEW/COVERED/MEMORY_ERROR).
import plugin from "../project-memory"
import * as PM from "../lib/project-memory-lib"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log("PASS", name) } else { fail++; console.log("FAIL", name, extra) }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-nosched-"))

// ---- 1 & 2: public tool surface ----
{
  const dir = path.join(tmp, "surface")
  fs.mkdirSync(path.join(dir, ".opencode"), { recursive: true })
  const hdb = PM.openMemory(path.join(dir, ".opencode", "memory.sqlite"))
  PM.ftsAvailable(hdb)
  hdb.close()
  const hooks: any = await (plugin as any).server({ directory: dir })
  const toolNames = Object.keys(hooks.tool ?? {}).sort()
  check("1 exactly five public tools", JSON.stringify(toolNames) === JSON.stringify(["project_failure_save", "project_idea_save", "project_idea_search", "project_work_check", "project_work_save"]), JSON.stringify(toolNames))
  check("1 no project_goal_update", !toolNames.includes("project_goal_update"))
  check("2 no tool.execute.before", hooks["tool.execute.before"] === undefined)
  check("2 no tool.execute.after", hooks["tool.execute.after"] === undefined)
  check("2 no event hook", hooks["event"] === undefined)
  check("4 no gate/bind exports", (PM as any).gateDecision === undefined && (PM as any).gateSafe === undefined && (PM as any).bindClaimToChild === undefined)
  // work_save args: no facts
  const saveArgs = Object.keys(hooks.tool.project_work_save?.args ?? {})
  check("3 work_save has no facts arg", !saveArgs.includes("facts"), JSON.stringify(saveArgs))
}

// ---- 5 & 6: FTS is related context only ----
{
  const dir = path.join(tmp, "ftsctx")
  fs.mkdirSync(path.join(dir, ".opencode"), { recursive: true })
  const db = PM.openMemory(path.join(dir, ".opencode", "memory.sqlite"))
  const fts = PM.ftsAvailable(db)
  // active item, different wording FTS-matches it
  const c1 = PM.claimWorkItem(db, { canonicalKey: "inspect widget alpha for flaws", ownerSession: "ses_A" })
  const t1 = c1.ok ? c1.item.id : c1.inProgress.id
  // completed item supplies PARTIAL context
  const c2 = PM.claimWorkItem(db, { canonicalKey: "network probe of device", summary: "ports scanned", ownerSession: "ses_A" })
  PM.recordResult(db, { ticket: c2.ok ? c2.item.id : c2.inProgress.id, status: "done", summary: "ports scanned: 53,80,443 open", ownerSession: "ses_A" })
  db.close()
  const hooks: any = await (plugin as any).server({ directory: dir })
  // active FTS candidate must NOT become IN_PROGRESS
  const r1 = JSON.parse(await hooks.tool.project_work_check.execute({ work: "determine whether flaws occur in widget alpha" }, { sessionID: "ses_B", agent: "orchestrator", directory: dir }))
  check("5 FTS active candidate not IN_PROGRESS", r1.status === "NEW" && r1.ticket !== t1, JSON.stringify(r1))
  // completed FTS candidate still supplies PARTIAL context
  const r2 = JSON.parse(await hooks.tool.project_work_check.execute({ work: "probe device ports deeper" }, { sessionID: "ses_B", agent: "orchestrator", directory: dir }))
  check("6 FTS completed candidate → PARTIAL context", r2.status === "PARTIAL" && r2.established.some((e: string) => e.includes("ports scanned")), JSON.stringify(r2))
}

// ---- 7: bootstrap preserves historical work items ----
{
  const dir = path.join(tmp, "bootpreserve")
  fs.mkdirSync(path.join(dir, ".opencode"), { recursive: true })
  fs.writeFileSync(path.join(dir, ".opencode", "VECTORS.md"), "### legacy vector\n**Stato**: FATTO\n**Sintesi**: old imported row\n")
  const db = PM.openMemory(path.join(dir, ".opencode", "memory.sqlite"))
  const fts = PM.ftsAvailable(db)
  // simulate a historical bootstrap:imported row from an older plugin version
  const now = PM.nowIso()
  db.run("INSERT INTO work_items (id, canonical_key, status, summary, unresolved, notes, owner_session, parent_key, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", ["hist1", "legacy vector", "done", "old imported summary", "", "", null, null, "bootstrap:VECTORS.md", now, now])
  db.run("INSERT INTO evidence (work_item_id, path, kind, note) VALUES (?,?,?,?)", ["hist1", path.join(dir, ".opencode", "VECTORS.md"), "vectors", "legacy vector"])
  const before = (db.query("SELECT COUNT(*) AS n FROM work_items WHERE source LIKE 'bootstrap:%'").get() as { n: number }).n
  const b = PM.bootstrap(db, dir, fts)
  const after = (db.query("SELECT COUNT(*) AS n FROM work_items WHERE source LIKE 'bootstrap:%'").get() as { n: number }).n
  const hist = db.query("SELECT * FROM work_items WHERE id='hist1'").get() as any
  check("7 bootstrap imports nothing", b.imported === 0, JSON.stringify(b))
  check("7 historical rows not deleted", before === 1 && after === 1, `${before}->${after}`)
  check("7 historical row not rewritten", hist?.summary === "old imported summary" && hist?.status === "done", JSON.stringify(hist))
  db.close()
}

// ---- 8: read_first safely returns no Markdown matches without FTS ----
{
  const dir = path.join(tmp, "nofts")
  const db = PM.openMemory(path.join(dir, ".opencode", "memory.sqlite"))
  const c = PM.claimWorkItem(db, { canonicalKey: "some task", ownerSession: "ses_A" })
  const r = PM.preflight(db, { task: "some task", claim: false, ownerSession: "ses_A", projectDir: dir, fts: false })
  check("8 read_first empty without FTS", Array.isArray(r.read_first) && r.read_first.length === 0, JSON.stringify(r.read_first))
  check("8 bootstrap safe without FTS", (() => { const b = PM.bootstrap(db, dir, false); return b.imported === 0 && Array.isArray(b.sources) && b.sources.length === 0 })())
  db.close()
}

// ---- 9 & 10: plugin-level failure_save for subagent + work_check semantics ----
{
  const dir = path.join(tmp, "subfail")
  fs.mkdirSync(path.join(dir, ".opencode"), { recursive: true })
  const hdb = PM.openMemory(path.join(dir, ".opencode", "memory.sqlite"))
  PM.ftsAvailable(hdb)
  hdb.close()
  const hooks: any = await (plugin as any).server({ directory: dir })
  const out = JSON.parse(await hooks.tool.project_failure_save.execute({ symptom: "boom", cause: "x", lesson: "avoid x" }, { sessionID: "s1", agent: "subagent", directory: dir }))
  check("9 subagent failure_save ok", out.ok === true && /^FAIL-\d{8}-[A-Z0-9]{8}$/.test(out.id ?? ""), JSON.stringify(out))
  const ver = JSON.parse(await hooks.tool.project_failure_save.execute({ symptom: "boom", cause: "x", lesson: "avoid x" }, { sessionID: "s1", agent: "verifier", directory: dir }))
  check("9 verifier failure_save denied", ver.ok === false, JSON.stringify(ver))
  const vis = JSON.parse(await hooks.tool.project_failure_save.execute({ symptom: "boom", cause: "x", lesson: "avoid x" }, { sessionID: "s1", agent: "vision", directory: dir }))
  check("9 vision failure_save denied", vis.ok === false, JSON.stringify(vis))
  check("9 failure_save did not create FAILURES.md", !fs.existsSync(path.join(dir, ".opencode", "FAILURES.md")))
  const wr = JSON.parse(await hooks.tool.project_work_check.execute({ work: "fresh never-seen topic zzqq" }, { sessionID: "s2", agent: "orchestrator", directory: dir }))
  check("10 work_check NEW semantics", wr.status === "NEW" && !!wr.ticket, JSON.stringify(wr))
  const saved = JSON.parse(await hooks.tool.project_work_save.execute({ ticket: wr.ticket, status: "done", summary: "resolved" }, { sessionID: "s2", agent: "orchestrator", directory: dir }))
  check("10 work_save ok", saved.ok === true, JSON.stringify(saved))
  const cov = JSON.parse(await hooks.tool.project_work_check.execute({ work: "fresh never-seen topic zzqq" }, { sessionID: "s3", agent: "orchestrator", directory: dir }))
  check("10 work_check COVERED semantics", cov.status === "COVERED" && cov.ticket === wr.ticket, JSON.stringify(cov))
}

// ---- 10b: work_save ownership at the plugin level: a foreign primary session cannot
// finish an in_progress ticket; the owning session can ----
{
  const dir = path.join(tmp, "owner")
  fs.mkdirSync(path.join(dir, ".opencode"), { recursive: true })
  const hdb = PM.openMemory(path.join(dir, ".opencode", "memory.sqlite"))
  PM.ftsAvailable(hdb)
  hdb.close()
  const hooks: any = await (plugin as any).server({ directory: dir })
  const wr = JSON.parse(await hooks.tool.project_work_check.execute({ work: "ownership enforcement topic" }, { sessionID: "sA", agent: "orchestrator", directory: dir }))
  check("10b work_check claims for sA", wr.status === "NEW" && !!wr.ticket, JSON.stringify(wr))
  const foreign = JSON.parse(await hooks.tool.project_work_save.execute({ ticket: wr.ticket, status: "done", summary: "stolen" }, { sessionID: "sB", agent: "orchestrator", directory: dir }))
  check("10b foreign session work_save denied", foreign.ok === false && /owned by/.test(foreign.reason ?? ""), JSON.stringify(foreign))
  const own = JSON.parse(await hooks.tool.project_work_save.execute({ ticket: wr.ticket, status: "done", summary: "owned" }, { sessionID: "sA", agent: "orchestrator", directory: dir }))
  check("10b owning session work_save ok", own.ok === true, JSON.stringify(own))
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)