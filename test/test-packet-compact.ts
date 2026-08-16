// test-packet-compact.ts — regression: project_work_check output verbosity +
// established/unresolved semantics. Guarded invariants:
//   1. A very long work request must NOT emit the full normalized text repeatedly.
//   2. requested/canonical/matched information is not duplicated for the same item.
//   3. A genuinely different matched item is identified by ticket + bounded ref.
//   4. Candidate references are bounded.
//   5. do_not_repeat does not reproduce huge task keys.
//   6. Current unresolved work is never inserted into established.
//   7. Persisted prior facts still appear in established.
//   8. Exact matching unchanged.  9. Alias matching unchanged.  10. FTS unchanged.
//  11. PARTIAL/COVERED/NEW/IN_PROGRESS unchanged.  12. Claim/bind unchanged.
//  13. Reclaim CAS unchanged.  14. Historical DB opens without destructive migration.
//  15. Packet bytes + occurrence counts (measured, asserted smaller than the
//      pre-fix packet reconstructed from the same fixture).
import * as PM from "../lib/project-memory-lib"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log("PASS", name) } else { fail++; console.log("FAIL", name, extra) }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-packet-"))
function freshDb(tag: string): { db: PM.DB; dir: string; fts: boolean } {
  const dir = fs.mkdtempSync(path.join(tmp, tag))
  const db = PM.openMemory(path.join(dir, "memory.sqlite"))
  return { db, dir, fts: PM.ftsAvailable(db) }
}
const claim = (db: PM.DB, key: string, owner: string) => {
  const c = PM.claimWorkItem(db, { canonicalKey: key, ownerSession: owner, summary: key })
  return c.ok ? c.item.id : c.inProgress.id
}

const LONG_KEY = "vox30 smtpc email rce static sink analysis fun 000369a4 setter email 0x35df8 live retest payload refinement"
const REQ = "VOX30 smtpc email RCE: disassemble sink FUN_000369a4 + email setter persistence + live write discriminator"
const REQ_NORM = PM.normalizeKey(REQ)
const SUMMARY_BLOCKED = "VOX30 smtpc email RCE static sink analysis — delegation aborted/orphaned (service restarts), no worker result recorded. Delta unchanged: disassemble setup.cgi FUN_000369a4 (smtpc sink) + email setter 0x35df8/0x82770; determine format position of email, system() stdout/stderr destination, background/foreground, setter persistence; live: verify email persists on write (discriminator setter-broken vs execution)."

// C1 — very long request: the full normalized description is never emitted
// repeatedly; the raw request appears exactly once (unresolved).
{
  const { db, dir, fts } = freshDb("c1")
  const r = PM.preflight(db, { task: REQ, claim: true, ownerSession: "ses_A", projectDir: dir, fts })
  check("C1 NEW status + ticket", r.status === "NEW" && !!r.ticket, JSON.stringify(r))
  const p = JSON.stringify(r, null, 2)
  const normOcc = p.split(REQ_NORM).length - 1
  const rawOcc = p.split(REQ).length - 1
  check("C1 normalized long text not echoed", normOcc === 0, `normOcc=${normOcc}`)
  check("C1 raw request appears exactly once", rawOcc === 1, `rawOcc=${rawOcc}`)
  check("C1 no requested_key/canonical_key/matched_key fields", !p.includes("requested_key") && !p.includes("canonical_key") && !p.includes("matched_key"), p.slice(0, 160))
}

// C2 — same-item provenance is not duplicated (exact COVERED: no key fields, no matched).
{
  const { db, dir, fts } = freshDb("c2")
  const t = claim(db, "task covered item", "ses_A")
  PM.recordResult(db, { ticket: t, status: "done", summary: "task covered item resolved", ownerSession: "ses_A" })
  const r = PM.preflight(db, { task: "task covered item", claim: true, ownerSession: "ses_B", projectDir: dir, fts })
  check("C2 COVERED same ticket", r.status === "COVERED" && r.ticket === t, JSON.stringify(r))
  const p = JSON.stringify(r, null, 2)
  check("C2 no requested_key/canonical_key/matched_key fields", !p.includes("requested_key") && !p.includes("canonical_key") && !p.includes("matched_key"), p.slice(0, 160))
  check("C2 no matched for identical item", r.matched === undefined, p.slice(0, 160))
}

// C3 — a genuinely different matched item is identified by ticket + bounded ref (alias).
{
  const { db, dir, fts } = freshDb("c3")
  const t = claim(db, "widget Y", "ses_A")
  const row = db.query("SELECT * FROM work_items WHERE id=?").get(t) as any
  db.run("INSERT INTO aliases (work_item_id, alias) VALUES (?,?)", [row.id, "wy"])
  const r = PM.preflight(db, { task: "wy", claim: false, ownerSession: "ses_A", projectDir: dir, fts })
  check("C3 alias → IN_PROGRESS same ticket", r.status === "IN_PROGRESS" && r.ticket === t, JSON.stringify(r))
  check("C3 matched present with ticket", r.matched?.ticket === t, JSON.stringify(r.matched))
  check("C3 matched ref bounded", !!r.matched?.ref && r.matched.ref.length <= 40 + 7 && r.matched.ref !== "wy", JSON.stringify(r.matched))
}

// C4/C5/C7/C10/C15 — PARTIAL via a long blocked candidate (the real observed case):
// candidate refs + do_not_repeat bounded, established = persisted facts only,
// FTS-driven PARTIAL still works, packet measured and asserted smaller.
{
  const { db, dir, fts } = freshDb("c4")
  const tP = claim(db, LONG_KEY, "ses_A")
  PM.recordResult(db, { ticket: tP, status: "blocked", summary: SUMMARY_BLOCKED, ownerSession: "ses_A" })
  const r = PM.preflight(db, { task: REQ, claim: true, ownerSession: "ses_B", projectDir: dir, fts })
  check("C4 PARTIAL via FTS candidate (unchanged)", r.status === "PARTIAL" && !!r.ticket && r.ticket !== tP, JSON.stringify(r))
  check("C4 candidates present", Array.isArray(r.candidates) && r.candidates.length === 1, JSON.stringify(r.candidates))
  check("C4 candidate ref bounded", (r.candidates[0]?.ref?.length ?? 0) <= 40 + 7, JSON.stringify(r.candidates[0]))
  check("C4 candidate ref identifies the parent ticket", r.candidates[0]?.ticket === tP, JSON.stringify(r.candidates[0]))
  check("C5 do_not_repeat bounded + no full key", (r.do_not_repeat ?? []).every((d) => d.length <= 90 && !d.includes(LONG_KEY)), JSON.stringify(r.do_not_repeat))
  const est = r.established ?? []
  check("C7 established keeps persisted fact (summary)", est.length === 1 && est[0].includes("delegation aborted/orphaned"), JSON.stringify(est))
  check("C7 established does not embed the long canonical key", !est.some((e) => e.includes(LONG_KEY)), JSON.stringify(est))
  check("C7 established does not contain the request itself", !est.some((e) => e.includes(REQ_NORM)), JSON.stringify(est))
  const p = JSON.stringify(r, null, 2)
  const longOcc = p.split(LONG_KEY).length - 1
  check("C1b long candidate key not emitted in packet", longOcc === 0, `longOcc=${longOcc}`)
  // pre-fix packet reconstructed from the same fixture for the byte comparison
  const legacy = {
    status: "PARTIAL", ticket: r.ticket, canonical_key: REQ_NORM,
    established: [LONG_KEY + ": " + SUMMARY_BLOCKED],
    do_not_repeat: [`Covered by ${LONG_KEY} (${tP})`],
    unresolved: [REQ],
    evidence: [], read_first: r.read_first, scratch: r.scratch,
    candidates: [{ key: LONG_KEY, status: "blocked", id: tP }],
  }
  const legacyBytes = Buffer.byteLength(JSON.stringify(legacy, null, 2))
  const newBytes = Buffer.byteLength(p)
  console.log(`  C15 PARTIAL packet bytes before=${legacyBytes} after=${newBytes}`)
  check("C15 PARTIAL packet smaller than pre-fix shape", newBytes < legacyBytes, `${newBytes} vs ${legacyBytes}`)
}

// C6 — reclaim: current unresolved work must not become established; the long
// task text appears exactly once (in unresolved).
{
  const { db, dir, fts } = freshDb("c6")
  const c = PM.claimWorkItem(db, { canonicalKey: REQ, ownerSession: "ses_A", summary: REQ, unresolved: REQ })
  const t = c.ok ? c.item.id : c.inProgress.id
  const r = PM.preflight(db, { task: REQ, claim: true, ownerSession: "ses_B", projectDir: dir, fts, reclaimTicket: t, reclaimOwner: "ses_A" })
  check("C6 reclaim → NEW same ticket", r.status === "NEW" && r.ticket === t && r.owner_session === "ses_B", JSON.stringify(r))
  check("C6 established empty (current work not established)", Array.isArray(r.established) && r.established.length === 0, JSON.stringify(r.established))
  check("C6 unresolved has exactly the remaining work", Array.isArray(r.unresolved) && r.unresolved.length === 1, JSON.stringify(r.unresolved))
  const p = JSON.stringify(r, null, 2)
  const rawOcc = p.split(REQ).length - 1
  const normOcc = p.split(REQ_NORM).length - 1
  check("C6 raw request appears exactly once", rawOcc === 1, `rawOcc=${rawOcc}`)
  check("C6 normalized request not echoed", normOcc === 0, `normOcc=${normOcc}`)
}

// C8 — exact matching unchanged.
{
  const { db, dir, fts } = freshDb("c8")
  const t = claim(db, "widget alpha", "ses_A")
  const r = PM.preflight(db, { task: "widget alpha", claim: true, ownerSession: "ses_B", projectDir: dir, fts })
  check("C8 exact in_progress → IN_PROGRESS same ticket", r.status === "IN_PROGRESS" && r.ticket === t, JSON.stringify(r))
}

// C11 — statuses unchanged (COVERED / NEW / IN_PROGRESS exercised above and here).
{
  const { db, dir, fts } = freshDb("c11")
  const r1 = PM.preflight(db, { task: "fresh status task", claim: true, ownerSession: "ses_A", projectDir: dir, fts })
  check("C11 NEW", r1.status === "NEW" && !!r1.ticket, JSON.stringify(r1))
  const r2 = PM.preflight(db, { task: "fresh status task", claim: true, ownerSession: "ses_A", projectDir: dir, fts })
  check("C11 IN_PROGRESS same session", r2.status === "IN_PROGRESS" && r2.ticket === r1.ticket, JSON.stringify(r2))
  PM.recordResult(db, { ticket: r1.ticket!, status: "done", summary: "done", ownerSession: "ses_A" })
  const r3 = PM.preflight(db, { task: "fresh status task", claim: true, ownerSession: "ses_B", projectDir: dir, fts })
  check("C11 COVERED after record", r3.status === "COVERED" && r3.ticket === r1.ticket, JSON.stringify(r3))
}

// C12 — no scheduler remnants in the preflight output: no worker_session field,
// no next_action field, no gate, no bind. Claim ownership stays a plain record.
{
  const { db, dir, fts } = freshDb("c12")
  const t = claim(db, "task g12b", "ses_parent")
  const r = PM.preflight(db, { task: "task g12b", claim: true, ownerSession: "ses_parent", projectDir: dir, fts })
  check("C12 IN_PROGRESS same ticket", r.status === "IN_PROGRESS" && r.ticket === t && r.owner_session === "ses_parent", JSON.stringify(r))
  const p = JSON.stringify(r)
  check("C12 no next_action field", !p.includes("next_action"), p.slice(0, 160))
  check("C12 no worker_session field", !p.includes("worker_session"), p.slice(0, 160))
  check("C12 no gate exports", (PM as any).gateDecision === undefined && (PM as any).gateSafe === undefined)
  check("C12 no bind export", (PM as any).bindClaimToChild === undefined)
}

// C13 — reclaim CAS unchanged: reclaim relies on explicit ticket + observed-owner
// CAS. The request text is not gated (caller passes the right ticket); a wrong
// observed owner is denied by the CAS.
{
  const { db, dir, fts } = freshDb("c13")
  const t = claim(db, "disable VOX25 DHCP", "ses_A")
  const good = PM.preflight(db, { task: "disable VOX25 DHCP", claim: true, ownerSession: "ses_B", projectDir: dir, fts, reclaimTicket: t, reclaimOwner: "ses_A" })
  check("C13 correct reclaim → NEW same ticket", good.status === "NEW" && good.ticket === t && good.owner_session === "ses_B", JSON.stringify(good))
  const stale = PM.preflight(db, { task: "disable VOX25 DHCP", claim: true, ownerSession: "ses_C", projectDir: dir, fts, reclaimTicket: t, reclaimOwner: "ses_A" })
  check("C13 stale-owner CAS denied", !!(stale as any).reclaim_error, JSON.stringify(stale))
  const row = db.query("SELECT * FROM work_items WHERE id=?").get(t) as any
  check("C13 row still owned by ses_B", row.owner_session === "ses_B", JSON.stringify(row))
  check("C13 single row", (db.query("SELECT COUNT(*) AS n FROM work_items WHERE canonical_key='disable vox25 dhcp'").get() as any).n === 1)
}

// C14 — historical (pre-failed/pre-worker_session) DB opens and works in place.
{
  const dirM = fs.mkdtempSync(path.join(tmp, "c14"))
  const dbPathM = path.join(dirM, "memory.sqlite")
  const raw = new Database(dbPathM)
  raw.exec("CREATE TABLE work_items (id TEXT PRIMARY KEY, canonical_key TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('new','in_progress','done','blocked','covered')), summary TEXT DEFAULT '', unresolved TEXT DEFAULT '', notes TEXT DEFAULT '', owner_session TEXT, parent_key TEXT, source TEXT DEFAULT 'agent', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
  raw.exec("CREATE TABLE aliases (id INTEGER PRIMARY KEY AUTOINCREMENT, work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE, alias TEXT NOT NULL, UNIQUE(alias))")
  raw.exec("CREATE TABLE evidence (id INTEGER PRIMARY KEY AUTOINCREMENT, work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE, path TEXT NOT NULL, kind TEXT DEFAULT 'file', note TEXT DEFAULT '')")
  raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  const now = PM.nowIso()
  raw.run("INSERT INTO work_items (id, canonical_key, status, summary, unresolved, notes, owner_session, parent_key, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", ["mig1", "legacy task", "in_progress", "legacy summary", "", "", "ses_legacy", null, "agent", now, now])
  raw.close()
  const dbM = PM.openMemory(dbPathM)
  const cols = (dbM.query("PRAGMA table_info(work_items)").all() as any[]).map((c) => c.name)
  check("C14 columns added in place", cols.includes("reclaimed_at") && cols.includes("worker_session"), cols.join(","))
  const mig1 = dbM.query("SELECT * FROM work_items WHERE id='mig1'").get() as any
  check("C14 legacy row preserved", mig1?.canonical_key === "legacy task" && mig1?.status === "in_progress" && mig1?.owner_session === "ses_legacy", JSON.stringify(mig1))
  const r = PM.preflight(dbM, { task: "legacy task", claim: false, ownerSession: "ses_x", projectDir: dirM, fts: PM.ftsAvailable(dbM) })
  check("C14 preflight works on migrated DB", r.status === "IN_PROGRESS" && r.ticket === "mig1", JSON.stringify(r))
  dbM.close()
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)