// project-memory-lib.ts — Project Memory core (pure logic, no opencode plugin API; testable standalone with bun)
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as path from "node:path"
import * as crypto from "node:crypto"

// ---------- authorization ----------
// project_failure_save is available to the configured primary agents and to
// `subagent` (which reports reusable failures to the orchestrator). verifier,
// vision and any unrelated agent remain denied.
export function canAppendFailure(agent: string, primaryAgents: string[]): boolean {
  return primaryAgents.includes(agent) || agent === "subagent"
}

// ---------- ULID (Crockford base32: 48-bit timestamp + 80-bit randomness) ----------
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
export function ulid(now: number = Date.now()): string {
  let s = ""
  let t = BigInt(now)
  for (let i = 0; i < 10; i++) { s = CROCKFORD[Number(t & 31n)] + s; t >>= 5n }
  let r = 0n
  for (const b of crypto.randomBytes(10)) r = (r << 8n) | BigInt(b)
  for (let i = 0; i < 16; i++) { s += CROCKFORD[Number(r & 31n)]; r >>= 5n }
  return s
}

export function nowIso(): string { return new Date().toISOString() }

// ---------- key normalization ----------
export function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

// ---------- compact reference (presentation-only, deterministic, bounded) ----------
// A lossy, human/LLM-readable projection of a normalized key for tool output.
// NEVER used for identity or matching: exact/alias/FTS matching keeps operating
// on the full stored canonical_key. When the normalized text fits the budget it
// is returned verbatim; otherwise it is truncated and a short stable hash of the
// FULL normalized text is appended, so distinct long keys remain distinguishable
// in output. No LLM/API call, no DB storage, no schema change.
const REF_BUDGET = 40
export function compactRef(s: string, budget: number = REF_BUDGET): string {
  const norm = normalizeKey(s).replace(/\s+/g, " ").trim()
  if (norm.length <= budget) return norm
  const hash = crypto.createHash("sha256").update(norm).digest("hex").slice(0, 6)
  return `${norm.slice(0, budget)}~${hash}`
}

// ---------- schema ----------
// facts and worker_session are legacy columns kept for compatibility with
// existing DBs. facts is never read (removed from the public work_save API) and
// worker_session is no longer written by runtime scheduling logic; both remain
// in the schema so existing databases open without a destructive migration.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('new','in_progress','done','blocked','covered','failed')),
  summary TEXT DEFAULT '',
  unresolved TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  owner_session TEXT,
  parent_key TEXT,
  source TEXT DEFAULT 'agent',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reclaimed_at TEXT,
  worker_session TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_key ON work_items(canonical_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_active ON work_items(canonical_key) WHERE status='in_progress';
CREATE INDEX IF NOT EXISTS idx_work_items_owner ON work_items(owner_session);
CREATE TABLE IF NOT EXISTS aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  UNIQUE(alias)
);
CREATE INDEX IF NOT EXISTS idx_aliases_alias ON aliases(alias);
CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  kind TEXT DEFAULT 'file',
  note TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_evidence_item ON evidence(work_item_id);
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  source TEXT DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export type DB = Database
export type WorkItem = {
  id: string; canonical_key: string; status: string; summary: string; unresolved: string;
  notes: string; owner_session: string | null; parent_key: string | null; source: string;
  created_at: string; updated_at: string; reclaimed_at: string | null; worker_session: string | null
}

export function openMemory(dbPath: string): Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.exec("PRAGMA busy_timeout=5000;")
  // bun:sqlite does not invoke the busy handler for the WAL-mode transition
  // (verified: returns SQLITE_BUSY in 0ms even with busy_timeout set), so retry
  // the pragma itself under concurrent first-open. Ordinary writes do honor
  // busy_timeout, so only this pragma needs the explicit retry.
  const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec("PRAGMA journal_mode=WAL;")
      break
    } catch (e: any) {
      if (e?.code !== "SQLITE_BUSY" || attempt >= 100) throw e
      sleepMs(50)
    }
  }
  db.exec("PRAGMA foreign_keys=ON;")
  db.exec(SCHEMA)
  migrateSchema(db)
  return db
}

// ---------- schema migration (adds 'failed' status + reclaimed_at column, then worker_session column) ----------
// Non-destructive and additive only: existing rows are preserved, and re-opening
// a historical DB never drops or rewrites work items.
export function migrateSchema(db: Database): void {
  db.exec("PRAGMA foreign_keys=OFF")
  try {
    db.transaction(() => {
      const sql2 = (db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='work_items'").get() as { sql: string } | undefined)?.sql ?? ""
      if (sql2.includes("'failed'")) return
      db.exec("CREATE TABLE work_items_new (id TEXT PRIMARY KEY, canonical_key TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('new','in_progress','done','blocked','covered','failed')), summary TEXT DEFAULT '', unresolved TEXT DEFAULT '', notes TEXT DEFAULT '', owner_session TEXT, parent_key TEXT, source TEXT DEFAULT 'agent', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reclaimed_at TEXT, worker_session TEXT)")
      db.run("INSERT INTO work_items_new (rowid, id, canonical_key, status, summary, unresolved, notes, owner_session, parent_key, source, created_at, updated_at, reclaimed_at, worker_session) SELECT rowid, id, canonical_key, status, summary, unresolved, notes, owner_session, parent_key, source, created_at, updated_at, NULL, NULL FROM work_items")
      db.exec("DROP TABLE work_items")
      db.exec("ALTER TABLE work_items_new RENAME TO work_items")
    })()
  } catch (e) {
    const sql3 = (db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='work_items'").get() as { sql: string } | undefined)?.sql ?? ""
    if (!sql3.includes("'failed'")) throw e
    // a concurrent migration won — swallow
  } finally {
    db.exec("PRAGMA foreign_keys=ON")
  }
  // worker_session column: added by this plugin version. Fresh DBs already have
  // it via SCHEMA; DBs migrated by an older plugin version (has 'failed' but no
  // worker_session) get the column added in place. Idempotent: re-running finds
  // the column present and does nothing. Kept only for DB compatibility — the
  // plugin no longer writes it.
  const cols = (db.query("PRAGMA table_info(work_items)").all() as { name: string }[]).map((c) => c.name)
  if (!cols.includes("worker_session")) {
    db.exec("ALTER TABLE work_items ADD COLUMN worker_session TEXT")
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_key ON work_items(canonical_key)")
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_active ON work_items(canonical_key) WHERE status='in_progress'")
  db.exec("CREATE INDEX IF NOT EXISTS idx_work_items_owner ON work_items(owner_session)")
  db.run("DELETE FROM meta WHERE key='last_fts_sync'")
}

// FTS5 is optional: if unavailable (embedded sqlite without FTS), retrieval falls back to LIKE.
export function ftsAvailable(db: Database): boolean {
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(canonical_key, summary, unresolved, notes, aliases, evidence_paths)")
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS markdown_fts USING fts5(path, title, body)")
    return true
  } catch {
    return false
  }
}

export function syncAllFts(db: Database, fts: boolean) {
  if (!fts) return
  db.exec("DELETE FROM memory_fts")
  const rows = db.query("SELECT rowid, id, canonical_key, summary, unresolved, notes FROM work_items").all() as any[]
  const aliasRows = db.query("SELECT work_item_id, group_concat(alias, ' ') AS a FROM aliases GROUP BY work_item_id").all() as any[]
  const evRows = db.query("SELECT work_item_id, group_concat(path, ' ') AS p FROM evidence GROUP BY work_item_id").all() as any[]
  const aliasMap = new Map(aliasRows.map((r) => [r.work_item_id, r.a]))
  const evMap = new Map(evRows.map((r) => [r.work_item_id, r.p]))
  const ins = db.prepare("INSERT INTO memory_fts(rowid, canonical_key, summary, unresolved, notes, aliases, evidence_paths) VALUES (?,?,?,?,?,?,?)")
  for (const r of rows) ins.run(r.rowid, r.canonical_key, r.summary, r.unresolved, r.notes, aliasMap.get(r.id) ?? "", evMap.get(r.id) ?? "")
}

// ---------- atomic claim ----------
export function claimWorkItem(db: Database, opts: { canonicalKey: string; summary?: string; unresolved?: string; notes?: string; ownerSession: string; parentKey?: string; source?: string }): { ok: true; item: WorkItem } | { ok: false; inProgress: WorkItem } {
  const id = ulid()
  const now = nowIso()
  const key = normalizeKey(opts.canonicalKey)
  try {
    db.run(
      `INSERT INTO work_items (id, canonical_key, status, summary, unresolved, notes, owner_session, parent_key, source, created_at, updated_at)
       VALUES (?, ?, 'in_progress', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(canonical_key) DO UPDATE SET
         status='in_progress', owner_session=excluded.owner_session, unresolved=excluded.unresolved,
         notes=excluded.notes, reclaimed_at=NULL, updated_at=excluded.updated_at
       WHERE NOT EXISTS (SELECT 1 FROM work_items w2 WHERE w2.canonical_key=excluded.canonical_key AND w2.status='in_progress' AND w2.id != excluded.id)`,
      [id, key, opts.summary ?? "", opts.unresolved ?? "", opts.notes ?? "", opts.ownerSession, opts.parentKey ?? null, opts.source ?? "agent", now, now],
    )
  } catch {
    const ip = db.query("SELECT * FROM work_items WHERE canonical_key=? AND status='in_progress'").get(key) as WorkItem | undefined
    if (ip) return { ok: false, inProgress: ip }
    // reopen race: retry once (0-row UPDATE is a silent no-op if another claimer won)
    try {
      db.run("UPDATE work_items SET status='in_progress', owner_session=?, unresolved=?, notes=?, reclaimed_at=NULL, updated_at=? WHERE canonical_key=? AND NOT EXISTS (SELECT 1 FROM work_items w2 WHERE w2.canonical_key=? AND w2.status='in_progress' AND w2.id != work_items.id)", [opts.ownerSession, opts.unresolved ?? "", opts.notes ?? "", now, key, key])
    } catch {
      const ip2 = db.query("SELECT * FROM work_items WHERE canonical_key=? AND status='in_progress'").get(key) as WorkItem | undefined
      if (ip2) return { ok: false, inProgress: ip2 }
      throw new Error("claim failed")
    }
  }
  const item = db.query("SELECT * FROM work_items WHERE canonical_key=?").get(key) as WorkItem
  if (item.status !== "in_progress" || item.owner_session !== opts.ownerSession) {
    const ip = db.query("SELECT * FROM work_items WHERE canonical_key=? AND status='in_progress'").get(key) as WorkItem | undefined
    if (ip) return { ok: false, inProgress: ip }
  }
  return { ok: true, item }
}

// ---------- scratch ----------
export function projectScratchBase(projectDir: string): string {
  const base = path.basename(projectDir)
  const h = crypto.createHash("sha1").update(projectDir).digest("hex").slice(0, 8)
  return path.join("/tmp", "opencode", `${base}-${h}`)
}
export function scratchPath(base: string, ticket: string): string { return path.join(base, ticket) }
export function ensureScratch(base: string, ticket: string): string {
  const p = scratchPath(base, ticket)
  fs.mkdirSync(p, { recursive: true })
  return p
}

// ---------- helpers ----------
function evidenceFor(db: Database, itemId: string): string[] {
  return (db.query("SELECT path FROM evidence WHERE work_item_id=?").all(itemId) as { path: string }[]).map((r) => r.path)
}
function ftsQuery(key: string): string {
  const toks = key.split(" ").filter(Boolean)
  if (toks.length === 0) return '""'
  return toks.map((t) => `"${t}"`).join(" OR ")
}

// Markdown retrieval feeds read_first ONLY (bounded). When FTS5 is unavailable
// this path safely returns no Markdown matches — it never falls back to LIKE on
// a table that may not exist.
function readFirstFor(db: Database, key: string, fts: boolean): string[] {
  if (!fts) return []
  try {
    return (db.query("SELECT path FROM markdown_fts WHERE markdown_fts MATCH ? ORDER BY rank LIMIT 6").all(ftsQuery(key)) as { path: string }[]).map((r) => r.path)
  } catch {
    return []
  }
}

export function maybeSyncFts(db: Database, fts: boolean) {
  if (!fts) return
  const st = db.query("SELECT COUNT(*) AS n, COALESCE(MAX(updated_at),'') AS m FROM work_items").get() as { n: number; m: string }
  const last = (db.query("SELECT value FROM meta WHERE key='last_fts_sync'").get() as { value: string } | undefined)?.value ?? ""
  const [lastN, lastM] = last.split("|")
  if (st.n !== Number(lastN) || st.m !== lastM) {
    syncAllFts(db, fts)
    db.run("INSERT INTO meta (key, value) VALUES ('last_fts_sync', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [`${st.n}|${st.m}`])
  }
}

// ---------- reclaim ----------
export type ReclaimResult =
  | { ok: true; item: WorkItem; previous_owner: string | null; reclaimed_at: string }
  | { ok: false; reason: string }

// Explicit reclaim of an orphaned/abandoned IN_PROGRESS claim.
// The atomic UPDATE is a compare-and-swap on the OBSERVED owner: the caller
// passes the owner_session it saw in the IN_PROGRESS preflight result, and the
// guarded UPDATE (WHERE owner_session=?) succeeds only while the claim is still
// held by that owner. Concurrent reclaimers that observed the same owner
// serialize on the SQLite write lock and exactly one wins (1/N); the losers
// match 0 rows and report the stale owner. Because the CAS is on the owner (not
// on reclaimed_at), SUCCESSIVE reclaims of repeated orphans are allowed: orphan
// → reclaim → new orphan → reclaim again works. reclaimed_at is pure audit
// (timestamp of the last reclaim), never a gate.
// Reclaim relies on the explicit ticket + observed-owner CAS only — the request
// text is NOT gated against the stored ticket (the caller is responsible for
// passing the correct ticket from the IN_PROGRESS preflight result).
export function reclaimWorkItem(db: Database, opts: { ticket: string; ownerSession: string; previousOwner: string }): ReclaimResult {
  const item = db.query("SELECT * FROM work_items WHERE id=?").get(opts.ticket) as WorkItem | undefined
  if (!item) return { ok: false, reason: `ticket not found: ${opts.ticket}` }
  if (item.status !== "in_progress") return { ok: false, reason: `ticket ${opts.ticket} is not in_progress (status=${item.status})` }
  const now = nowIso()
  const historyNote = `[reclaim] ${now} from ${item.owner_session ?? "none"} to ${opts.ownerSession}`
  const notes = [item.notes, historyNote].filter(Boolean).join("\n")
  const res = db.run(
    "UPDATE work_items SET owner_session=?, notes=?, reclaimed_at=?, updated_at=?, worker_session=NULL WHERE id=? AND status='in_progress' AND owner_session=?",
    [opts.ownerSession, notes, now, now, opts.ticket, opts.previousOwner],
  )
  if (res.changes === 0) {
    const cur = db.query("SELECT * FROM work_items WHERE id=?").get(opts.ticket) as WorkItem | undefined
    if (!cur) return { ok: false, reason: `ticket not found: ${opts.ticket}` }
    if (cur.status !== "in_progress") return { ok: false, reason: `ticket ${opts.ticket} is not in_progress (status=${cur.status})` }
    return { ok: false, reason: `reclaim lost: current owner of ${opts.ticket} is ${cur.owner_session ?? "none"} (expected ${opts.previousOwner}); re-preflight to observe the current owner and retry` }
  }
  return { ok: true, item: db.query("SELECT * FROM work_items WHERE id=?").get(opts.ticket) as WorkItem, previous_owner: opts.previousOwner, reclaimed_at: now }
}

// ---------- preflight ----------
export type PreflightStatus = "COVERED" | "PARTIAL" | "NEW" | "IN_PROGRESS"
export type CandidateRef = { ticket: string; ref: string; status: string }
export type PreflightResult = {
  status: PreflightStatus
  ticket?: string
  match_reason?: string
  // Provenance when the matched stored item's canonical text differs from the
  // normalized request: its ticket + a bounded reference. Omitted when the
  // matched item IS the requested work (ticket already identifies it).
  matched?: { ticket: string; ref: string }
  established: string[]
  do_not_repeat: string[]
  unresolved: string[]
  evidence: string[]
  read_first: string[]
  scratch?: string
  owner_session?: string
  reclaimed?: { previous_owner: string | null; reclaimed_at: string }
  reclaim_error?: string
  candidates: CandidateRef[]
}

// Provenance helper: only a matched item whose canonical text differs from the
// request adds information (the caller already knows what they asked for).
function matchedOf(item: WorkItem, key: string): { ticket: string; ref: string } | undefined {
  if (item.canonical_key === key) return undefined
  return { ticket: item.id, ref: compactRef(item.canonical_key) }
}

export function preflight(db: Database, opts: { task: string; claim: boolean; ownerSession: string; projectDir: string; fts: boolean; reclaimTicket?: string; reclaimOwner?: string }): PreflightResult {
  let res: PreflightResult
  if (opts.reclaimTicket) {
    if (!opts.reclaimOwner) {
      res = preflightCore(db, { task: opts.task, claim: opts.claim, ownerSession: opts.ownerSession, projectDir: opts.projectDir, fts: opts.fts })
      res = { ...res, reclaim_error: "reclaim_owner is required: pass the owner_session observed in the IN_PROGRESS preflight result" }
    } else {
      const r = reclaimWorkItem(db, { ticket: opts.reclaimTicket, ownerSession: opts.ownerSession, previousOwner: opts.reclaimOwner })
      if (r.ok) {
        const key = normalizeKey(opts.task)
        const readFirst = readFirstFor(db, key, opts.fts)
        const sc = ensureScratch(projectScratchBase(opts.projectDir), r.item.id)
        // Reclaim = the SAME unresolved work continues under a new owner; nothing
        // about it is newly established. The stored unresolved text (or, if empty,
        // the caller's request) is the remaining work — never an established fact.
        res = { status: "NEW", ticket: r.item.id, match_reason: "reclaimed", established: [], do_not_repeat: [], unresolved: r.item.unresolved ? [r.item.unresolved] : [opts.task], evidence: evidenceFor(db, r.item.id).slice(0, 10), read_first: readFirst, scratch: sc, owner_session: opts.ownerSession, candidates: [], reclaimed: { previous_owner: r.previous_owner, reclaimed_at: r.reclaimed_at } }
      } else {
        res = preflightCore(db, { task: opts.task, claim: opts.claim, ownerSession: opts.ownerSession, projectDir: opts.projectDir, fts: opts.fts })
        res = { ...res, reclaim_error: r.reason }
      }
    }
  } else {
    res = preflightCore(db, { task: opts.task, claim: opts.claim, ownerSession: opts.ownerSession, projectDir: opts.projectDir, fts: opts.fts })
  }
  return res
}

export function preflightCore(db: Database, opts: { task: string; claim: boolean; ownerSession: string; projectDir: string; fts: boolean }): PreflightResult {
  const key = normalizeKey(opts.task)
  maybeSyncFts(db, opts.fts)
  const fts = opts.fts
  let matchSrc: "exact" | "alias" | "fail-id" | null = null
  let item = db.query("SELECT * FROM work_items WHERE canonical_key=?").get(key) as WorkItem | undefined
  if (item) matchSrc = "exact"
  if (!item) {
    item = db.query("SELECT w.* FROM aliases a JOIN work_items w ON w.id=a.work_item_id WHERE a.alias=? OR a.alias=?").get(key, opts.task.trim().toLowerCase()) as WorkItem | undefined
    if (item) matchSrc = "alias"
  }
  if (!item) {
    const idMatch = opts.task.match(/FAIL-\d+/i)
    if (idMatch) {
      item = db.query("SELECT * FROM work_items WHERE canonical_key=?").get(normalizeKey(idMatch[0])) as WorkItem | undefined
      if (item) matchSrc = "fail-id"
    }
  }
  // FTS candidates are RELATED CONTEXT ONLY. A loose FTS match never identifies
  // the request: it cannot turn another active (in_progress) item into
  // IN_PROGRESS and never claims on behalf of an active item. Only completed
  // (done/covered/blocked) candidates feed PARTIAL context.
  let candidates: (WorkItem & { fts_rank?: number })[] = []
  if (fts) {
    candidates = db.query("SELECT w.*, f.rank AS fts_rank FROM memory_fts f JOIN work_items w ON w.rowid=f.rowid WHERE memory_fts MATCH ? ORDER BY rank LIMIT 6").all(ftsQuery(key)) as (WorkItem & { fts_rank?: number })[]
  } else {
    const like = `%${key}%`
    candidates = db.query("SELECT * FROM work_items WHERE canonical_key LIKE ? OR summary LIKE ? OR unresolved LIKE ? LIMIT 6").all(like, like, like) as (WorkItem & { fts_rank?: number })[]
  }
  const readFirst = readFirstFor(db, key, fts)
  const scratchBase = projectScratchBase(opts.projectDir)
  const cap = (a: string[], n: number) => a.slice(0, n)

  if (item) {
    if (item.status === "in_progress") {
      return { status: "IN_PROGRESS", ticket: item.id, match_reason: matchSrc ?? "exact", matched: matchedOf(item, key), established: [], do_not_repeat: [], unresolved: item.unresolved ? [item.unresolved] : [], evidence: cap(evidenceFor(db, item.id), 10), read_first: readFirst, candidates: [], owner_session: item.owner_session ?? undefined }
    }
    if (item.status === "done" || item.status === "covered" || item.status === "blocked") {
      const unresolved = item.unresolved ? [item.unresolved] : []
      if (item.status === "blocked") unresolved.unshift(`BLOCKED: ${item.summary}`)
      return { status: "COVERED", ticket: item.id, match_reason: matchSrc ?? "exact", matched: matchedOf(item, key), established: [item.summary].filter(Boolean), do_not_repeat: [`Covered by ${compactRef(item.canonical_key)} (${item.id})`], unresolved, evidence: cap(evidenceFor(db, item.id), 10), read_first: readFirst, candidates: [] }
    }
    // status 'new' / 'failed' → claimable. A failed retry keeps PARTIAL semantics:
    // the prior failure context (summary/notes), a do_not_repeat, the prior evidence
    // and the still-open unresolved work are all returned on the SAME ticket — it is
    // never presented as fresh work with empty context.
    if (opts.claim) {
      const priorNote = item.status === "failed" ? "prior failed attempt: " + [item.summary, item.notes].filter(Boolean).join(" | ") : ""
      const c = claimWorkItem(db, { canonicalKey: key, summary: opts.task, unresolved: opts.task, notes: priorNote, ownerSession: opts.ownerSession, source: "agent" })
      if (c.ok) {
        const sc = ensureScratch(scratchBase, c.item.id)
        if (item.status === "failed") {
          const prior = [item.summary, item.notes].filter(Boolean).join(" | ")
          return { status: "PARTIAL", ticket: c.item.id, match_reason: "prior-failure", established: (prior ? [`prior failed attempt: ${prior}`] : []), do_not_repeat: [`Prior attempt failed (${compactRef(item.canonical_key)})${item.summary ? ": " + item.summary : ""}`.slice(0, 120)], unresolved: item.unresolved ? [item.unresolved] : [opts.task], evidence: cap(evidenceFor(db, c.item.id), 10), read_first: readFirst, scratch: sc, candidates: [] }
        }
        return { status: "NEW", ticket: c.item.id, match_reason: "created", established: [], do_not_repeat: [], unresolved: [opts.task], evidence: [], read_first: readFirst, scratch: sc, candidates: [] }
      }
      return { status: "IN_PROGRESS", ticket: c.inProgress.id, match_reason: "claim-conflict", established: [], do_not_repeat: [], unresolved: [], evidence: cap(evidenceFor(db, c.inProgress.id), 10), read_first: readFirst, candidates: [], owner_session: c.inProgress.owner_session ?? undefined }
    }
    if (item.status === "failed") {
      const prior = [item.summary, item.notes].filter(Boolean).join(" | ")
      return { status: "PARTIAL", match_reason: "prior-failure", established: (prior ? [`prior failed attempt: ${prior}`] : []), do_not_repeat: [`Prior attempt failed (${compactRef(item.canonical_key)})${item.summary ? ": " + item.summary : ""}`.slice(0, 120)], unresolved: item.unresolved ? [item.unresolved] : [opts.task], evidence: cap(evidenceFor(db, item.id), 10), read_first: readFirst, candidates: [] }
    }
    return { status: "NEW", match_reason: "none", established: [], do_not_repeat: [], unresolved: [opts.task], evidence: [], read_first: readFirst, candidates: [] }
  }

  // No exact/alias/fail-id match. Completed FTS candidates supply PARTIAL
  // context: previously persisted facts only (summaries), never the requested
  // work. In_progress candidates are ignored entirely.
  const doneCandidates = candidates.filter((c) => c.status === "done" || c.status === "covered" || c.status === "blocked")
  if (doneCandidates.length > 0) {
    // established = previously persisted facts only: the recorded summaries of
    // done/covered/blocked items. The requested/unresolved work must never become
    // established merely because it FTS-matches a stored item; a stored summary
    // IS independently persisted evidence, so legitimate facts are kept as-is.
    const established = doneCandidates.map((c) => c.summary || compactRef(c.canonical_key))
    const dnr = doneCandidates.map((c) => `Covered by ${compactRef(c.canonical_key)} (${c.id})`)
    const ev = cap(doneCandidates.flatMap((c) => evidenceFor(db, c.id)), 10)
    const cand = doneCandidates.map((c) => ({ ticket: c.id, ref: compactRef(c.canonical_key), status: c.status }))
    if (opts.claim) {
      const c = claimWorkItem(db, { canonicalKey: key, summary: opts.task, unresolved: opts.task, notes: `delta of ${doneCandidates[0].canonical_key}`, ownerSession: opts.ownerSession, parentKey: doneCandidates[0].canonical_key, source: "agent" })
      if (c.ok) { const sc = ensureScratch(scratchBase, c.item.id); return { status: "PARTIAL", ticket: c.item.id, match_reason: "parent", established, do_not_repeat: dnr, unresolved: [opts.task], evidence: ev, read_first: readFirst, scratch: sc, candidates: cand } }
      return { status: "IN_PROGRESS", ticket: c.inProgress.id, match_reason: "claim-conflict", established, do_not_repeat: dnr, unresolved: [], evidence: ev, read_first: readFirst, candidates: cand, owner_session: c.inProgress.owner_session ?? undefined }
    }
    return { status: "PARTIAL", match_reason: "none", established, do_not_repeat: dnr, unresolved: [opts.task], evidence: ev, read_first: readFirst, candidates: cand }
  }

  // NEW
  if (opts.claim) {
    const c = claimWorkItem(db, { canonicalKey: key, summary: opts.task, unresolved: opts.task, ownerSession: opts.ownerSession, source: "agent" })
    if (c.ok) { const sc = ensureScratch(scratchBase, c.item.id); return { status: "NEW", ticket: c.item.id, match_reason: "created", established: [], do_not_repeat: [], unresolved: [opts.task], evidence: [], read_first: readFirst, scratch: sc, candidates: [] } }
    return { status: "IN_PROGRESS", ticket: c.inProgress.id, match_reason: "claim-conflict", established: [], do_not_repeat: [], unresolved: [], evidence: cap(evidenceFor(db, c.inProgress.id), 10), read_first: readFirst, candidates: [], owner_session: c.inProgress.owner_session ?? undefined }
  }
  return { status: "NEW", match_reason: "none", established: [], do_not_repeat: [], unresolved: [opts.task], evidence: [], read_first: readFirst, candidates: [] }
}
// ---------- record ----------
// facts is deliberately not part of this API: it was written but never
// retrieved. The legacy facts table remains in the schema for compatibility.
// Ownership: a ticket may only be recorded by the session that owns it — even
// after it reached a terminal/claimable status (done/blocked/failed/covered/new).
// This prevents a stale pre-reclaim owner from overwriting the result recorded
// by the new owner after a reclaim. Rule: owner_session set + caller != owner
// => reject; matching owner => allow; legacy rows with no owner remain writable
// by any caller (compatibility). Reclaim CAS is untouched: after a successful
// reclaim via project_work_check reclaim_ticket/reclaim_owner the new owner
// matches the row and may record.
export function recordResult(db: Database, opts: { ticket: string; status: string; summary?: string; unresolved?: string; evidence?: string[]; ownerSession?: string }): { ok: true; item: WorkItem } | { ok: false; reason: string } {
  const item = db.query("SELECT * FROM work_items WHERE id=?").get(opts.ticket) as WorkItem | undefined
  if (!item) return { ok: false, reason: `ticket not found: ${opts.ticket}` }
  if (item.owner_session && item.owner_session !== opts.ownerSession) {
    return { ok: false, reason: `ticket ${opts.ticket} is owned by ${item.owner_session} (status=${item.status}); session ${opts.ownerSession ?? "unknown"} cannot record it (reclaim via project_work_check with reclaim_ticket=${opts.ticket} and reclaim_owner=${item.owner_session})` }
  }
  const now = nowIso()
  const status = ["done", "blocked", "failed"].includes(opts.status) ? opts.status : "done"
  db.run("UPDATE work_items SET status=?, summary=COALESCE(?, summary), unresolved=COALESCE(?, unresolved), updated_at=? WHERE id=?", [status, opts.summary ?? null, opts.unresolved ?? null, now, opts.ticket])
  for (const p of opts.evidence ?? []) {
    const exists = db.query("SELECT 1 FROM evidence WHERE work_item_id=? AND path=?").get(opts.ticket, p)
    if (!exists) db.run("INSERT INTO evidence (work_item_id, path, kind, note) VALUES (?,?,?,?)", [opts.ticket, p, "file", ""])
  }
  return { ok: true, item: db.query("SELECT * FROM work_items WHERE id=?").get(opts.ticket) as WorkItem }
}

// ---------- failure record (SQLite-only; serialized writer, collision-safe id) ----------
// SQLite is the canonical operational memory: failures are persisted as done
// work items keyed by a FAIL-YYYYMMDD-<id> identifier. No FAILURES.md dual-write
// is performed — historical Markdown files are never created or modified here
// (bootstrap() may still index an existing one for read_first as legacy
// documentation only). No fake file evidence is created for a file that is no
// longer written; the topic alias stays for retrieval.
export function recordFailure(db: Database, opts: { symptom: string; cause: string; lesson: string; topic?: string }): { id: string } {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`
  const id = `FAIL-${ymd}-${ulid().slice(-8)}`
  const key = normalizeKey(id)
  const c = claimWorkItem(db, { canonicalKey: key, summary: opts.lesson, unresolved: "", notes: `symptom: ${opts.symptom}; cause: ${opts.cause}`, ownerSession: "system", source: "agent" })
  const item = c.ok ? c.item : c.inProgress
  db.run("UPDATE work_items SET status='done', summary=?, notes=?, updated_at=? WHERE id=?", [opts.lesson, `symptom: ${opts.symptom}; cause: ${opts.cause}`, nowIso(), item.id])
  if (opts.topic) {
    db.run("INSERT INTO aliases (work_item_id, alias) VALUES (?,?) ON CONFLICT(alias) DO NOTHING", [item.id, normalizeKey(opts.topic)])
  }
  return { id }
}

// ---------- bootstrap (Markdown index for read_first ONLY) ----------
// No automatic legacy Markdown → work_item import. Previously imported rows
// (source='bootstrap:%') are never deleted or rewritten; existing DBs keep
// their historical work items untouched. Markdown files are indexed into
// markdown_fts solely to support the bounded read_first retrieval in preflight.
// When FTS5 is unavailable this path safely does nothing (read_first returns []).
export function bootstrap(db: Database, projectDir: string, fts: boolean): { imported: number; sources: string[] } {
  if (!fts) return { imported: 0, sources: [] }
  const dir = path.join(projectDir, ".opencode")
  const sources: string[] = []
  db.transaction(() => {
    db.exec("DELETE FROM markdown_fts")
    const mdFiles: string[] = []
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) if (f.endsWith(".md")) mdFiles.push(path.join(dir, f))
    }
    const projFailures = path.join(projectDir, "FAILURES.md")
    if (fs.existsSync(projFailures)) mdFiles.push(projFailures)
    const insMd = db.prepare("INSERT INTO markdown_fts (path, title, body) VALUES (?,?,?)")
    for (const f of mdFiles) {
      try {
        const body = fs.readFileSync(f, "utf8")
        const title = (body.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(f)).slice(0, 200)
        insMd.run(f, title, body)
        sources.push(f)
      } catch {}
    }
  })()
  syncAllFts(db, fts)
  return { imported: 0, sources }
}

// ---------- fail-closed memory access (recovery + MEMORY_ERROR) ----------
export type MemoryHandle = { db: Database; path: string }
export function openHandle(dbPath: string): MemoryHandle {
  return { db: openMemory(dbPath), path: dbPath }
}
const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// Probe that MUST return a row: distinguishes "query executed correctly" from
// connection-state uncertainty (bun:sqlite 1.3.14 quirk: parameterized .get()/.all()
// can intermittently return null/[] in fresh processes after a write-heavy exit).
export function memoryHealthy(db: Database): boolean {
  try {
    const r1 = db.query("SELECT COUNT(*) AS n FROM work_items").get() as { n: number } | null
    const r2 = db.query("SELECT COUNT(*) AS n FROM work_items WHERE 1=?").get(1) as { n: number } | null
    return !!r1 && typeof r1.n === "number" && !!r2 && typeof r2.n === "number"
  } catch {
    return false
  }
}

export class MemoryError extends Error {
  cause: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = "MemoryError"
    this.cause = cause
  }
}

function attempt<T>(h: MemoryHandle, fn: (db: Database) => T): T | undefined {
  if (!memoryHealthy(h.db)) return undefined
  try {
    const v = fn(h.db)
    if (!memoryHealthy(h.db)) return undefined
    return v
  } catch {
    return undefined
  }
}

// Deterministic minimal recovery: retry on the same connection, then close+reopen,
// then fail-closed with MemoryError. Never returns a result from an uncertain state.
export function runWithRecovery<T>(handle: MemoryHandle, fn: (db: Database) => T): { handle: MemoryHandle; value: T } {
  for (let i = 0; i < 3; i++) {
    const v = attempt(handle, fn)
    if (v !== undefined) return { handle, value: v }
    sleepMs(50 * (i + 1))
  }
  try { handle.db.close() } catch { /* already closed */ }
  let reopened: MemoryHandle
  try {
    reopened = openHandle(handle.path)
  } catch (e) {
    throw new MemoryError(`project memory unavailable (reopen failed): ${(e as Error).message}`, e)
  }
  const v = attempt(reopened, fn)
  if (v !== undefined) return { handle: reopened, value: v }
  throw new MemoryError("project memory connection state uncertain (recovery exhausted)")
}

export type MemoryErrorResult = {
  status: "MEMORY_ERROR"
  canonical_key: string
  error: { message: string; cause: string }
}

export function preflightSafe(handle: MemoryHandle, opts: { task: string; claim: boolean; ownerSession: string; projectDir: string; fts: boolean; reclaimTicket?: string; reclaimOwner?: string }): { handle: MemoryHandle; result: PreflightResult | MemoryErrorResult } {
  const key = normalizeKey(opts.task)
  try {
    const { handle: h, value } = runWithRecovery(handle, (db) => preflight(db, opts))
    return { handle: h, result: value }
  } catch (e: any) {
    const cause = e instanceof MemoryError ? (e.cause !== undefined ? String(e.cause) : e.message) : String(e?.message ?? e)
    return { handle, result: { status: "MEMORY_ERROR", canonical_key: key, error: { message: "project memory preflight unavailable or inconclusive", cause } } }
  }
}