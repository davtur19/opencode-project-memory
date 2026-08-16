// project-memory-lib.ts — Project Memory core (pure logic, no opencode plugin API; testable standalone with bun)
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as path from "node:path"
import * as crypto from "node:crypto"

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
  status TEXT NOT NULL CHECK (status IN ('new','in_progress','done','blocked','covered')),
  summary TEXT DEFAULT '',
  unresolved TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  owner_session TEXT,
  parent_key TEXT,
  source TEXT DEFAULT 'agent',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
  created_at: string; updated_at: string
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
  return db
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
         notes=excluded.notes, updated_at=excluded.updated_at
       WHERE NOT EXISTS (SELECT 1 FROM work_items w2 WHERE w2.canonical_key=excluded.canonical_key AND w2.status='in_progress' AND w2.id != excluded.id)`,
      [id, key, opts.summary ?? "", opts.unresolved ?? "", opts.notes ?? "", opts.ownerSession, opts.parentKey ?? null, opts.source ?? "agent", now, now],
    )
  } catch {
    const ip = db.query("SELECT * FROM work_items WHERE canonical_key=? AND status='in_progress'").get(key) as WorkItem | undefined
    if (ip) return { ok: false, inProgress: ip }
    // reopen race: retry once (0-row UPDATE is a silent no-op if another claimer won)
    try {
      db.run("UPDATE work_items SET status='in_progress', owner_session=?, unresolved=?, notes=?, updated_at=? WHERE canonical_key=? AND NOT EXISTS (SELECT 1 FROM work_items w2 WHERE w2.canonical_key=? AND w2.status='in_progress' AND w2.id != work_items.id)", [opts.ownerSession, opts.unresolved ?? "", opts.notes ?? "", now, key, key])
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

// ---------- preflight ----------
export type PreflightStatus = "COVERED" | "PARTIAL" | "NEW" | "IN_PROGRESS"
export type PreflightResult = {
  status: PreflightStatus
  ticket?: string
  canonical_key: string
  summary?: string
  established: string[]
  do_not_repeat: string[]
  unresolved: string[]
  evidence: string[]
  read_first: string[]
  scratch?: string
  owner_session?: string
  candidates: { key: string; status: string; id: string }[]
}

export function preflight(db: Database, opts: { task: string; claim: boolean; ownerSession: string; projectDir: string; fts: boolean }): PreflightResult {
  const key = normalizeKey(opts.task)
  maybeSyncFts(db, opts.fts)
  const fts = opts.fts
  let item = db.query("SELECT * FROM work_items WHERE canonical_key=?").get(key) as WorkItem | undefined
  if (!item) {
    item = db.query("SELECT w.* FROM aliases a JOIN work_items w ON w.id=a.work_item_id WHERE a.alias=? OR a.alias=?").get(key, opts.task.trim().toLowerCase()) as WorkItem | undefined
  }
  if (!item) {
    const idMatch = opts.task.match(/FAIL-\d+/i)
    if (idMatch) item = db.query("SELECT * FROM work_items WHERE canonical_key=?").get(normalizeKey(idMatch[0])) as WorkItem | undefined
  }
  let candidates: WorkItem[] = []
  if (fts) {
    candidates = db.query("SELECT w.* FROM memory_fts f JOIN work_items w ON w.rowid=f.rowid WHERE memory_fts MATCH ? ORDER BY rank LIMIT 6").all(ftsQuery(key)) as WorkItem[]
  } else {
    const like = `%${key}%`
    candidates = db.query("SELECT * FROM work_items WHERE canonical_key LIKE ? OR summary LIKE ? OR unresolved LIKE ? LIMIT 6").all(like, like, like) as WorkItem[]
  }
  let readFirst: string[] = []
  if (fts) {
    readFirst = (db.query("SELECT path FROM markdown_fts WHERE markdown_fts MATCH ? ORDER BY rank LIMIT 6").all(ftsQuery(key)) as { path: string }[]).map((r) => r.path)
  } else {
    readFirst = (db.query("SELECT path FROM markdown_fts WHERE path LIKE ? OR title LIKE ? LIMIT 6").all(`%${key}%`, `%${key}%`) as { path: string }[]).map((r) => r.path)
  }
  const scratchBase = projectScratchBase(opts.projectDir)
  const cap = (a: string[], n: number) => a.slice(0, n)

  if (item) {
    if (item.status === "in_progress") {
      return { status: "IN_PROGRESS", canonical_key: key, ticket: item.id, owner_session: item.owner_session ?? undefined, summary: item.summary, established: [], do_not_repeat: [], unresolved: item.unresolved ? [item.unresolved] : [], evidence: cap(evidenceFor(db, item.id), 10), read_first: readFirst, candidates: [] }
    }
    if (item.status === "done" || item.status === "covered" || item.status === "blocked") {
      const unresolved = item.unresolved ? [item.unresolved] : []
      if (item.status === "blocked") unresolved.unshift(`BLOCKED: ${item.summary}`)
      return { status: "COVERED", canonical_key: key, ticket: item.id, summary: item.summary, established: [item.summary].filter(Boolean), do_not_repeat: [`Covered by ${item.canonical_key} (${item.id})`], unresolved, evidence: cap(evidenceFor(db, item.id), 10), read_first: readFirst, candidates: [] }
    }
    // status 'new' → claimable
    if (opts.claim) {
      const c = claimWorkItem(db, { canonicalKey: key, summary: opts.task, unresolved: opts.task, ownerSession: opts.ownerSession, source: "agent" })
      if (c.ok) { const sc = ensureScratch(scratchBase, c.item.id); return { status: "NEW", ticket: c.item.id, canonical_key: key, established: [], do_not_repeat: [], unresolved: [opts.task], evidence: [], read_first: readFirst, scratch: sc, candidates: [] } }
      return { status: "IN_PROGRESS", canonical_key: key, ticket: c.inProgress.id, owner_session: c.inProgress.owner_session ?? undefined, summary: c.inProgress.summary, established: [], do_not_repeat: [], unresolved: [], evidence: cap(evidenceFor(db, c.inProgress.id), 10), read_first: readFirst, candidates: [] }
    }
    return { status: "NEW", canonical_key: key, established: [], do_not_repeat: [], unresolved: [opts.task], evidence: [], read_first: readFirst, candidates: [] }
  }

  const inProgressCandidates = candidates.filter((c) => c.status === "in_progress")
  if (inProgressCandidates.length > 0) {
    const c = inProgressCandidates[0]
    return { status: "IN_PROGRESS", canonical_key: key, ticket: c.id, owner_session: c.owner_session ?? undefined, summary: c.summary, established: [], do_not_repeat: [], unresolved: c.unresolved ? [c.unresolved] : [], evidence: cap(evidenceFor(db, c.id), 10), read_first: readFirst, candidates: [] }
  }

  const doneCandidates = candidates.filter((c) => c.status === "done" || c.status === "covered" || c.status === "blocked")
  if (doneCandidates.length > 0) {
    const established = doneCandidates.map((c) => `${c.canonical_key}: ${c.summary}`)
    const dnr = doneCandidates.map((c) => `Covered by ${c.canonical_key} (${c.id})`)
    const ev = cap(doneCandidates.flatMap((c) => evidenceFor(db, c.id)), 10)
    const cand = doneCandidates.map((c) => ({ key: c.canonical_key, status: c.status, id: c.id }))
    if (opts.claim) {
      const c = claimWorkItem(db, { canonicalKey: key, summary: opts.task, unresolved: opts.task, notes: `delta of ${doneCandidates[0].canonical_key}`, ownerSession: opts.ownerSession, parentKey: doneCandidates[0].canonical_key, source: "agent" })
      if (c.ok) { const sc = ensureScratch(scratchBase, c.item.id); return { status: "PARTIAL", ticket: c.item.id, canonical_key: key, established, do_not_repeat: dnr, unresolved: [opts.task], evidence: ev, read_first: readFirst, scratch: sc, candidates: cand } }
      return { status: "IN_PROGRESS", canonical_key: key, ticket: c.inProgress.id, owner_session: c.inProgress.owner_session ?? undefined, summary: c.inProgress.summary, established, do_not_repeat: dnr, unresolved: [], evidence: ev, read_first: readFirst, candidates: cand }
    }
    return { status: "PARTIAL", canonical_key: key, established, do_not_repeat: dnr, unresolved: [opts.task], evidence: ev, read_first: readFirst, candidates: cand }
  }

  // NEW
  if (opts.claim) {
    const c = claimWorkItem(db, { canonicalKey: key, summary: opts.task, unresolved: opts.task, ownerSession: opts.ownerSession, source: "agent" })
    if (c.ok) { const sc = ensureScratch(scratchBase, c.item.id); return { status: "NEW", ticket: c.item.id, canonical_key: key, established: [], do_not_repeat: [], unresolved: [opts.task], evidence: [], read_first: readFirst, scratch: sc, candidates: [] } }
    return { status: "IN_PROGRESS", canonical_key: key, ticket: c.inProgress.id, owner_session: c.inProgress.owner_session ?? undefined, summary: c.inProgress.summary, established: [], do_not_repeat: [], unresolved: [], evidence: cap(evidenceFor(db, c.inProgress.id), 10), read_first: readFirst, candidates: [] }
  }
  return { status: "NEW", canonical_key: key, established: [], do_not_repeat: [], unresolved: [opts.task], evidence: [], read_first: readFirst, candidates: [] }
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
  return { action: "block", reason: "project-memory gate: no preflight ticket for this session. Run project_preflight(task=...) before delegating. (Set PROJECT_MEMORY_GATE=warn to relax.)" }
}

// ---------- claim → child session binding (for steering via task_id) ----------
export function bindClaimToChild(db: Database, parentID: string, childSessionID: string) {
  db.run("UPDATE work_items SET owner_session=?, updated_at=? WHERE id=(SELECT id FROM work_items WHERE owner_session=? AND status='in_progress' ORDER BY updated_at DESC LIMIT 1)", [childSessionID, nowIso(), parentID])
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

export function preflightSafe(handle: MemoryHandle, opts: { task: string; claim: boolean; ownerSession: string; projectDir: string; fts: boolean }): { handle: MemoryHandle; result: PreflightResult | MemoryErrorResult } {
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