// test-reclaim.ts — explicit reclaim (reclaim_ticket + reclaim_owner CAS) + 'failed' status semantics + schema migration
import * as PM from "../lib/project-memory-lib"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log("PASS", name) } else { fail++; console.log("FAIL", name, extra) }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-reclaim-"))
function freshDb(tag: string): { db: PM.DB; dir: string; fts: boolean } {
  const dir = fs.mkdtempSync(path.join(tmp, tag))
  const db = PM.openMemory(path.join(dir, "memory.sqlite"))
  return { db, dir, fts: PM.ftsAvailable(db) }
}
const claim = (db: PM.DB, key: string, owner: string) => {
  const c = PM.claimWorkItem(db, { canonicalKey: key, ownerSession: owner, summary: key })
  return c.ok ? c.item.id : c.inProgress.id
}
const count = (db: PM.DB, key: string) => (db.query("SELECT COUNT(*) AS n FROM work_items WHERE canonical_key=?").get(PM.normalizeKey(key)) as { n: number }).n

// R1 — healthy in_progress claim is protected (no auto-reclaim)
{
  const { db, dir, fts } = freshDb("r1")
  const tA = claim(db, "disable VOX25 DHCP", "ses_A")
  const r = PM.preflight(db, { task: "disable VOX25 DHCP", claim: true, ownerSession: "ses_B", projectDir: dir, fts })
  check("R1 healthy claim protected", r.status === "IN_PROGRESS" && r.ticket === tA && r.owner_session === "ses_A", JSON.stringify(r))
  check("R1 count 1", count(db, "disable VOX25 DHCP") === 1)
}

// R2 — explicit reclaim hands the ticket over
{
  const { db, dir, fts } = freshDb("r2")
  const tA = claim(db, "disable VOX25 DHCP", "ses_A")
  const r = PM.preflight(db, { task: "disable VOX25 DHCP", claim: true, ownerSession: "ses_B", projectDir: dir, fts, reclaimTicket: tA, reclaimOwner: "ses_A" })
  check("R2 reclaim → NEW same ticket", r.status === "NEW" && r.ticket === tA, JSON.stringify(r))
  check("R2 owner ses_B", r.owner_session === "ses_B", JSON.stringify(r))
  const row = db.query("SELECT * FROM work_items WHERE id=?").get(tA) as any
  check("R2 db owner ses_B in_progress", row.owner_session === "ses_B" && row.status === "in_progress", JSON.stringify(row))
  check("R2 count 1", count(db, "disable VOX25 DHCP") === 1)
  const rec = (r as any).reclaimed
  check("R2 reclaimed meta", rec?.previous_owner === "ses_A" && !!rec?.reclaimed_at, JSON.stringify(rec))
}

// R3 — concurrent reclaim attempts (single process): exactly one wins
{
  const { db, dir, fts } = freshDb("r3")
  const tA = claim(db, "disable VOX25 DHCP", "ses_A")
  const results = await Promise.all(Array.from({ length: 8 }, async (_, i) => PM.preflight(db, { task: "disable VOX25 DHCP", claim: true, ownerSession: "ses_race_" + i, projectDir: dir, fts, reclaimTicket: tA, reclaimOwner: "ses_A" })))
  const winners = results.filter((r) => r.status === "NEW" && r.ticket === tA)
  check("R3 exactly one winner", winners.length === 1, JSON.stringify(results.map((r) => ({ s: r.status, t: r.ticket, o: r.owner_session }))))
  check("R3 count 1", count(db, "disable VOX25 DHCP") === 1)
  const row = db.query("SELECT * FROM work_items WHERE id=?").get(tA) as any
  check("R3 row in_progress", row.status === "in_progress", JSON.stringify(row))
}

// R4 — reclaim relies on explicit ticket + observed-owner CAS, NOT token overlap.
// With the correct ticket and owner the reclaim succeeds even when the request
// text differs (the caller is responsible for passing the right ticket from the
// IN_PROGRESS preflight result). A WRONG observed owner is denied by the CAS.
{
  const { db, dir, fts } = freshDb("r4")
  const tA = claim(db, "disable VOX25 DHCP", "ses_A")
  const r = PM.preflight(db, { task: "compile a rust program for the embedded target", claim: true, ownerSession: "ses_B", projectDir: dir, fts, reclaimTicket: tA, reclaimOwner: "ses_A" })
  check("R4 different task text still reclaims (ticket+CAS)", r.status === "NEW" && r.ticket === tA && r.owner_session === "ses_B", JSON.stringify(r))
  const row = db.query("SELECT * FROM work_items WHERE id=?").get(tA) as any
  check("R4 row reclaimed to ses_B", row.owner_session === "ses_B" && row.status === "in_progress", JSON.stringify(row))
  // wrong owner → CAS denies
  const rBad = PM.preflight(db, { task: "disable VOX25 DHCP", claim: true, ownerSession: "ses_C", projectDir: dir, fts, reclaimTicket: tA, reclaimOwner: "ses_phantom" })
  check("R4 wrong owner CAS denied", !!(rBad as any).reclaim_error, JSON.stringify(rBad))
  const row2 = db.query("SELECT * FROM work_items WHERE id=?").get(tA) as any
  check("R4 row still ses_B after denied CAS", row2.owner_session === "ses_B", JSON.stringify(row2))
}

// R5 — reclaim of non-in_progress tickets (done/blocked/failed/covered) is denied
{
  const { db, dir, fts } = freshDb("r5")
  const tDone = claim(db, "task done item", "ses_A")
  const tBlocked = claim(db, "task blocked item", "ses_B")
  const tFailed = claim(db, "task failed item", "ses_C")
  PM.recordResult(db, { ticket: tDone, status: "done", summary: "done", ownerSession: "ses_A" })
  PM.recordResult(db, { ticket: tBlocked, status: "blocked", summary: "blocked", ownerSession: "ses_B" })
  PM.recordResult(db, { ticket: tFailed, status: "failed", summary: "failed", ownerSession: "ses_C" })
  for (const [t, label] of [[tDone, "done"], [tBlocked, "blocked"]] as [string, string][]) {
    const r = PM.preflight(db, { task: "task " + label + " item", claim: true, ownerSession: "ses_reclaim", projectDir: dir, fts, reclaimTicket: t, reclaimOwner: t === tDone ? "ses_A" : "ses_B" })
    check("R5 " + label + " reclaim_error", !!(r as any).reclaim_error, JSON.stringify(r))
    const row = db.query("SELECT * FROM work_items WHERE id=?").get(t) as any
    check("R5 " + label + " status unchanged", row.status === label, JSON.stringify(row))
  }
  // 'failed' is deliberately claimable (R7 retry semantics): the reclaim itself is
  // denied (reclaim_error) but the preflight fallthrough re-claims it as PARTIAL on
  // the same ticket, so the row goes in_progress with the "prior failed attempt" note.
  {
    const r = PM.preflight(db, { task: "task failed item", claim: true, ownerSession: "ses_reclaim", projectDir: dir, fts, reclaimTicket: tFailed, reclaimOwner: "ses_C" })
    check("R5 failed reclaim_error", !!(r as any).reclaim_error, JSON.stringify(r))
    check("R5 failed retried as PARTIAL same ticket", r.status === "PARTIAL" && r.ticket === tFailed, JSON.stringify(r))
    const row = db.query("SELECT * FROM work_items WHERE id=?").get(tFailed) as any
    check("R5 failed retried row", row.status === "in_progress" && row.owner_session === "ses_reclaim" && (row.notes ?? "").includes("prior failed attempt"), JSON.stringify(row))
  }
  const now = PM.nowIso()
  db.run("INSERT INTO work_items (id, canonical_key, status, summary, unresolved, notes, owner_session, parent_key, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", ["cov1", "task covered item", "covered", "covered item", "", "", "ses_A", null, "agent", now, now])
  const rCov = PM.preflight(db, { task: "task covered item", claim: true, ownerSession: "ses_reclaim", projectDir: dir, fts, reclaimTicket: "cov1", reclaimOwner: "ses_A" })
  check("R5 covered reclaim_error", !!(rCov as any).reclaim_error, JSON.stringify(rCov))
  const covRow = db.query("SELECT * FROM work_items WHERE id='cov1'").get() as any
  check("R5 covered status unchanged", covRow.status === "covered", JSON.stringify(covRow))
}

// R6 — reclaim history recorded on the row
{
  const { db, dir, fts } = freshDb("r6")
  const tA = claim(db, "disable VOX25 DHCP", "ses_old")
  PM.preflight(db, { task: "disable VOX25 DHCP", claim: true, ownerSession: "ses_new", projectDir: dir, fts, reclaimTicket: tA, reclaimOwner: "ses_old" })
  const row = db.query("SELECT * FROM work_items WHERE id=?").get(tA) as any
  check("R6 notes include [reclaim]", (row.notes ?? "").includes("[reclaim]"), row.notes)
  check("R6 notes include both sessions", (row.notes ?? "").includes("ses_old") && (row.notes ?? "").includes("ses_new"), row.notes)
  check("R6 reclaimed_at set", !!row.reclaimed_at, row.reclaimed_at)
}

// R6b — SUCCESSIVE reclaims of repeated orphans (CAS on owner, not a latch)
{
  const { db, dir, fts } = freshDb("r6b")
  const tA = claim(db, "disable VOX25 DHCP", "ses_A")
  const rB = PM.preflight(db, { task: "disable VOX25 DHCP", claim: true, ownerSession: "ses_B", projectDir: dir, fts, reclaimTicket: tA, reclaimOwner: "ses_A" })
  check("R6b B reclaims from ses_A", rB.status === "NEW" && rB.ticket === tA && rB.owner_session === "ses_B", JSON.stringify(rB))
  const rC = PM.preflight(db, { task: "disable VOX25 DHCP", claim: true, ownerSession: "ses_C", projectDir: dir, fts, reclaimTicket: tA, reclaimOwner: "ses_B" })
  check("R6b C reclaims from ses_B", rC.status === "NEW" && rC.ticket === tA && rC.owner_session === "ses_C", JSON.stringify(rC))
  const rD = PM.preflight(db, { task: "disable VOX25 DHCP", claim: true, ownerSession: "ses_D", projectDir: dir, fts, reclaimTicket: tA, reclaimOwner: "ses_C" })
  check("R6b D reclaims from ses_C", rD.status === "NEW" && rD.ticket === tA && rD.owner_session === "ses_D", JSON.stringify(rD))
  check("R6b count 1", count(db, "disable VOX25 DHCP") === 1)
  const row = db.query("SELECT * FROM work_items WHERE id=?").get(tA) as any
  const notes = row.notes ?? ""
  check("R6b three reclaim notes", (notes.match(/\[reclaim\]/g) ?? []).length === 3, notes)
  check("R6b A→B", notes.includes("from ses_A to ses_B"), notes)
  check("R6b B→C", notes.includes("from ses_B to ses_C"), notes)
  check("R6b C→D", notes.includes("from ses_C to ses_D"), notes)
  check("R6b reclaimed_at truthy", !!row.reclaimed_at, row.reclaimed_at)
}

// R6c — successive reclaim under concurrency: after one reclaim, a fresh 8-way
// race on the SAME ticket (all observing the new owner) still has exactly one winner
{
  const { db, dir, fts } = freshDb("r6c")
  const tA = claim(db, "disable VOX25 DHCP", "ses_A")
  const rB = PM.preflight(db, { task: "disable VOX25 DHCP", claim: true, ownerSession: "ses_B", projectDir: dir, fts, reclaimTicket: tA, reclaimOwner: "ses_A" })
  check("R6c first reclaim ok", rB.status === "NEW" && rB.ticket === tA, JSON.stringify(rB))
  const results = await Promise.all(Array.from({ length: 8 }, async (_, i) => PM.preflight(db, { task: "disable VOX25 DHCP", claim: true, ownerSession: "ses_race_" + i, projectDir: dir, fts, reclaimTicket: tA, reclaimOwner: "ses_B" })))
  const winners = results.filter((r) => r.status === "NEW" && r.ticket === tA)
  check("R6c exactly one second-round winner", winners.length === 1, JSON.stringify(results.map((r) => ({ s: r.status, t: r.ticket, o: r.owner_session }))))
  check("R6c count 1", count(db, "disable VOX25 DHCP") === 1)
  const row = db.query("SELECT * FROM work_items WHERE id=?").get(tA) as any
  check("R6c row in_progress", row.status === "in_progress", JSON.stringify(row))
}

// R7 — 'failed' status: recordable, then re-claimable as NEW on the SAME ticket
{
  const { db, dir, fts } = freshDb("r7")
  const tA = claim(db, "investigate widget gamma", "ses_A")
  const rec = PM.recordResult(db, { ticket: tA, status: "failed", summary: "no access", ownerSession: "ses_A" })
  check("R7 record failed ok", rec.ok, JSON.stringify(rec))
  const row1 = db.query("SELECT * FROM work_items WHERE id=?").get(tA) as any
  check("R7 row status failed", row1.status === "failed", JSON.stringify(row1))
  const r = PM.preflight(db, { task: "investigate widget gamma", claim: true, ownerSession: "ses_new", projectDir: dir, fts })
  check("R7 failed → PARTIAL same ticket", r.status === "PARTIAL" && r.ticket === tA, JSON.stringify(r))
  const row2 = db.query("SELECT * FROM work_items WHERE id=?").get(tA) as any
  check("R7 in_progress new owner", row2.status === "in_progress" && row2.owner_session === "ses_new", JSON.stringify(row2))
  check("R7 notes prior failed attempt", (row2.notes ?? "").includes("prior failed attempt"), row2.notes)
}

// MIGRATION — old-schema DB (5-status CHECK, no reclaimed_at) upgraded in place
{
  const dirM = fs.mkdtempSync(path.join(tmp, "mig"))
  const dbPathM = path.join(dirM, "memory.sqlite")
  const raw = new Database(dbPathM)
  raw.exec("CREATE TABLE work_items (id TEXT PRIMARY KEY, canonical_key TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('new','in_progress','done','blocked','covered')), summary TEXT DEFAULT '', unresolved TEXT DEFAULT '', notes TEXT DEFAULT '', owner_session TEXT, parent_key TEXT, source TEXT DEFAULT 'agent', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
  raw.exec("CREATE TABLE aliases (id INTEGER PRIMARY KEY AUTOINCREMENT, work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE, alias TEXT NOT NULL, UNIQUE(alias))")
  raw.exec("CREATE TABLE evidence (id INTEGER PRIMARY KEY AUTOINCREMENT, work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE, path TEXT NOT NULL, kind TEXT DEFAULT 'file', note TEXT DEFAULT '')")
  raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  raw.run("INSERT INTO meta (key, value) VALUES ('last_fts_sync', '0|')")
  const now = PM.nowIso()
  raw.run("INSERT INTO work_items (id, canonical_key, status, summary, unresolved, notes, owner_session, parent_key, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", ["mig1", "legacy task", "in_progress", "legacy summary", "", "", "ses_legacy", null, "agent", now, now])
  raw.run("INSERT INTO aliases (work_item_id, alias) VALUES (?,?)", ["mig1", "legacyalias"])
  raw.run("INSERT INTO evidence (work_item_id, path, kind, note) VALUES (?,?,?,?)", ["mig1", "legacy_evidence.md", "file", ""])
  raw.close()

  const dbM = PM.openMemory(dbPathM)
  const mig1 = dbM.query("SELECT * FROM work_items WHERE id='mig1'").get() as any
  check("MIG mig1 preserved", mig1?.canonical_key === "legacy task" && mig1?.status === "in_progress" && mig1?.owner_session === "ses_legacy", JSON.stringify(mig1))
  const aliasCount = (dbM.query("SELECT COUNT(*) AS n FROM aliases WHERE work_item_id='mig1'").get() as { n: number }).n
  const evCount = (dbM.query("SELECT COUNT(*) AS n FROM evidence WHERE work_item_id='mig1'").get() as { n: number }).n
  check("MIG alias+evidence preserved", aliasCount === 1 && evCount === 1, `${aliasCount}/${evCount}`)
  const cols = (dbM.query("PRAGMA table_info(work_items)").all() as any[]).map((c) => c.name)
  check("MIG reclaimed_at column", cols.includes("reclaimed_at"), cols.join(","))
  const sql = (dbM.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='work_items'").get() as any)?.sql ?? ""
  check("MIG sql includes failed", sql.includes("'failed'"), sql)
  const metaRow = dbM.query("SELECT * FROM meta WHERE key='last_fts_sync'").get()
  check("MIG last_fts_sync gone", !metaRow, JSON.stringify(metaRow))
  dbM.close()

  const dbM2 = PM.openMemory(dbPathM)
  const mig1b = dbM2.query("SELECT * FROM work_items WHERE id='mig1'").get() as any
  check("MIG reopen preserved (idempotent)", mig1b?.canonical_key === "legacy task" && mig1b?.status === "in_progress", JSON.stringify(mig1b))
  const c2 = PM.claimWorkItem(dbM2, { canonicalKey: "fresh after migrate", ownerSession: "ses_fresh", summary: "fresh after migrate" })
  const rec2 = PM.recordResult(dbM2, { ticket: c2.ok ? c2.item.id : c2.inProgress.id, status: "failed", summary: "boom", ownerSession: "ses_fresh" })
  check("MIG failed allowed after migrate", rec2.ok, JSON.stringify(rec2))
  dbM2.close()
}

// PHASE 10 — realistic flow: primary claims, secondary primary reclaims
{
  const { db, dir, fts } = freshDb("p10")
  const t = claim(db, "disable VOX25 DHCP", "ses_primary")
  const r1 = PM.preflight(db, { task: "disable VOX25 DHCP", claim: true, ownerSession: "ses_primary", projectDir: dir, fts })
  check("P10 IN_PROGRESS same ticket", r1.status === "IN_PROGRESS" && r1.ticket === t, JSON.stringify(r1))
  const r2 = PM.preflight(db, { task: "disable VOX25 DHCP", claim: true, ownerSession: "ses_primary2", projectDir: dir, fts, reclaimTicket: t, reclaimOwner: "ses_primary" })
  check("P10 reclaim → NEW same ticket", r2.status === "NEW" && r2.ticket === t, JSON.stringify(r2))
  check("P10 owner ses_primary2", r2.owner_session === "ses_primary2", JSON.stringify(r2))
  check("P10 count 1", count(db, "disable VOX25 DHCP") === 1)
  const row = db.query("SELECT * FROM work_items WHERE id=?").get(t) as any
  check("P10 in_progress (not blocked)", row.status === "in_progress", JSON.stringify(row))
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)