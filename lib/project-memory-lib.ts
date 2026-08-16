// project-memory-lib.ts — Project Memory core (pure logic, no opencode plugin API; testable standalone with bun)
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as path from "node:path"
import * as crypto from "node:crypto"

// ---------- authorization ----------
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

// ---------- schema ----------
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
  // the column present and does nothing.
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
function stripMarkdown(s: string): string { return s.replace(/\*\*/g, "").replace(/`/g, "").trim() }
function evidenceFor(db: Database, itemId: string): string[] {
  return (db.query("SELECT path FROM evidence WHERE work_item_id=?").all(itemId) as { path: string }[]).map((r) => r.path)
}
function ftsQuery(key: string): string {
  const toks = key.split(" ").filter(Boolean)
  if (toks.length === 0) return '""'
  return toks.map((t) => `"${t}"`).join(" OR ")
}
function readFirstFor(db: Database, key: string, fts: boolean): string[] {
  if (fts) {
    return (db.query("SELECT path FROM markdown_fts WHERE markdown_fts MATCH ? ORDER BY rank LIMIT 6").all(ftsQuery(key)) as { path: string }[]).map((r) => r.path)
  }
  return (db.query("SELECT path FROM markdown_fts WHERE path LIKE ? OR title LIKE ? LIMIT 6").all(`%${key}%`, `%${key}%`) as { path: string }[]).map((r) => r.path)
}

// ---------- semantic continuation gate ----------
// An active (in_progress) ticket found only via the loose FTS candidate list
// may be reused ONLY when there is a real task correspondence: at least
// MIN_SEMANTIC_OVERLAP significant shared tokens between the request key and
// the candidate's stored text. FTS candidate membership alone (any single
// shared token, e.g. "local") must never be enough — regression: an unrelated
// active ticket was repeatedly returned for a different task.
// Threshold 3 (not 2): two shared significant tokens are NEVER enough to prove
// a continuation — e.g. "fix local project" vs "inspect local project" share
// {local, project} but are different tasks. Requiring >= 3 distinct significant
// shared tokens makes that false positive structurally impossible.
const MIN_SEMANTIC_OVERLAP = 3
const STOPWORDS = new Set([
  "a","an","and","are","as","at","be","been","by","for","from","in","into","is","it",
  "of","on","or","that","the","to","was","were","will","with","do","does","did","have",
  "has","had","not","but","this","these","those","its","our","your","their","we","you",
  "they","he","she","i","me","my","him","her","us","them","then","than","so","if",
  "while","when","where","which","who","whom","what","why","how","all","any","both",
  "each","few","more","most","other","some","such","no","nor","only","own","same",
  "too","very","just","also","even",
  "di","da","e","a","il","la","le","i","gli","lo","un","una","uno","del","della","dei",
  "delle","nel","nella","nei","nelle","con","su","per","che","chi","cui","piu","meno",
  "non","si","se","quando","dove","come","cosa","questo","questa","questi","queste",
  "quello","quella","quelli","quelle",
])
function sigTokens(s: string): Set<string> {
  const out = new Set<string>()
  for (const t of normalizeKey(s).split(" ").filter(Boolean)) {
    if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t)
  }
  return out
}
function tokenOverlap(a: string, b: string): number {
  const sa = sigTokens(a)
  const sb = sigTokens(b)
  let n = 0
  for (const t of sa) if (sb.has(t)) n++
  return n
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
export function reclaimWorkItem(db: Database, opts: { ticket: string; task: string; ownerSession: string; previousOwner: string }): ReclaimResult {
  const item = db.query("SELECT * FROM work_items WHERE id=?").get(opts.ticket) as WorkItem | undefined
  if (!item) return { ok: false, reason: `ticket not found: ${opts.ticket}` }
  if (item.status !== "in_progress") return { ok: false, reason: `ticket ${opts.ticket} is not in_progress (status=${item.status})` }
  const key = normalizeKey(opts.task)
  const overlap = tokenOverlap(key, `${item.canonical_key} ${item.summary} ${item.unresolved}`)
  if (key !== item.canonical_key && overlap < MIN_SEMANTIC_OVERLAP) {
    return { ok: false, reason: `reclaim denied: requested work does not correspond to ticket ${opts.ticket} (canonical_key=${item.canonical_key}, overlap=${overlap})` }
  }
  const now = nowIso()
  const historyNote = `[reclaim] ${now} from ${item.owner_session ?? "none"} to ${opts.ownerSession}`
  const notes = [item.notes, historyNote].filter(Boolean).join("\n")
  const res = db.run(
    "UPDATE work_items SET owner_session=?, notes=?, reclaimed_at=?, updated_at=? WHERE id=? AND status='in_progress' AND owner_session=?",
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
export type PreflightResult = {
  status: PreflightStatus
  ticket?: string
  canonical_key: string
  requested_key?: string
  matched_key?: string
  match_reason?: string
  match_score?: number
  reuse_denied?: { id: string; key: string; overlap: number }[]
  reuse_considered?: { id: string; key: string; overlap: number; selected: boolean }[]
  summary?: string
  established: string[]
  do_not_repeat: string[]
  unresolved: string[]
  evidence: string[]
  read_first: string[]
  scratch?: string
  owner_session?: string
  next_action?: "STEER" | "WAIT" | "DELEGATE"
  worker_session?: string
  reclaimed?: { previous_owner: string | null; reclaimed_at: string }
  reclaim_error?: string
  candidates: { key: string; status: string; id: string }[]
}

export function preflight(db: Database, opts: { task: string; claim: boolean; ownerSession: string; projectDir: string; fts: boolean; reclaimTicket?: string; reclaimOwner?: string }): PreflightResult {
  if (opts.reclaimTicket) {
    if (!opts.reclaimOwner) {
      const res = preflightCore(db, { task: opts.task, claim: opts.claim, ownerSession: opts.ownerSession, projectDir: opts.projectDir, fts: opts.fts })
      return { ...res, reclaim_error: "reclaim_owner is required: pass the owner_session observed in the IN_PROGRESS preflight result" }
    }
    const r = reclaimWorkItem(db, { ticket: opts.reclaimTicket, task: opts.task, ownerSession: opts.ownerSession, previousOwner: opts.reclaimOwner })
    if (r.ok) {
      const key = normalizeKey(opts.task)
      const readFirst = readFirstFor(db, key, opts.fts)
      const sc = ensureScratch(projectScratchBase(opts.projectDir), r.item.id)
      return { status: "NEW", ticket: r.item.id, canonical_key: r.item.canonical_key, requested_key: key, matched_key: r.item.canonical_key, match_reason: "reclaimed", summary: r.item.summary, established: r.item.summary ? [r.item.summary] : [], do_not_repeat: [], unresolved: r.item.unresolved ? [r.item.unresolved] : [], evidence: evidenceFor(db, r.item.id).slice(0, 10), read_first: readFirst, scratch: sc, owner_session: opts.ownerSession, candidates: [], reclaimed: { previous_owner: r.previous_owner, reclaimed_at: r.reclaimed_at } }
    }
    const res = preflightCore(db, { task: opts.task, claim: opts.claim, ownerSession: opts.ownerSession, projectDir: opts.projectDir, fts: opts.fts })
    return { ...res, reclaim_error: r.reason }
  }
  return preflightCore(db, { task: opts.task, claim: opts.claim, ownerSession: opts.ownerSession, projectDir: opts.projectDir, fts: opts.fts })
}

// What an orchestrator should do about an IN_PROGRESS ticket: STEER when a worker
// is already bound, WAIT when another session owns the claim (still running),
// DELEGATE when the current session owns the claim but no worker was spawned yet.
function inProgressAction(item: WorkItem, currentSession: string): "STEER" | "WAIT" | "DELEGATE" {
  if (item.worker_session) return "STEER"
  if (item.owner_session && item.owner_session !== currentSession) return "WAIT"
  return "DELEGATE"
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
      return { status: "IN_PROGRESS", canonical_key: key, requested_key: key, matched_key: item.canonical_key, match_reason: matchSrc ?? "exact", ticket: item.id, owner_session: item.owner_session ?? undefined, summary: item.summary, established: [], do_not_repeat: [], unresolved: item.unresolved ? [item.unresolved] : [], evidence: cap(evidenceFor(db, item.id), 10), read_first: readFirst, candidates: [], next_action: inProgressAction(item, opts.ownerSession), worker_session: item.worker_session ?? undefined }
    }
    if (item.status === "done" || item.status === "covered" || item.status === "blocked") {
      const unresolved = item.unresolved ? [item.unresolved] : []
      if (item.status === "blocked") unresolved.unshift(`BLOCKED: ${item.summary}`)
      return { status: "COVERED", canonical_key: key, requested_key: key, matched_key: item.canonical_key, match_reason: matchSrc ?? "exact", ticket: item.id, summary: item.summary, established: [item.summary].filter(Boolean), do_not_repeat: [`Covered by ${item.canonical_key} (${item.id})`], unresolved, evidence: cap(evidenceFor(db, item.id), 10), read_first: readFirst, candidates: [] }
    }
    // status 'new' / 'failed' → claimable
    if (opts.claim) {
      const priorNote = item.status === "failed" ? "prior failed attempt: " + [item.summary, item.notes].filter(Boolean).join(" | ") : ""
      const c = claimWorkItem(db, { canonicalKey: key, summary: opts.task, unresolved: opts.task, notes: priorNote, ownerSession: opts.ownerSession, source: "agent" })
      if (c.ok) { const sc = ensureScratch(scratchBase, c.item.id); return { status: "NEW", ticket: c.item.id, canonical_key: key, requested_key: key, matched_key: c.item.canonical_key, match_reason: "created", established: [], do_not_repeat: [], unresolved: [opts.task], evidence: [], read_first: readFirst, scratch: sc, candidates: [] } }
      return { status: "IN_PROGRESS", canonical_key: key, requested_key: key, matched_key: c.inProgress.canonical_key, match_reason: "claim-conflict", ticket: c.inProgress.id, owner_session: c.inProgress.owner_session ?? undefined, summary: c.inProgress.summary, established: [], do_not_repeat: [], unresolved: [], evidence: cap(evidenceFor(db, c.inProgress.id), 10), read_first: readFirst, candidates: [], next_action: inProgressAction(c.inProgress, opts.ownerSession), worker_session: c.inProgress.worker_session ?? undefined }
    }
    return { status: "NEW", canonical_key: key, requested_key: key, match_reason: "none", established: [], do_not_repeat: [], unresolved: [opts.task], evidence: [], read_first: readFirst, candidates: [] }
  }

  // Semantic continuation gate: reuse an active ticket ONLY when it really
  // corresponds to the requested task. FTS candidate membership alone (any
  // single shared token) is never sufficient: a continuation needs at least
  // MIN_SEMANTIC_OVERLAP distinct significant shared tokens. Every in_progress
  // candidate is scored and the BEST one is gated — the decision must not
  // depend on the arbitrary order of the candidates array.
  let reuseDenied: { id: string; key: string; overlap: number }[] = []
  let reuseConsidered: { id: string; key: string; overlap: number; selected: boolean }[] = []
  const inProgressCandidates = candidates.filter((c) => c.status === "in_progress")
  if (inProgressCandidates.length > 0) {
    const scored = inProgressCandidates.map((c) => ({ c, overlap: tokenOverlap(key, `${c.canonical_key} ${c.summary} ${c.unresolved}`) }))
    const best = scored.reduce((a, b) => (b.overlap > a.overlap || (b.overlap === a.overlap && (b.c.fts_rank ?? 0) < (a.c.fts_rank ?? 0)) ? b : a))
    reuseConsidered = scored.map(({ c, overlap }) => ({ id: c.id, key: c.canonical_key, overlap, selected: c.id === best.c.id }))
    if (best.overlap >= MIN_SEMANTIC_OVERLAP) {
      const c = best.c
      return { status: "IN_PROGRESS", canonical_key: key, requested_key: key, matched_key: c.canonical_key, match_reason: "semantic-continuation", match_score: best.overlap, ticket: c.id, owner_session: c.owner_session ?? undefined, summary: c.summary, established: [], do_not_repeat: [], unresolved: c.unresolved ? [c.unresolved] : [], evidence: cap(evidenceFor(db, c.id), 10), read_first: readFirst, candidates: [], reuse_considered: reuseConsidered, next_action: inProgressAction(c, opts.ownerSession), worker_session: c.worker_session ?? undefined }
    }
    reuseDenied = scored.map(({ c, overlap }) => ({ id: c.id, key: c.canonical_key, overlap }))
  }

  const doneCandidates = candidates.filter((c) => c.status === "done" || c.status === "covered" || c.status === "blocked")
  if (doneCandidates.length > 0) {
    const established = doneCandidates.map((c) => `${c.canonical_key}: ${c.summary}`)
    const dnr = doneCandidates.map((c) => `Covered by ${c.canonical_key} (${c.id})`)
    const ev = cap(doneCandidates.flatMap((c) => evidenceFor(db, c.id)), 10)
    const cand = doneCandidates.map((c) => ({ key: c.canonical_key, status: c.status, id: c.id }))
    if (opts.claim) {
      const c = claimWorkItem(db, { canonicalKey: key, summary: opts.task, unresolved: opts.task, notes: `delta of ${doneCandidates[0].canonical_key}`, ownerSession: opts.ownerSession, parentKey: doneCandidates[0].canonical_key, source: "agent" })
      if (c.ok) { const sc = ensureScratch(scratchBase, c.item.id); return { status: "PARTIAL", ticket: c.item.id, canonical_key: key, requested_key: key, matched_key: c.item.canonical_key, match_reason: "parent", established, do_not_repeat: dnr, unresolved: [opts.task], evidence: ev, read_first: readFirst, scratch: sc, candidates: cand, reuse_denied: reuseDenied.length ? reuseDenied : undefined, reuse_considered: reuseConsidered.length ? reuseConsidered : undefined } }
      return { status: "IN_PROGRESS", canonical_key: key, requested_key: key, matched_key: c.inProgress.canonical_key, match_reason: "claim-conflict", ticket: c.inProgress.id, owner_session: c.inProgress.owner_session ?? undefined, summary: c.inProgress.summary, established, do_not_repeat: dnr, unresolved: [], evidence: ev, read_first: readFirst, candidates: cand, reuse_denied: reuseDenied.length ? reuseDenied : undefined, reuse_considered: reuseConsidered.length ? reuseConsidered : undefined, next_action: inProgressAction(c.inProgress, opts.ownerSession), worker_session: c.inProgress.worker_session ?? undefined }
    }
    return { status: "PARTIAL", canonical_key: key, requested_key: key, match_reason: "none", established, do_not_repeat: dnr, unresolved: [opts.task], evidence: ev, read_first: readFirst, candidates: cand, reuse_denied: reuseDenied.length ? reuseDenied : undefined, reuse_considered: reuseConsidered.length ? reuseConsidered : undefined }
  }

  // NEW
  if (opts.claim) {
    const c = claimWorkItem(db, { canonicalKey: key, summary: opts.task, unresolved: opts.task, ownerSession: opts.ownerSession, source: "agent" })
    if (c.ok) { const sc = ensureScratch(scratchBase, c.item.id); return { status: "NEW", ticket: c.item.id, canonical_key: key, requested_key: key, matched_key: c.item.canonical_key, match_reason: "created", established: [], do_not_repeat: [], unresolved: [opts.task], evidence: [], read_first: readFirst, scratch: sc, candidates: [], reuse_denied: reuseDenied.length ? reuseDenied : undefined, reuse_considered: reuseConsidered.length ? reuseConsidered : undefined } }
    return { status: "IN_PROGRESS", canonical_key: key, requested_key: key, matched_key: c.inProgress.canonical_key, match_reason: "claim-conflict", ticket: c.inProgress.id, owner_session: c.inProgress.owner_session ?? undefined, summary: c.inProgress.summary, established: [], do_not_repeat: [], unresolved: [], evidence: cap(evidenceFor(db, c.inProgress.id), 10), read_first: readFirst, candidates: [], reuse_denied: reuseDenied.length ? reuseDenied : undefined, reuse_considered: reuseConsidered.length ? reuseConsidered : undefined, next_action: inProgressAction(c.inProgress, opts.ownerSession), worker_session: c.inProgress.worker_session ?? undefined }
  }
  return { status: "NEW", canonical_key: key, requested_key: key, match_reason: "none", established: [], do_not_repeat: [], unresolved: [opts.task], evidence: [], read_first: readFirst, candidates: [], reuse_denied: reuseDenied.length ? reuseDenied : undefined, reuse_considered: reuseConsidered.length ? reuseConsidered : undefined }
}
// ---------- record ----------
export function recordResult(db: Database, opts: { ticket: string; status: string; summary?: string; unresolved?: string; evidence?: string[]; facts?: { key: string; value: string }[] }): { ok: true; item: WorkItem } | { ok: false; reason: string } {
  const item = db.query("SELECT * FROM work_items WHERE id=?").get(opts.ticket) as WorkItem | undefined
  if (!item) return { ok: false, reason: `ticket not found: ${opts.ticket}` }
  const now = nowIso()
  const status = ["done", "blocked", "failed"].includes(opts.status) ? opts.status : "done"
  db.run("UPDATE work_items SET status=?, summary=COALESCE(?, summary), unresolved=COALESCE(?, unresolved), updated_at=? WHERE id=?", [status, opts.summary ?? null, opts.unresolved ?? null, now, opts.ticket])
  for (const p of opts.evidence ?? []) {
    const exists = db.query("SELECT 1 FROM evidence WHERE work_item_id=? AND path=?").get(opts.ticket, p)
    if (!exists) db.run("INSERT INTO evidence (work_item_id, path, kind, note) VALUES (?,?,?,?)", [opts.ticket, p, "file", ""])
  }
  for (const f of opts.facts ?? []) {
    db.run("INSERT INTO facts (key, value, source, updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, source=excluded.source, updated_at=excluded.updated_at", [f.key, f.value, `ticket:${opts.ticket}`, now])
  }
  return { ok: true, item: db.query("SELECT * FROM work_items WHERE id=?").get(opts.ticket) as WorkItem }
}

// ---------- failure append (serialized writer, collision-safe id) ----------
export function appendFailure(db: Database, opts: { projectDir: string; symptom: string; cause: string; lesson: string; topic?: string; fts: boolean }): { id: string; path: string } {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`
  const id = `FAIL-${ymd}-${ulid().slice(-8)}`
  const dir = path.join(opts.projectDir, ".opencode")
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "FAILURES.md")
  const block = `\n## ${id} — ${new Date().toISOString()}\n- **Sintomo**: ${opts.symptom}\n- **Causa**: ${opts.cause}\n- **Lezione**: ${opts.lesson}\n`
  fs.appendFileSync(file, block, "utf8")
  const key = normalizeKey(id)
  const c = claimWorkItem(db, { canonicalKey: key, summary: opts.lesson, unresolved: "", notes: `symptom: ${opts.symptom}; cause: ${opts.cause}`, ownerSession: "system", source: "agent" })
  const item = c.ok ? c.item : c.inProgress
  db.run("UPDATE work_items SET status='done', summary=?, notes=?, updated_at=? WHERE id=?", [opts.lesson, `symptom: ${opts.symptom}; cause: ${opts.cause}`, nowIso(), item.id])
  db.run("INSERT INTO evidence (work_item_id, path, kind, note) VALUES (?,?,?,?)", [item.id, file, "failures", id])
  if (opts.topic) {
    db.run("INSERT INTO aliases (work_item_id, alias) VALUES (?,?) ON CONFLICT(alias) DO NOTHING", [item.id, normalizeKey(opts.topic)])
  }
  return { id, path: file }
}

// ---------- goal checkpoint (atomic single-writer, managed section) ----------
const GOAL_START = "<!-- PROJECT-MEMORY:CURRENT-START -->"
const GOAL_END = "<!-- PROJECT-MEMORY:CURRENT-END -->"

export function checkpointGoal(projectDir: string, content: string): { path: string; bytes: number } {
  const dir = path.join(projectDir, ".opencode")
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "goal-state.md")
  let existing = ""
  if (fs.existsSync(file)) existing = fs.readFileSync(file, "utf8")
  const s = existing.indexOf(GOAL_START)
  const e = existing.indexOf(GOAL_END)
  let next: string
  if (s === -1 || e === -1 || e < s) {
    const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""
    next = existing + sep + GOAL_START + "\n" + content + "\n" + GOAL_END + "\n"
  } else {
    next = existing.slice(0, s + GOAL_START.length) + "\n" + content + "\n" + existing.slice(e)
  }
  const tmp = path.join(dir, `.goal-state.md.tmp-${process.pid}`)
  fs.writeFileSync(tmp, next, "utf8")
  fs.renameSync(tmp, file)
  return { path: file, bytes: Buffer.byteLength(next) }
}

// ---------- bootstrap (non-destructive importer) ----------
function mapStatus(statoLine: string): string {
  const s = statoLine.toLowerCase()
  if (s.includes("bloccato")) return "blocked"
  if (s.includes("dead")) return "done"
  if (s.includes("fatto")) return "done"
  return "new"
}

function importVectors(db: Database, file: string) {
  const content = fs.readFileSync(file, "utf8")
  const sections: { title: string; lines: string[] }[] = []
  let current: { title: string; lines: string[] } | null = null
  for (const line of content.split("\n")) {
    if (line.startsWith("### ")) { current = { title: line.slice(4).trim(), lines: [] }; sections.push(current) }
    else if (current) current.lines.push(line)
  }
  for (const s of sections) {
    const key = normalizeKey(s.title.split("(")[0])
    const stato = s.lines.find((l) => l.includes("**Stato**")) ?? ""
    const sintesi = s.lines.find((l) => l.includes("**Sintesi**")) ?? ""
    const evidenza = s.lines.find((l) => l.includes("**Evidenza**")) ?? ""
    const nonRipetere = s.lines.find((l) => l.includes("**NON ripetere**")) ?? ""
    const riap = s.lines.find((l) => l.includes("**Riapertura**")) ?? ""
    const status = mapStatus(stato)
    const summary = stripMarkdown(sintesi.replace(/^.*?\*\*Sintesi\*\*\s*:?\s*/, "")).slice(0, 500)
    const notes = [
      nonRipetere ? `NON RIPETERE: ${stripMarkdown(nonRipetere.replace(/^.*?\*\*NON ripetere\*\*\s*:?\s*/, "")).slice(0, 500)}` : "",
      riap ? `Riapertura: ${stripMarkdown(riap.replace(/^.*?\*\*Riapertura\*\*\s*:?\s*/, "")).slice(0, 300)}` : "",
    ].filter(Boolean).join("\n")
    const unresolved = riap ? stripMarkdown(riap.replace(/^.*?\*\*Riapertura\*\*\s*:?\s*/, "")).slice(0, 300) : ""
    const id = ulid()
    const now = nowIso()
    db.run("INSERT INTO work_items (id, canonical_key, status, summary, unresolved, notes, owner_session, parent_key, source, created_at, updated_at) VALUES (?,?,?,?,?,?,NULL,NULL,'bootstrap:VECTORS.md',?,?)", [id, key, status, summary, unresolved, notes, now, now])
    db.run("INSERT INTO aliases (work_item_id, alias) VALUES (?,?) ON CONFLICT(alias) DO NOTHING", [id, normalizeKey(s.title)])
    db.run("INSERT INTO evidence (work_item_id, path, kind, note) VALUES (?,?,?,?)", [id, file, "vectors", s.title])
    const all = s.lines.join("\n")
    for (const m of all.matchAll(/FAIL-\d+/g)) {
      db.run("INSERT INTO aliases (work_item_id, alias) VALUES (?,?) ON CONFLICT(alias) DO NOTHING", [id, normalizeKey(m[0])])
      db.run("INSERT INTO evidence (work_item_id, path, kind, note) VALUES (?,?,?,?)", [id, m[0], "fail", ""])
    }
    for (const m of all.matchAll(/report_[a-z0-9_]+\.md/g)) {
      db.run("INSERT INTO evidence (work_item_id, path, kind, note) VALUES (?,?,?,?)", [id, m[0], "report", ""])
    }
  }
}

function importFailures(db: Database, file: string) {
  const content = fs.readFileSync(file, "utf8")
  const sections: { title: string; lines: string[] }[] = []
  let current: { title: string; lines: string[] } | null = null
  for (const line of content.split("\n")) {
    if (line.startsWith("## ")) { current = { title: line.slice(3).trim(), lines: [] }; sections.push(current) }
    else if (current) current.lines.push(line)
  }
  for (const s of sections) {
    const m = s.title.match(/FAIL-\d+/i)
    if (!m) continue
    const key = normalizeKey(m[0])
    const first = s.lines.find((l) => l.trim().length > 0) ?? ""
    const summary = stripMarkdown(first).slice(0, 300)
    const now = nowIso()
    const existing = db.query("SELECT * FROM work_items WHERE canonical_key=?").get(key) as WorkItem | undefined
    if (existing) {
      db.run("UPDATE work_items SET summary=?, updated_at=? WHERE id=?", [summary || existing.summary, now, existing.id])
      db.run("INSERT INTO evidence (work_item_id, path, kind, note) VALUES (?,?,?,?)", [existing.id, file, "failures", s.title])
    } else {
      const id = ulid()
      db.run("INSERT INTO work_items (id, canonical_key, status, summary, unresolved, notes, owner_session, parent_key, source, created_at, updated_at) VALUES (?,?,'done',?,'','',NULL,NULL,'bootstrap:FAILURES.md',?,?)", [id, key, summary, now, now])
      db.run("INSERT INTO aliases (work_item_id, alias) VALUES (?,?) ON CONFLICT(alias) DO NOTHING", [id, key])
      db.run("INSERT INTO evidence (work_item_id, path, kind, note) VALUES (?,?,?,?)", [id, file, "failures", s.title])
    }
  }
}

function importReportsIndex(db: Database, file: string, projectDir: string) {
  const content = fs.readFileSync(file, "utf8")
  for (const line of content.split("\n")) {
    const m = line.match(/^\|\s*(report_[a-z0-9_]+\.md)\s*\|\s*(.*?)\s*\|\s*(\w+)\s*\|/)
    if (!m) continue
    const report = m[1]
    const sintesi = m[2]
    const stato = m[3].toLowerCase()
    const key = normalizeKey(report.replace(/\.md$/, ""))
    const status = stato.includes("fatto") || stato.includes("dead") ? "done" : "new"
    const id = ulid()
    const now = nowIso()
    db.run("INSERT INTO work_items (id, canonical_key, status, summary, unresolved, notes, owner_session, parent_key, source, created_at, updated_at) VALUES (?,?,?,?,'','',NULL,NULL,'bootstrap:REPORTS_INDEX.md',?,?)", [id, key, status, sintesi.slice(0, 300), now, now])
    db.run("INSERT INTO aliases (work_item_id, alias) VALUES (?,?) ON CONFLICT(alias) DO NOTHING", [id, normalizeKey(report)])
    db.run("INSERT INTO evidence (work_item_id, path, kind, note) VALUES (?,?,?,?)", [id, path.join(projectDir, ".opencode", report), "report", ""])
  }
}

export function bootstrap(db: Database, projectDir: string, fts: boolean): { imported: number; sources: string[] } {
  const dir = path.join(projectDir, ".opencode")
  const sources: string[] = []
  const tx = db.transaction(() => {
    const prev = db.query("SELECT id FROM work_items WHERE source LIKE 'bootstrap:%'").all() as { id: string }[]
    for (const r of prev) db.run("DELETE FROM work_items WHERE id=?", [r.id])
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
    const vectors = path.join(dir, "VECTORS.md")
    if (fs.existsSync(vectors)) importVectors(db, vectors)
    const failures = path.join(dir, "FAILURES.md")
    if (fs.existsSync(failures)) importFailures(db, failures)
    const reportsIndex = path.join(dir, "REPORTS_INDEX.md")
    if (fs.existsSync(reportsIndex)) importReportsIndex(db, reportsIndex, projectDir)
    const goalState = path.join(dir, "goal-state.md")
    if (fs.existsSync(goalState)) {
      const content = fs.readFileSync(goalState, "utf8")
      db.run("INSERT INTO facts (key, value, source, updated_at) VALUES ('goal-state', ?, 'bootstrap', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, source=excluded.source, updated_at=excluded.updated_at", [content.slice(0, 100000), nowIso()])
    }
  })
  tx()
  syncAllFts(db, fts)
  const n = (db.query("SELECT COUNT(*) AS n FROM work_items WHERE source LIKE 'bootstrap:%'").get() as { n: number }).n
  return { imported: n, sources }
}

// ---------- gate ----------
export type GateDecision = { action: "allow" | "block" | "warn"; reason?: string; ticket?: string }
export function gateDecision(db: Database, opts: { sessionID: string; args: { task_id?: string; subagent_type?: string } }): GateDecision {
  const args = opts.args ?? {}
  if (args.task_id) return { action: "allow", reason: "steering" }
  const st = args.subagent_type
  if (st === "vision" || st === "verifier") return { action: "allow", reason: `exempt: ${st}` }
  const claim = db.query("SELECT * FROM work_items WHERE owner_session=? AND status='in_progress' ORDER BY updated_at DESC LIMIT 1").get(opts.sessionID) as WorkItem | undefined
  if (claim) return { action: "allow", reason: "preflight ticket", ticket: claim.id }
  return { action: "block", reason: "project-memory gate: no preflight ticket for this session. Run project_work_check(work=...) to check status before delegating. If it returns IN_PROGRESS, do NOT retry task() for that work: steer the existing worker via task_id, reclaim only if orphaned, or continue other work. (Set PROJECT_MEMORY_GATE=warn to relax.)" }
}

// ---------- claim → child session binding (for steering via task_id) ----------
// Records the child as the WORKER of the parent's most recent in_progress claim.
// The parent KEEPS the claim (owner_session unchanged) so the orchestrator can
// delegate again later; the child session id is recorded in worker_session for
// steering/audit. Before this change ownership was TRANSFERRED to the child,
// which broke every subsequent task() for the parent (gate had no claim left).
export function bindClaimToChild(db: Database, parentID: string, childSessionID: string) {
  db.run("UPDATE work_items SET worker_session=?, updated_at=? WHERE id=(SELECT id FROM work_items WHERE owner_session=? AND status='in_progress' ORDER BY updated_at DESC LIMIT 1)", [childSessionID, nowIso(), parentID])
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

export function gateSafe(handle: MemoryHandle, opts: { sessionID: string; args: { task_id?: string; subagent_type?: string } }): { handle: MemoryHandle; decision: GateDecision } {
  const args = opts.args ?? {}
  if (args.task_id) return { handle, decision: { action: "allow", reason: "steering" } }
  const st = args.subagent_type
  if (st === "vision" || st === "verifier") return { handle, decision: { action: "allow", reason: `exempt: ${st}` } }
  try {
    const { handle: h, value } = runWithRecovery(handle, (db) => gateDecision(db, opts))
    return { handle: h, decision: value }
  } catch {
    return { handle, decision: { action: "block", reason: "Project memory preflight is unavailable or inconclusive. Delegation blocked to avoid repeating or conflicting work." } }
  }
}