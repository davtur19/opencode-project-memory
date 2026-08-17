// test-final-hardening.ts — regression for the final hardening/cleanup pass:
//   1. ownership: owner_session set + caller != owner => reject for EVERY status
//      (including terminal done/failed/blocked/covered) — a stale pre-reclaim
//      owner cannot overwrite the result saved by the new owner; the current
//      owner may record terminal and in-progress work; legacy ownerless rows
//      stay writable by any caller;
//   2. reclaim CAS/race behavior remains correct;
//   3. same-call V2 satisfies: a validated idea + condition + satisfies all in
//      one call succeeds; an unknown satisfies target fails atomically with zero
//      partial writes; implicit placeholders stay disabled;
//   4. failure_save: subagent allowed, verifier/vision and unrelated agents
//      denied; SQLite-only persistence that never creates or modifies
//      FAILURES.md; saved failures recoverable through normal project memory;
//      historical DBs stay compatible.
import plugin from "../project-memory"
import * as PM from "../lib/project-memory-lib"
import * as PM2 from "../lib/project-memory-v2"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log("PASS", name) } else { fail++; console.log("FAIL", name, extra) }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-final-"))
function freshDb(tag: string): { db: PM.DB; dir: string; fts: boolean } {
  const dir = fs.mkdtempSync(path.join(tmp, tag))
  const db = PM.openMemory(path.join(dir, "memory.sqlite"))
  return { db, dir, fts: PM.ftsAvailable(db) }
}
const claim = (db: PM.DB, key: string, owner: string) => {
  const c = PM.claimWorkItem(db, { canonicalKey: key, ownerSession: owner, summary: key })
  return c.ok ? c.item.id : c.inProgress.id
}
const save = (db: PM.DB, ticket: string, status: string, ownerSession: string, extra: any = {}) => PM.recordResult(db, { ticket, status, ...extra, ownerSession })

// ---- 1a. stale pre-reclaim owner cannot overwrite a terminal result ----
{
  const { db, dir, fts } = freshDb("stale")
  const t = claim(db, "disable VOX25 DHCP", "ses_A")
  const rc = PM.preflight(db, { task: "disable VOX25 DHCP", claim: true, ownerSession: "ses_B", projectDir: dir, fts, reclaimTicket: t, reclaimOwner: "ses_A" })
  check("F1 stale reclaim → NEW same ticket", rc.status === "NEW" && rc.ticket === t && rc.owner_session === "ses_B", JSON.stringify(rc))
  const recB = save(db, t, "done", "ses_B", { summary: "B finished the work" })
  check("F1 new owner saves result", recB.ok === true && recB.item.status === "done", JSON.stringify(recB))
  const stale = save(db, t, "done", "ses_A", { summary: "stale A overwrite" })
  check("F1 stale pre-reclaim owner cannot overwrite terminal", stale.ok === false && /owned by ses_B/.test(stale.reason ?? ""), JSON.stringify(stale))
  const row = db.query("SELECT * FROM work_items WHERE id=?").get(t) as any
  check("F1 row still holds new owner's result", row.status === "done" && row.owner_session === "ses_B" && row.summary === "B finished the work", JSON.stringify(row))
  // every terminal status is protected against a stale owner
  const tF = claim(db, "fail item", "ses_A")
  PM.preflight(db, { task: "fail item", claim: true, ownerSession: "ses_B", projectDir: dir, fts, reclaimTicket: tF, reclaimOwner: "ses_A" })
  save(db, tF, "failed", "ses_B", { summary: "B failed it" })
  const staleF = save(db, tF, "failed", "ses_A", { summary: "A stale overwrite" })
  check("F1 stale owner cannot overwrite terminal failed", staleF.ok === false, JSON.stringify(staleF))
  const tB = claim(db, "block item", "ses_A")
  PM.preflight(db, { task: "block item", claim: true, ownerSession: "ses_B", projectDir: dir, fts, reclaimTicket: tB, reclaimOwner: "ses_A" })
  save(db, tB, "blocked", "ses_B", { summary: "B blocked it" })
  const staleB = save(db, tB, "blocked", "ses_A", { summary: "A stale overwrite" })
  check("F1 stale owner cannot overwrite terminal blocked", staleB.ok === false, JSON.stringify(staleB))
}

// ---- 1b. current owner can save terminal/in-progress work as intended ----
{
  const { db } = freshDb("ownerterm")
  const t = claim(db, "item one", "ses_A")
  const rec1 = save(db, t, "done", "ses_A", { summary: "done v1" })
  check("F1 owner records done", rec1.ok === true, JSON.stringify(rec1))
  const rec2 = save(db, t, "blocked", "ses_A", { summary: "done v2 blocked" })
  check("F1 owner re-records terminal", rec2.ok === true && rec2.item.status === "blocked" && rec2.item.summary === "done v2 blocked", JSON.stringify(rec2))
  const t2 = claim(db, "item two", "ses_A")
  const rec3 = save(db, t2, "failed", "ses_A", { summary: "in-progress fail" })
  check("F1 owner records in-progress failure", rec3.ok === true && rec3.item.status === "failed", JSON.stringify(rec3))
}

// ---- 1c. legacy ownerless row remains compatible (writable by any caller) ----
{
  const { db } = freshDb("legacyowner")
  const now = PM.nowIso()
  db.run("INSERT INTO work_items (id, canonical_key, status, summary, unresolved, notes, owner_session, parent_key, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", ["leg1", "legacy ownerless", "new", "", "", "", null, null, "agent", now, now])
  const r1 = save(db, "leg1", "done", "ses_anyone", { summary: "anyone can finish a legacy row" })
  check("F1 ownerless legacy row writable", r1.ok === true && r1.item.status === "done", JSON.stringify(r1))
  const r2 = save(db, "leg1", "blocked", "ses_other", { summary: "again by another session" })
  check("F1 ownerless legacy row writable by another", r2.ok === true && r2.item.status === "blocked", JSON.stringify(r2))
}

// ---- 2. reclaim CAS/race behavior remains correct ----
{
  const { db, dir, fts } = freshDb("cas")
  const t = claim(db, "reclaim item", "ses_A")
  const results = await Promise.all(Array.from({ length: 8 }, async (_, i) => PM.preflight(db, { task: "reclaim item", claim: true, ownerSession: "ses_race_" + i, projectDir: dir, fts, reclaimTicket: t, reclaimOwner: "ses_A" })))
  const winners = results.filter((r) => r.status === "NEW" && r.ticket === t)
  check("F2 reclaim race exactly one winner", winners.length === 1, JSON.stringify(results.map((r) => ({ s: r.status, o: r.owner_session }))))
  const w = winners[0] as any
  const stale = PM.preflight(db, { task: "reclaim item", claim: true, ownerSession: "ses_stale", projectDir: dir, fts, reclaimTicket: t, reclaimOwner: "ses_A" })
  check("F2 stale-owner CAS denied after race", !!(stale as any).reclaim_error, JSON.stringify(stale))
  const rec = save(db, t, "done", w.owner_session, { summary: "winner done" })
  check("F2 race winner can record", rec.ok === true, JSON.stringify(rec))
  check("F2 single row", (db.query("SELECT COUNT(*) AS n FROM work_items WHERE canonical_key='reclaim item'").get() as { n: number }).n === 1)
}

// ---- 3a. same-call validated idea + condition + satisfies succeeds ----
{
  const { db } = freshDb("samecall-satisfies")
  PM2.ensureV2Schema(db, PM.ftsAvailable(db))
  const r = PM2.ideaRecord(db, {
    idea: { key: "validated idea", status: "validated", evidence: "evidence.log: reproduced" },
    conditions: [{ key: "C1", description: "cond c1" }],
    satisfies: ["C1"],
  })
  check("F3 same-call validated+condition+satisfies ok", r.ok === true && r.idea?.status === "validated", JSON.stringify(r))
  const c1 = db.query("SELECT * FROM conditions WHERE canonical_key='c1'").get() as any
  check("F3 condition satisfied with idea id provenance", !!c1 && c1.satisfied === 1 && c1.satisfied_by === r.idea?.id, JSON.stringify(c1))
  const ret = r.conditions ?? []
  check("F3 returned condition reflects satisfied", ret.some((c: any) => c.key === "c1" && c.satisfied === true), JSON.stringify(ret))
}

// ---- 3b. same-call satisfies against a pre-existing condition also works ----
{
  const { db } = freshDb("existing-cond")
  PM2.ensureV2Schema(db, PM.ftsAvailable(db))
  PM2.ideaRecord(db, { idea: { key: "holder" }, conditions: [{ key: "C9", description: "pre-existing" }] })
  const r = PM2.ideaRecord(db, { idea: { key: "satisfier", status: "validated", evidence: "e" }, satisfies: ["C9"] })
  check("F3 satisfies pre-existing condition ok", r.ok === true, JSON.stringify(r))
  const c9 = db.query("SELECT * FROM conditions WHERE canonical_key='c9'").get() as any
  check("F3 pre-existing condition satisfied by idea id", c9.satisfied === 1 && c9.satisfied_by === r.idea?.id, JSON.stringify(c9))
}

// ---- 3c. unknown satisfies target fails atomically with zero partial writes ----
{
  const { db } = freshDb("unknown-satisfies")
  PM2.ensureV2Schema(db, PM.ftsAvailable(db))
  const before = {
    ideas: (db.query("SELECT COUNT(*) AS n FROM ideas").get() as { n: number }).n,
    conds: (db.query("SELECT COUNT(*) AS n FROM conditions").get() as { n: number }).n,
    rels: (db.query("SELECT COUNT(*) AS n FROM idea_relations").get() as { n: number }).n,
  }
  const r = PM2.ideaRecord(db, { idea: { key: "orphan idea", status: "validated", evidence: "e" }, conditions: [{ key: "kept condition" }], satisfies: ["never-declared"] })
  check("F3 unknown satisfies target denied", r.ok === false && /target condition not found/.test(r.error ?? ""), JSON.stringify(r))
  const after = {
    ideas: (db.query("SELECT COUNT(*) AS n FROM ideas").get() as { n: number }).n,
    conds: (db.query("SELECT COUNT(*) AS n FROM conditions").get() as { n: number }).n,
    rels: (db.query("SELECT COUNT(*) AS n FROM idea_relations").get() as { n: number }).n,
  }
  check("F3 atomic: no partial idea", after.ideas === before.ideas, JSON.stringify(after))
  check("F3 atomic: no partial condition", after.conds === before.conds, JSON.stringify(after))
  check("F3 atomic: no partial relation", after.rels === before.rels, JSON.stringify(after))
  check("F3 implicit placeholder disabled (no condition row)", (db.query("SELECT COUNT(*) AS n FROM conditions WHERE canonical_key='never-declared'").get() as { n: number }).n === 0)
}

// ---- 4a. plugin-level failure_save: subagent allowed; verifier/vision denied ----
{
  const dir = path.join(tmp, "pluginfail")
  fs.mkdirSync(path.join(dir, ".opencode"), { recursive: true })
  const hdb = PM.openMemory(path.join(dir, ".opencode", "memory.sqlite"))
  PM.ftsAvailable(hdb)
  hdb.close()
  const hooks: any = await (plugin as any).server({ directory: dir })

  const sub = JSON.parse(await hooks.tool.project_failure_save.execute({ symptom: "boom", cause: "c", lesson: "l" }, { sessionID: "s_sub", agent: "subagent", directory: dir }))
  check("F4 subagent failure_save ok", sub.ok === true && /^FAIL-\d{8}-[A-Z0-9]{8}$/.test(sub.id ?? ""), JSON.stringify(sub))

  const ver = JSON.parse(await hooks.tool.project_failure_save.execute({ symptom: "boom", cause: "c", lesson: "l" }, { sessionID: "s_ver", agent: "verifier", directory: dir }))
  check("F4 verifier failure_save denied", ver.ok === false, JSON.stringify(ver))

  const vis = JSON.parse(await hooks.tool.project_failure_save.execute({ symptom: "boom", cause: "c", lesson: "l" }, { sessionID: "s_vis", agent: "vision", directory: dir }))
  check("F4 vision failure_save denied", vis.ok === false, JSON.stringify(vis))

  const unrel = JSON.parse(await hooks.tool.project_failure_save.execute({ symptom: "boom", cause: "c", lesson: "l" }, { sessionID: "s_x", agent: "coworker", directory: dir }))
  check("F4 unrelated agent failure_save denied", unrel.ok === false, JSON.stringify(unrel))

  check("F4 failure_save did not create FAILURES.md", !fs.existsSync(path.join(dir, ".opencode", "FAILURES.md")))
  const checkdb = PM.openMemory(path.join(dir, ".opencode", "memory.sqlite"))
  check("F4 failure persisted in SQLite", (checkdb.query("SELECT COUNT(*) AS n FROM work_items WHERE canonical_key=?").get(PM.normalizeKey(sub.id)) as { n: number }).n === 1)
  checkdb.close()
}

// ---- 4b. SQLite-only write: an existing legacy FAILURES.md is left untouched ----
{
  const dir = path.join(tmp, "legacyfail")
  fs.mkdirSync(path.join(dir, ".opencode"), { recursive: true })
  const legacyPath = path.join(dir, ".opencode", "FAILURES.md")
  const legacyContent = "## FAIL-00000000-XXXX — historical entry\n- **Sintomo**: old\n- **Causa**: old\n- **Lezione**: old\n"
  fs.writeFileSync(legacyPath, legacyContent, "utf8")
  const hdb = PM.openMemory(path.join(dir, ".opencode", "memory.sqlite"))
  PM.ftsAvailable(hdb)
  hdb.close()
  const hooks: any = await (plugin as any).server({ directory: dir })
  const out = JSON.parse(await hooks.tool.project_failure_save.execute({ symptom: "new boom", cause: "c", lesson: "l2" }, { sessionID: "s_o", agent: "orchestrator", directory: dir }))
  check("F4 failure_save ok with legacy markdown present", out.ok === true, JSON.stringify(out))
  check("F4 legacy FAILURES.md byte-identical", fs.readFileSync(legacyPath, "utf8") === legacyContent, "file was modified")
  check("F4 new failure not appended to legacy FAILURES.md", !fs.readFileSync(legacyPath, "utf8").includes("new boom"), "appended to markdown")
}

// ---- 4c. saved failure is recoverable through normal project memory ----
{
  const { db, dir, fts } = freshDb("recoverfail")
  const f = PM.recordFailure(db, { symptom: "sy", cause: "ca", lesson: "le", topic: "recoverable topic" })
  const r1 = PM.preflight(db, { task: "recoverable topic", claim: false, ownerSession: "ses_X", projectDir: dir, fts })
  check("F4 failure recoverable via topic → COVERED", r1.status === "COVERED" && !!r1.ticket, JSON.stringify(r1))
  const r2 = PM.preflight(db, { task: f.id, claim: false, ownerSession: "ses_X", projectDir: dir, fts })
  check("F4 failure recoverable via FAIL-ID → COVERED same ticket", r2.status === "COVERED" && r2.ticket === r1.ticket, JSON.stringify(r2))
  check("F4 failure lesson surfaced in COVERED", r2.established.includes("le"), JSON.stringify(r2.established))
  check("F4 no FAILURES.md created", !fs.existsSync(path.join(dir, ".opencode", "FAILURES.md")))
}

// ---- 4d. historical DB remains compatible ----
{
  const dirM = fs.mkdtempSync(path.join(tmp, "hist"))
  const dbPathM = path.join(dirM, "memory.sqlite")
  const raw = new Database(dbPathM)
  raw.exec("CREATE TABLE work_items (id TEXT PRIMARY KEY, canonical_key TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('new','in_progress','done','blocked','covered')), summary TEXT DEFAULT '', unresolved TEXT DEFAULT '', notes TEXT DEFAULT '', owner_session TEXT, parent_key TEXT, source TEXT DEFAULT 'agent', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
  raw.exec("CREATE TABLE aliases (id INTEGER PRIMARY KEY AUTOINCREMENT, work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE, alias TEXT NOT NULL, UNIQUE(alias))")
  raw.exec("CREATE TABLE evidence (id INTEGER PRIMARY KEY AUTOINCREMENT, work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE, path TEXT NOT NULL, kind TEXT DEFAULT 'file', note TEXT DEFAULT '')")
  raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  const now = PM.nowIso()
  raw.run("INSERT INTO work_items (id, canonical_key, status, summary, unresolved, notes, owner_session, parent_key, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", ["h1", "legacy task", "in_progress", "legacy", "", "", "ses_legacy", null, "agent", now, now])
  raw.close()

  const db = PM.openMemory(dbPathM)
  const cols = (db.query("PRAGMA table_info(work_items)").all() as { name: string }[]).map((c) => c.name)
  check("F4 historical DB opens in place", cols.includes("reclaimed_at") && cols.includes("worker_session"), cols.join(","))
  const row = db.query("SELECT * FROM work_items WHERE id='h1'").get() as any
  check("F4 historical owned row preserved", row?.canonical_key === "legacy task" && row?.status === "in_progress" && row?.owner_session === "ses_legacy", JSON.stringify(row))
  const now2 = PM.nowIso()
  db.run("INSERT INTO work_items (id, canonical_key, status, summary, unresolved, notes, owner_session, parent_key, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", ["h2", "legacy ownerless", "new", "", "", "", null, null, "agent", now2, now2])
  const rec = save(db, "h2", "done", "ses_fresh", { summary: "finished legacy ownerless" })
  check("F4 historical ownerless row recordable", rec.ok === true, JSON.stringify(rec))
  const f = PM.recordFailure(db, { symptom: "s", cause: "c", lesson: "l" })
  check("F4 failure record works on migrated DB", /^FAIL-\d{8}-[A-Z0-9]{8}$/.test(f.id), f.id)
  db.close()
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)