// test-gate-loop.ts — delegation retry loop regression tests
// bindClaimToChild must KEEP parent ownership (record the child as worker_session)
// so the gate never blocks the orchestrator's subsequent task() calls. Also covers
// the loop-proof gate message, IN_PROGRESS next_action steering, reclaim-after-bind,
// and the worker_session schema migration (old 'failed'-schema DB without the column).
import * as PM from "../lib/project-memory-lib"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log("PASS", name) } else { fail++; console.log("FAIL", name, extra) }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-gate-loop-"))
function freshDb(tag: string): { db: PM.DB; dir: string; fts: boolean } {
  const dir = fs.mkdtempSync(path.join(tmp, tag))
  const db = PM.openMemory(path.join(dir, "memory.sqlite"))
  return { db, dir, fts: PM.ftsAvailable(db) }
}
const claim = (db: PM.DB, key: string, owner: string) => {
  const c = PM.claimWorkItem(db, { canonicalKey: key, ownerSession: owner, summary: key })
  return c.ok ? c.item.id : c.inProgress.id
}

// G1 — bindClaimToChild keeps parent ownership AND records the child as worker
{
  const { db, dir, fts } = freshDb("g1")
  const t = claim(db, "task g1", "ses_parent")
  PM.bindClaimToChild(db, "ses_parent", "ses_child")
  const row = db.query("SELECT * FROM work_items WHERE id=?").get(t) as any
  check("G1 parent keeps ownership", row.owner_session === "ses_parent", JSON.stringify(row))
  check("G1 child recorded as worker", row.worker_session === "ses_child", JSON.stringify(row))
  // duplicate-worker protection: a second task() on the SAME bound claim is blocked
  const g1 = PM.gateDecision(db, { sessionID: "ses_parent", args: { subagent_type: "subagent" } })
  check("G1 duplicate task blocked", g1.action === "block", JSON.stringify(g1))
  // but steering via task_id still allowed
  const g1s = PM.gateDecision(db, { sessionID: "ses_parent", args: { task_id: "ses_child" } })
  check("G1 steering still allowed", g1s.action === "allow", JSON.stringify(g1s))
}

// G2 — the loop scenario: after one claim+bind, the parent can claim a SECOND
// work item and the gate allows a second delegation (this was the original bug)
{
  const { db, dir, fts } = freshDb("g2")
  const t1 = claim(db, "task g2 alpha", "ses_parent")
  PM.bindClaimToChild(db, "ses_parent", "ses_child1")
  const g1 = PM.gateDecision(db, { sessionID: "ses_parent", args: { subagent_type: "subagent" } })
  check("G2 duplicate task blocked on bound claim", g1.action === "block", JSON.stringify(g1))
  // ensure strictly newer updated_at so the gate's ORDER BY updated_at DESC is deterministic
  await new Promise((r) => setTimeout(r, 10))
  const t2 = claim(db, "task g2 beta", "ses_parent")
  check("G2 second claim ok", !!t2 && t2 !== t1, JSON.stringify({ t1, t2 }))
  const g2 = PM.gateDecision(db, { sessionID: "ses_parent", args: { subagent_type: "subagent" } })
  check("G2 gate allows second delegation", g2.action === "allow" && g2.ticket === t2, JSON.stringify(g2))
  const row = db.query("SELECT * FROM work_items WHERE id=?").get(t1) as any
  check("G2 first claim still owned by parent", row.owner_session === "ses_parent", JSON.stringify(row))
}

// G3 — IN_PROGRESS preflight after bind → next_action STEER + worker_session exposed
{
  const { db, dir, fts } = freshDb("g3")
  const t = claim(db, "task g3", "ses_parent")
  PM.bindClaimToChild(db, "ses_parent", "ses_child")
  const r = PM.preflight(db, { task: "task g3", claim: true, ownerSession: "ses_parent", projectDir: dir, fts })
  check("G3 IN_PROGRESS same ticket", r.status === "IN_PROGRESS" && r.ticket === t, JSON.stringify(r))
  check("G3 next_action STEER", r.next_action === "STEER", JSON.stringify(r))
  check("G3 worker_session exposed", r.worker_session === "ses_child", JSON.stringify(r))
}

// G4 — IN_PROGRESS owned by ANOTHER session (no worker) → next_action WAIT
{
  const { db, dir, fts } = freshDb("g4")
  const t = claim(db, "task g4", "ses_other")
  const r = PM.preflight(db, { task: "task g4", claim: true, ownerSession: "ses_me", projectDir: dir, fts })
  check("G4 IN_PROGRESS", r.status === "IN_PROGRESS" && r.ticket === t, JSON.stringify(r))
  check("G4 next_action WAIT", r.next_action === "WAIT", JSON.stringify(r))
  check("G4 owner_session exposed", r.owner_session === "ses_other", JSON.stringify(r))
}

// G5 — IN_PROGRESS owned by the CURRENT session (no worker) → next_action DELEGATE
{
  const { db, dir, fts } = freshDb("g5")
  const t = claim(db, "task g5", "ses_me")
  const r = PM.preflight(db, { task: "task g5", claim: true, ownerSession: "ses_me", projectDir: dir, fts })
  check("G5 IN_PROGRESS", r.status === "IN_PROGRESS" && r.ticket === t, JSON.stringify(r))
  check("G5 next_action DELEGATE", r.next_action === "DELEGATE", JSON.stringify(r))
  check("G5 no worker_session", r.worker_session === undefined, JSON.stringify(r))
}

// G6 — gate block message distinguishes A) no valid work check vs B) work IN_PROGRESS
{
  const { db, dir, fts } = freshDb("g6")
  // A) no preflight at all → tells the model to run project_work_check, nothing about retrying task()
  const gA = PM.gateDecision(db, { sessionID: "ses_no_claim", args: { subagent_type: "subagent" } })
  check("G6a block action", gA.action === "block", JSON.stringify(gA))
  const reasonA = gA.reason ?? ""
  check("G6a says Run project_work_check", reasonA.includes("Run project_work_check"), reasonA)
  check("G6a does NOT mention retry task", !reasonA.includes("retry task"), reasonA)
  check("G6a does NOT mention IN_PROGRESS", !reasonA.includes("IN_PROGRESS"), reasonA)
  // B) last preflight returned IN_PROGRESS (e.g. claimed by another primary) →
  //    do NOT tell the model to repeat project_work_check, follow next_action instead
  const t6 = claim(db, "task g6", "ses_other")
  PM.preflight(db, { task: "task g6", claim: true, ownerSession: "ses_me", projectDir: dir, fts })
  const gB = PM.gateDecision(db, { sessionID: "ses_me", args: { subagent_type: "subagent" } })
  check("G6b block action", gB.action === "block", JSON.stringify(gB))
  const reasonB = gB.reason ?? ""
  check("G6b says already in progress", reasonB.includes("already in progress"), reasonB)
  check("G6b says Do not retry task", reasonB.includes("Do not retry task"), reasonB)
  check("G6b says Follow next_action", reasonB.includes("next_action"), reasonB)
  check("G6b does NOT repeat Run project_work_check", !reasonB.includes("Run project_work_check"), reasonB)
  check("G6b ticket preserved on claim", t6 !== undefined)
}

// G7 — reclaim still works after binding (target the parent, who kept the claim)
{
  const { db, dir, fts } = freshDb("g7")
  const t = claim(db, "task g7", "ses_parent")
  PM.bindClaimToChild(db, "ses_parent", "ses_child")
  const r = PM.preflight(db, { task: "task g7", claim: true, ownerSession: "ses_new", projectDir: dir, fts, reclaimTicket: t, reclaimOwner: "ses_parent" })
  check("G7 reclaim → NEW same ticket", r.status === "NEW" && r.ticket === t, JSON.stringify(r))
  check("G7 owner becomes new session", r.owner_session === "ses_new", JSON.stringify(r))
  const row = db.query("SELECT * FROM work_items WHERE id=?").get(t) as any
  check("G7 db owner new session", row.owner_session === "ses_new" && row.status === "in_progress", JSON.stringify(row))
  check("G7 count 1", (db.query("SELECT COUNT(*) AS n FROM work_items WHERE canonical_key='task g7'").get() as { n: number }).n === 1)
}

// G8 — schema migration: old 'failed'-schema DB (NO worker_session column) is
// upgraded in place by openMemory, legacy row preserved, bind works afterwards
{
  const dirM = fs.mkdtempSync(path.join(tmp, "g8"))
  const dbPathM = path.join(dirM, "memory.sqlite")
  const raw = new Database(dbPathM)
  raw.exec("CREATE TABLE work_items (id TEXT PRIMARY KEY, canonical_key TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('new','in_progress','done','blocked','covered','failed')), summary TEXT DEFAULT '', unresolved TEXT DEFAULT '', notes TEXT DEFAULT '', owner_session TEXT, parent_key TEXT, source TEXT DEFAULT 'agent', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reclaimed_at TEXT)")
  raw.exec("CREATE TABLE aliases (id INTEGER PRIMARY KEY AUTOINCREMENT, work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE, alias TEXT NOT NULL, UNIQUE(alias))")
  raw.exec("CREATE TABLE evidence (id INTEGER PRIMARY KEY AUTOINCREMENT, work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE, path TEXT NOT NULL, kind TEXT DEFAULT 'file', note TEXT DEFAULT '')")
  raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  raw.run("INSERT INTO meta (key, value) VALUES ('last_fts_sync', '0|')")
  const now = PM.nowIso()
  raw.run("INSERT INTO work_items (id, canonical_key, status, summary, unresolved, notes, owner_session, parent_key, source, created_at, updated_at, reclaimed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", ["g8m1", "legacy g8 task", "in_progress", "legacy summary", "", "", "ses_legacy", null, "agent", now, now, null])
  raw.run("INSERT INTO aliases (work_item_id, alias) VALUES (?,?)", ["g8m1", "g8legacyalias"])
  raw.run("INSERT INTO evidence (work_item_id, path, kind, note) VALUES (?,?,?,?)", ["g8m1", "g8_evidence.md", "file", ""])
  raw.close()

  const dbM = PM.openMemory(dbPathM)
  const cols = (dbM.query("PRAGMA table_info(work_items)").all() as any[]).map((c) => c.name)
  check("G8 worker_session column added", cols.includes("worker_session"), cols.join(","))
  const mig1 = dbM.query("SELECT * FROM work_items WHERE id='g8m1'").get() as any
  check("G8 legacy row preserved", mig1?.canonical_key === "legacy g8 task" && mig1?.status === "in_progress" && mig1?.owner_session === "ses_legacy", JSON.stringify(mig1))
  check("G8 worker_session null on legacy row", mig1?.worker_session === null, JSON.stringify(mig1))
  const aliasCount = (dbM.query("SELECT COUNT(*) AS n FROM aliases WHERE work_item_id='g8m1'").get() as { n: number }).n
  const evCount = (dbM.query("SELECT COUNT(*) AS n FROM evidence WHERE work_item_id='g8m1'").get() as { n: number }).n
  check("G8 alias+evidence preserved", aliasCount === 1 && evCount === 1, `${aliasCount}/${evCount}`)
  const metaRow = dbM.query("SELECT * FROM meta WHERE key='last_fts_sync'").get()
  check("G8 last_fts_sync cleared", !metaRow, JSON.stringify(metaRow))
  // the new column is fully functional: claim + bind write worker_session
  const t8 = claim(dbM, "g8 post-migrate", "ses_parent")
  PM.bindClaimToChild(dbM, "ses_parent", "ses_child")
  const row3 = dbM.query("SELECT * FROM work_items WHERE id=?").get(t8) as any
  check("G8 bind works after migration", row3?.worker_session === "ses_child" && row3?.owner_session === "ses_parent", JSON.stringify(row3))
  dbM.close()

  const dbM2 = PM.openMemory(dbPathM)
  const mig1b = dbM2.query("SELECT * FROM work_items WHERE id='g8m1'").get() as any
  check("G8 reopen preserved (idempotent)", mig1b?.canonical_key === "legacy g8 task" && mig1b?.status === "in_progress", JSON.stringify(mig1b))
  dbM2.close()
}

// G9 — next_action protocol on NEW / PARTIAL / COVERED
{
  const { db, dir, fts } = freshDb("g9")
  // NEW (claim created) → DELEGATE
  const rNew = PM.preflight(db, { task: "task g9a", claim: true, ownerSession: "ses_me", projectDir: dir, fts })
  check("G9 NEW status", rNew.status === "NEW", JSON.stringify(rNew))
  check("G9 NEW next_action DELEGATE", rNew.next_action === "DELEGATE", JSON.stringify(rNew))
  // COVERED → USE_EXISTING
  PM.recordResult(db, { ticket: rNew.ticket!, status: "done", summary: "task g9a done" })
  const rCovered = PM.preflight(db, { task: "task g9a", claim: true, ownerSession: "ses_me", projectDir: dir, fts })
  check("G9 COVERED status", rCovered.status === "COVERED", JSON.stringify(rCovered))
  check("G9 COVERED next_action USE_EXISTING", rCovered.next_action === "USE_EXISTING", JSON.stringify(rCovered))
  // PARTIAL (parent exists) → DELEGATE_DELTA
  const p = claim(db, "task g9b", "ses_parent")
  PM.recordResult(db, { ticket: p, status: "blocked", summary: "task g9b partial", unresolved: "remaining part" })
  const rPartial = PM.preflight(db, { task: "task g9b remaining part", claim: true, ownerSession: "ses_me", projectDir: dir, fts })
  check("G9 PARTIAL status", rPartial.status === "PARTIAL", JSON.stringify(rPartial))
  check("G9 PARTIAL next_action DELEGATE_DELTA", rPartial.next_action === "DELEGATE_DELTA", JSON.stringify(rPartial))
  // IN_PROGRESS with a bound worker → STEER (owner sees own worker)
  const t = claim(db, "task g9c", "ses_owner")
  PM.bindClaimToChild(db, "ses_owner", "ses_child")
  const rSteer = PM.preflight(db, { task: "task g9c", claim: true, ownerSession: "ses_owner", projectDir: dir, fts })
  check("G9 IN_PROGRESS next_action STEER", rSteer.next_action === "STEER", JSON.stringify(rSteer))
}

// G10 — steering via task_id is allowed even with no claim; missing metadata is safe
{
  const { db, dir, fts } = freshDb("g10")
  const g = PM.gateDecision(db, { sessionID: "ses_no_claim", args: { task_id: "ses_child" } })
  check("G10 task_id steering allowed", g.action === "allow" && g.reason === "steering", JSON.stringify(g))
  const gNoArgs = PM.gateDecision(db, { sessionID: "ses_no_claim", args: {} })
  check("G10 empty args blocks safely", gNoArgs.action === "block", JSON.stringify(gNoArgs))
}

// G11 — duplicate worker protection: IN_PROGRESS from another primary keeps a
// single claim and never silently spawns a second worker
{
  const { db, dir, fts } = freshDb("g11")
  const t1 = claim(db, "task g11", "ses_primary_a")
  PM.bindClaimToChild(db, "ses_primary_a", "ses_worker_a")
  // another primary preflights the SAME work with claim=true
  const r = PM.preflight(db, { task: "task g11", claim: true, ownerSession: "ses_primary_b", projectDir: dir, fts })
  check("G11 IN_PROGRESS same ticket", r.status === "IN_PROGRESS" && r.ticket === t1, JSON.stringify(r))
  const n = (db.query("SELECT COUNT(*) AS n FROM work_items WHERE canonical_key='task g11' AND status='in_progress'").get() as { n: number }).n
  check("G11 single claim kept (no duplicate)", n === 1, `count=${n}`)
  // its gate does NOT allow task() — no duplicate worker possible
  const g = PM.gateDecision(db, { sessionID: "ses_primary_b", args: { subagent_type: "subagent" } })
  check("G11 gate blocks second primary", g.action === "block", JSON.stringify(g))
}

// G12 — intra-session duplicate worker: a second task() on a claim that already
// has a bound worker is BLOCKED by the gate (not just at preflight). This pins
// the live-smoke FAIL (step 6).
{
  const { db, dir, fts } = freshDb("g12")
  const t = claim(db, "task g12", "ses_owner")
  // first delegation: claim has no worker yet → allowed
  const g1 = PM.gateDecision(db, { sessionID: "ses_owner", args: { subagent_type: "subagent" } })
  check("G12 first delegation allowed", g1.action === "allow" && g1.ticket === t, JSON.stringify(g1))
  // child spawns → worker bound to the claim
  PM.bindClaimToChild(db, "ses_owner", "ses_worker_a")
  // second delegation (duplicate, same work, same owner) → BLOCKED
  const g2 = PM.gateDecision(db, { sessionID: "ses_owner", args: { subagent_type: "subagent" } })
  check("G12 duplicate delegation blocked", g2.action === "block", JSON.stringify(g2))
  check("G12 block message steers", (g2.reason ?? "").includes("steer the existing worker"), g2.reason ?? "")
  // steering that existing worker via task_id still allowed
  const g3 = PM.gateDecision(db, { sessionID: "ses_owner", args: { task_id: "ses_worker_a" } })
  check("G12 steering allowed", g3.action === "allow", JSON.stringify(g3))
  // single claim kept, worker NOT re-bound to a duplicate
  const row = db.query("SELECT * FROM work_items WHERE id=?").get(t) as any
  check("G12 worker still worker_a", row.worker_session === "ses_worker_a", JSON.stringify(row))
  check("G12 one in_progress claim", (db.query("SELECT COUNT(*) AS n FROM work_items WHERE canonical_key='task g12' AND status='in_progress'").get() as { n: number }).n === 1)
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)