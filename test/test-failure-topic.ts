// test-failure-topic.ts — regression: failure topic is related searchable
// context, never SAME WORK identity.
// A failure saved with topic="vox30 port 1990" must not be inserted into the
// aliases identity table: a later project_work_check matching only that topic
// must NOT return COVERED (which would wrongly claim the done failure is the
// SAME work). The topic must stay retrievable as related PARTIAL context.
// Explicit real aliases keep SAME WORK behavior. Failure FAIL-ID retrieval and
// historical DB compatibility are unchanged.
import * as PM from "../lib/project-memory-lib"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-failure-topic-"))

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log("PASS", name) } else { fail++; console.log("FAIL", name, extra) }
}

function freshDb(tag: string, withFts: boolean) {
  const dir = path.join(tmp, tag)
  fs.mkdirSync(dir, { recursive: true })
  const db = PM.openMemory(path.join(dir, "memory.sqlite"))
  const fts = withFts ? PM.ftsAvailable(db) : false
  return { db, dir, fts }
}

const TOPIC = "vox30 port 1990"

// ---- 1. save failure with topic; topic must NOT become an identity alias ----
const { db, dir, fts } = freshDb("topic-fts", true)
const f = PM.recordFailure(db, { symptom: "connection refused", cause: "unknown", lesson: "do not rescan vox30:1990", topic: TOPIC })
check("T1 failure saved", /^FAIL-\d{8}-[A-Z0-9]{8}$/.test(f.id), f.id)
const failRow = db.query("SELECT * FROM work_items WHERE canonical_key=?").get(PM.normalizeKey(f.id)) as PM.WorkItem
const failUid = failRow.id
check("T1 topic NOT in aliases identity table", (db.query("SELECT COUNT(*) AS n FROM aliases WHERE alias=?").get(PM.normalizeKey(TOPIC)) as { n: number }).n === 0, "topic stored as alias")
check("T1 topic present as notes searchable context", failRow.notes.includes("topic: " + PM.normalizeKey(TOPIC)), "topic not in notes")

// ---- 2. work_check matching only the topic must NOT return COVERED ----
const r2 = PM.preflight(db, { task: TOPIC, claim: false, ownerSession: "ses_T", projectDir: dir, fts })
check("T2 topic work_check NOT COVERED", r2.status !== "COVERED", JSON.stringify(r2))

// ---- 3. the failure stays retrievable as related PARTIAL context ----
check("T3 topic retrievable as related PARTIAL", r2.status === "PARTIAL" && r2.candidates.some((c) => c.ticket === failUid), JSON.stringify(r2))
check("T3 lesson surfaced in related context", r2.established.some((e) => e.includes("do not rescan vox30")), JSON.stringify(r2.established))
// claiming the topic work claims a NEW ticket, never the failure's done item
const r3 = PM.preflight(db, { task: TOPIC, claim: true, ownerSession: "ses_T", projectDir: dir, fts })
check("T3 claim on topic → PARTIAL new ticket", r3.status === "PARTIAL" && !!r3.ticket && r3.ticket !== failUid, JSON.stringify(r3))
check("T3 failure item untouched", failRow.status === "done" && failRow.owner_session === "system", JSON.stringify(failRow))

// ---- 3b. LIKE fallback (no FTS): topic still retrievable as related context ----
const { db: dbN, dir: dirN, fts: ftsN } = freshDb("topic-nof", false)
const fn = PM.recordFailure(dbN, { symptom: "s", cause: "c", lesson: "no vox30 port rescan", topic: TOPIC })
const fnRow = dbN.query("SELECT * FROM work_items WHERE canonical_key=?").get(PM.normalizeKey(fn.id)) as PM.WorkItem
const rN = PM.preflight(dbN, { task: TOPIC, claim: false, ownerSession: "ses_T", projectDir: dirN, fts: ftsN })
check("T3b no-FTS topic NOT COVERED", rN.status !== "COVERED", JSON.stringify(rN))
check("T3b no-FTS topic retrievable as related PARTIAL", rN.status === "PARTIAL" && rN.candidates.some((c) => c.ticket === fnRow.id), JSON.stringify(rN))

// ---- 4. explicit real aliases still produce SAME WORK behavior ----
const c4 = PM.claimWorkItem(db, { canonicalKey: "explicit real work", ownerSession: "ses_A" })
const e4 = c4.ok ? c4.item : c4.inProgress
db.run("INSERT INTO aliases (work_item_id, alias) VALUES (?,?)", [e4.id, "ew-alias"])
const r4a = PM.preflight(db, { task: "ew-alias", claim: false, ownerSession: "ses_B", projectDir: dir, fts })
check("T4 explicit alias → SAME WORK (IN_PROGRESS)", r4a.status === "IN_PROGRESS" && r4a.ticket === e4.id, JSON.stringify(r4a))
PM.recordResult(db, { ticket: e4.id, status: "done", summary: "explicit work done", ownerSession: "ses_A" })
PM.syncAllFts(db, fts)
const r4b = PM.preflight(db, { task: "ew-alias", claim: false, ownerSession: "ses_C", projectDir: dir, fts })
check("T4 explicit alias → SAME WORK (COVERED)", r4b.status === "COVERED" && r4b.ticket === e4.id, JSON.stringify(r4b))

// ---- 5. existing failure retrieval (FAIL-ID) stays functional ----
const r5 = PM.preflight(db, { task: f.id, claim: false, ownerSession: "ses_T", projectDir: dir, fts })
check("T5 FAIL-ID → COVERED same ticket", r5.status === "COVERED" && r5.ticket === failUid, JSON.stringify(r5))
check("T5 lesson surfaced in COVERED", r5.established.includes("do not rescan vox30:1990"), JSON.stringify(r5.established))
check("T5 do_not_repeat references failure", r5.do_not_repeat.some((d) => d.includes(failUid)), JSON.stringify(r5.do_not_repeat))

// ---- 7. historical DB compatibility unchanged (open + migrate + explicit aliases) ----
{
  const dirH = path.join(tmp, "hist")
  fs.mkdirSync(dirH, { recursive: true })
  const rawPath = path.join(dirH, "memory.sqlite")
  const raw = new Database(rawPath)
  raw.exec("CREATE TABLE work_items (id TEXT PRIMARY KEY, canonical_key TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('new','in_progress','done','blocked','covered')), summary TEXT DEFAULT '', unresolved TEXT DEFAULT '', notes TEXT DEFAULT '', owner_session TEXT, parent_key TEXT, source TEXT DEFAULT 'agent', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
  raw.exec("CREATE TABLE aliases (id INTEGER PRIMARY KEY AUTOINCREMENT, work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE, alias TEXT NOT NULL, UNIQUE(alias))")
  raw.exec("CREATE TABLE evidence (id INTEGER PRIMARY KEY AUTOINCREMENT, work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE, path TEXT NOT NULL, kind TEXT DEFAULT 'file', note TEXT DEFAULT '')")
  raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  const now = PM.nowIso()
  raw.run("INSERT INTO work_items (id, canonical_key, status, summary, unresolved, notes, owner_session, parent_key, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", ["hist1", "legacy item", "in_progress", "legacy", "", "", "ses_legacy", null, "agent", now, now])
  raw.run("INSERT INTO aliases (work_item_id, alias) VALUES (?,?)", ["hist1", "legacy-alias"])
  raw.close()
  const dbH = PM.openMemory(rawPath)
  const cols = (dbH.query("PRAGMA table_info(work_items)").all() as { name: string }[]).map((c) => c.name)
  check("T7 historical DB opens with migrated columns", cols.includes("reclaimed_at") && cols.includes("worker_session"), cols.join(","))
  const histRow = dbH.query("SELECT * FROM work_items WHERE id='hist1'").get() as PM.WorkItem
  check("T7 historical row preserved", histRow.canonical_key === "legacy item" && histRow.owner_session === "ses_legacy", JSON.stringify(histRow))
  const rH = PM.preflight(dbH, { task: "legacy-alias", claim: false, ownerSession: "ses_X", projectDir: dirH, fts: false })
  check("T7 historical explicit alias still SAME WORK", rH.status === "IN_PROGRESS" && rH.ticket === "hist1", JSON.stringify(rH))
  const fH = PM.recordFailure(dbH, { symptom: "s", cause: "c", lesson: "l" })
  check("T7 failure record works on migrated DB", /^FAIL-\d{8}-[A-Z0-9]{8}$/.test(fH.id), fH.id)
  dbH.close()
}

db.close()
dbN.close()

console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)