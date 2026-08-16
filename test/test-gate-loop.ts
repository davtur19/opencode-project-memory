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
  check("G1 gate still allows the parent", PM.gateDecision(db, { sessionID: "ses_parent", args: { subagent_type: "subagent" } }).action === "allow")
}

// G2 — the loop scenario: after one claim+bind, the parent can claim a SECOND
// work item and the gate allows a second delegation (this was the original bug)
{
  const { db, dir, fts } = freshDb("g2")
  const t1 = claim(db, "task g2 alpha", "ses_parent")
  PM.bindClaimToChild(db, "ses_parent", "ses_child1")
  const g1 = PM.gateDecision(db, { sessionID: "ses_parent", args: { subagent_type: "subagent" } })
  check("G2 gate allows first delegation", g1.action === "allow" && g1.ticket === t1, JSON.stringify(g1))
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

// G6 — gate block message is loop-proof
{
  const { db, dir, fts } = freshDb("g6")
  const g = PM.gateDecision(db, { sessionID: "ses_no_claim", args: { subagent_type: "subagent" } })
  check("G6 block action", g.action === "block", JSON.stringify(g))
  const reason = g.reason ?? ""
  check("G6 mentions project_work_check", reason.includes("project_work_check"), reason)
  check("G6 mentions IN_PROGRESS", reason.includes("IN_PROGRESS"), reason)
  check("G6 mentions do NOT retry task", reason.includes("do NOT retry task"), reason)
  check("G6 mentions task_id", reason.includes("task_id"), reason)
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

console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)