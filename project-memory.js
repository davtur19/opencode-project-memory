// @bun
// project-memory.ts
import { tool } from "@opencode-ai/plugin";
import * as path2 from "path";

// lib/project-memory-lib.ts
import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
function canAppendFailure(agent, primaryAgents) {
  return primaryAgents.includes(agent) || agent === "subagent";
}
var CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(now = Date.now()) {
  let s = "";
  let t = BigInt(now);
  for (let i = 0;i < 10; i++) {
    s = CROCKFORD[Number(t & 31n)] + s;
    t >>= 5n;
  }
  let r = 0n;
  for (const b of crypto.randomBytes(10))
    r = r << 8n | BigInt(b);
  for (let i = 0;i < 16; i++) {
    s += CROCKFORD[Number(r & 31n)];
    r >>= 5n;
  }
  return s;
}
function nowIso() {
  return new Date().toISOString();
}
function normalizeKey(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
var REF_BUDGET = 40;
function compactRef(s, budget = REF_BUDGET) {
  const norm = normalizeKey(s).replace(/\s+/g, " ").trim();
  if (norm.length <= budget)
    return norm;
  const hash = crypto.createHash("sha256").update(norm).digest("hex").slice(0, 6);
  return `${norm.slice(0, budget)}~${hash}`;
}
var SCHEMA = `
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
`;
function openMemory(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec("PRAGMA busy_timeout=5000;");
  const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (let attempt = 0;; attempt++) {
    try {
      db.exec("PRAGMA journal_mode=WAL;");
      break;
    } catch (e) {
      if (e?.code !== "SQLITE_BUSY" || attempt >= 100)
        throw e;
      sleepMs(50);
    }
  }
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(SCHEMA);
  migrateSchema(db);
  return db;
}
function migrateSchema(db) {
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.transaction(() => {
      const sql2 = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='work_items'").get()?.sql ?? "";
      if (sql2.includes("'failed'"))
        return;
      db.exec("CREATE TABLE work_items_new (id TEXT PRIMARY KEY, canonical_key TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('new','in_progress','done','blocked','covered','failed')), summary TEXT DEFAULT '', unresolved TEXT DEFAULT '', notes TEXT DEFAULT '', owner_session TEXT, parent_key TEXT, source TEXT DEFAULT 'agent', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reclaimed_at TEXT, worker_session TEXT)");
      db.run("INSERT INTO work_items_new (rowid, id, canonical_key, status, summary, unresolved, notes, owner_session, parent_key, source, created_at, updated_at, reclaimed_at, worker_session) SELECT rowid, id, canonical_key, status, summary, unresolved, notes, owner_session, parent_key, source, created_at, updated_at, NULL, NULL FROM work_items");
      db.exec("DROP TABLE work_items");
      db.exec("ALTER TABLE work_items_new RENAME TO work_items");
    })();
  } catch (e) {
    const sql3 = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='work_items'").get()?.sql ?? "";
    if (!sql3.includes("'failed'"))
      throw e;
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
  const cols = db.query("PRAGMA table_info(work_items)").all().map((c) => c.name);
  if (!cols.includes("worker_session")) {
    db.exec("ALTER TABLE work_items ADD COLUMN worker_session TEXT");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_key ON work_items(canonical_key)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_active ON work_items(canonical_key) WHERE status='in_progress'");
  db.exec("CREATE INDEX IF NOT EXISTS idx_work_items_owner ON work_items(owner_session)");
  db.run("DELETE FROM meta WHERE key='last_fts_sync'");
}
function ftsAvailable(db) {
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(canonical_key, summary, unresolved, notes, aliases, evidence_paths)");
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS markdown_fts USING fts5(path, title, body)");
    return true;
  } catch {
    return false;
  }
}
function syncAllFts(db, fts) {
  if (!fts)
    return;
  db.exec("DELETE FROM memory_fts");
  const rows = db.query("SELECT rowid, id, canonical_key, summary, unresolved, notes FROM work_items").all();
  const aliasRows = db.query("SELECT work_item_id, group_concat(alias, ' ') AS a FROM aliases GROUP BY work_item_id").all();
  const evRows = db.query("SELECT work_item_id, group_concat(path, ' ') AS p FROM evidence GROUP BY work_item_id").all();
  const aliasMap = new Map(aliasRows.map((r) => [r.work_item_id, r.a]));
  const evMap = new Map(evRows.map((r) => [r.work_item_id, r.p]));
  const ins = db.prepare("INSERT INTO memory_fts(rowid, canonical_key, summary, unresolved, notes, aliases, evidence_paths) VALUES (?,?,?,?,?,?,?)");
  for (const r of rows)
    ins.run(r.rowid, r.canonical_key, r.summary, r.unresolved, r.notes, aliasMap.get(r.id) ?? "", evMap.get(r.id) ?? "");
}
function claimWorkItem(db, opts) {
  const id = ulid();
  const now = nowIso();
  const key = normalizeKey(opts.canonicalKey);
  try {
    db.run(`INSERT INTO work_items (id, canonical_key, status, summary, unresolved, notes, owner_session, parent_key, source, created_at, updated_at)
       VALUES (?, ?, 'in_progress', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(canonical_key) DO UPDATE SET
         status='in_progress', owner_session=excluded.owner_session, unresolved=excluded.unresolved,
         notes=excluded.notes, reclaimed_at=NULL, updated_at=excluded.updated_at
       WHERE NOT EXISTS (SELECT 1 FROM work_items w2 WHERE w2.canonical_key=excluded.canonical_key AND w2.status='in_progress' AND w2.id != excluded.id)`, [id, key, opts.summary ?? "", opts.unresolved ?? "", opts.notes ?? "", opts.ownerSession, opts.parentKey ?? null, opts.source ?? "agent", now, now]);
  } catch {
    const ip = db.query("SELECT * FROM work_items WHERE canonical_key=? AND status='in_progress'").get(key);
    if (ip)
      return { ok: false, inProgress: ip };
    try {
      db.run("UPDATE work_items SET status='in_progress', owner_session=?, unresolved=?, notes=?, reclaimed_at=NULL, updated_at=? WHERE canonical_key=? AND NOT EXISTS (SELECT 1 FROM work_items w2 WHERE w2.canonical_key=? AND w2.status='in_progress' AND w2.id != work_items.id)", [opts.ownerSession, opts.unresolved ?? "", opts.notes ?? "", now, key, key]);
    } catch {
      const ip2 = db.query("SELECT * FROM work_items WHERE canonical_key=? AND status='in_progress'").get(key);
      if (ip2)
        return { ok: false, inProgress: ip2 };
      throw new Error("claim failed");
    }
  }
  const item = db.query("SELECT * FROM work_items WHERE canonical_key=?").get(key);
  if (item.status !== "in_progress" || item.owner_session !== opts.ownerSession) {
    const ip = db.query("SELECT * FROM work_items WHERE canonical_key=? AND status='in_progress'").get(key);
    if (ip)
      return { ok: false, inProgress: ip };
  }
  return { ok: true, item };
}
function projectScratchBase(projectDir) {
  const base = path.basename(projectDir);
  const h = crypto.createHash("sha1").update(projectDir).digest("hex").slice(0, 8);
  return path.join("/tmp", "opencode", `${base}-${h}`);
}
function scratchPath(base, ticket) {
  return path.join(base, ticket);
}
function ensureScratch(base, ticket) {
  const p = scratchPath(base, ticket);
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function evidenceFor(db, itemId) {
  return db.query("SELECT path FROM evidence WHERE work_item_id=?").all(itemId).map((r) => r.path);
}
function ftsQuery(key) {
  const toks = key.split(" ").filter(Boolean);
  if (toks.length === 0)
    return '""';
  return toks.map((t) => `"${t}"`).join(" OR ");
}
function readFirstFor(db, key, fts) {
  if (!fts)
    return [];
  try {
    return db.query("SELECT path FROM markdown_fts WHERE markdown_fts MATCH ? ORDER BY rank LIMIT 6").all(ftsQuery(key)).map((r) => r.path);
  } catch {
    return [];
  }
}
function maybeSyncFts(db, fts) {
  if (!fts)
    return;
  const st = db.query("SELECT COUNT(*) AS n, COALESCE(MAX(updated_at),'') AS m FROM work_items").get();
  const last = db.query("SELECT value FROM meta WHERE key='last_fts_sync'").get()?.value ?? "";
  const [lastN, lastM] = last.split("|");
  if (st.n !== Number(lastN) || st.m !== lastM) {
    syncAllFts(db, fts);
    db.run("INSERT INTO meta (key, value) VALUES ('last_fts_sync', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [`${st.n}|${st.m}`]);
  }
}
function reclaimWorkItem(db, opts) {
  const item = db.query("SELECT * FROM work_items WHERE id=?").get(opts.ticket);
  if (!item)
    return { ok: false, reason: `ticket not found: ${opts.ticket}` };
  if (item.status !== "in_progress")
    return { ok: false, reason: `ticket ${opts.ticket} is not in_progress (status=${item.status})` };
  const now = nowIso();
  const historyNote = `[reclaim] ${now} from ${item.owner_session ?? "none"} to ${opts.ownerSession}`;
  const notes = [item.notes, historyNote].filter(Boolean).join(`
`);
  const res = db.run("UPDATE work_items SET owner_session=?, notes=?, reclaimed_at=?, updated_at=?, worker_session=NULL WHERE id=? AND status='in_progress' AND owner_session=?", [opts.ownerSession, notes, now, now, opts.ticket, opts.previousOwner]);
  if (res.changes === 0) {
    const cur = db.query("SELECT * FROM work_items WHERE id=?").get(opts.ticket);
    if (!cur)
      return { ok: false, reason: `ticket not found: ${opts.ticket}` };
    if (cur.status !== "in_progress")
      return { ok: false, reason: `ticket ${opts.ticket} is not in_progress (status=${cur.status})` };
    return { ok: false, reason: `reclaim lost: current owner of ${opts.ticket} is ${cur.owner_session ?? "none"} (expected ${opts.previousOwner}); re-preflight to observe the current owner and retry` };
  }
  return { ok: true, item: db.query("SELECT * FROM work_items WHERE id=?").get(opts.ticket), previous_owner: opts.previousOwner, reclaimed_at: now };
}
function matchedOf(item, key) {
  if (item.canonical_key === key)
    return;
  return { ticket: item.id, ref: compactRef(item.canonical_key) };
}
function preflight(db, opts) {
  let res;
  if (opts.reclaimTicket) {
    if (!opts.reclaimOwner) {
      res = preflightCore(db, { task: opts.task, claim: opts.claim, ownerSession: opts.ownerSession, projectDir: opts.projectDir, fts: opts.fts });
      res = { ...res, reclaim_error: "reclaim_owner is required: pass the owner_session observed in the IN_PROGRESS preflight result" };
    } else {
      const r = reclaimWorkItem(db, { ticket: opts.reclaimTicket, ownerSession: opts.ownerSession, previousOwner: opts.reclaimOwner });
      if (r.ok) {
        const key = normalizeKey(opts.task);
        const readFirst = readFirstFor(db, key, opts.fts);
        const sc = ensureScratch(projectScratchBase(opts.projectDir), r.item.id);
        res = { status: "NEW", ticket: r.item.id, match_reason: "reclaimed", established: [], do_not_repeat: [], unresolved: r.item.unresolved ? [r.item.unresolved] : [opts.task], evidence: evidenceFor(db, r.item.id).slice(0, 10), read_first: readFirst, scratch: sc, owner_session: opts.ownerSession, candidates: [], reclaimed: { previous_owner: r.previous_owner, reclaimed_at: r.reclaimed_at } };
      } else {
        res = preflightCore(db, { task: opts.task, claim: opts.claim, ownerSession: opts.ownerSession, projectDir: opts.projectDir, fts: opts.fts });
        res = { ...res, reclaim_error: r.reason };
      }
    }
  } else {
    res = preflightCore(db, { task: opts.task, claim: opts.claim, ownerSession: opts.ownerSession, projectDir: opts.projectDir, fts: opts.fts });
  }
  return res;
}
function preflightCore(db, opts) {
  const key = normalizeKey(opts.task);
  maybeSyncFts(db, opts.fts);
  const fts = opts.fts;
  let matchSrc = null;
  let item = db.query("SELECT * FROM work_items WHERE canonical_key=?").get(key);
  if (item)
    matchSrc = "exact";
  if (!item) {
    item = db.query("SELECT w.* FROM aliases a JOIN work_items w ON w.id=a.work_item_id WHERE a.alias=? OR a.alias=?").get(key, opts.task.trim().toLowerCase());
    if (item)
      matchSrc = "alias";
  }
  if (!item) {
    const idMatch = opts.task.match(/FAIL-\d+/i);
    if (idMatch) {
      item = db.query("SELECT * FROM work_items WHERE canonical_key=?").get(normalizeKey(idMatch[0]));
      if (item)
        matchSrc = "fail-id";
    }
  }
  let candidates = [];
  if (fts) {
    candidates = db.query("SELECT w.*, f.rank AS fts_rank FROM memory_fts f JOIN work_items w ON w.rowid=f.rowid WHERE memory_fts MATCH ? ORDER BY rank LIMIT 6").all(ftsQuery(key));
  } else {
    const like = `%${key}%`;
    candidates = db.query("SELECT * FROM work_items WHERE canonical_key LIKE ? OR summary LIKE ? OR unresolved LIKE ? LIMIT 6").all(like, like, like);
  }
  const readFirst = readFirstFor(db, key, fts);
  const scratchBase = projectScratchBase(opts.projectDir);
  const cap = (a, n) => a.slice(0, n);
  if (item) {
    if (item.status === "in_progress") {
      return { status: "IN_PROGRESS", ticket: item.id, match_reason: matchSrc ?? "exact", matched: matchedOf(item, key), established: [], do_not_repeat: [], unresolved: item.unresolved ? [item.unresolved] : [], evidence: cap(evidenceFor(db, item.id), 10), read_first: readFirst, candidates: [], owner_session: item.owner_session ?? undefined };
    }
    if (item.status === "done" || item.status === "covered" || item.status === "blocked") {
      const unresolved = item.unresolved ? [item.unresolved] : [];
      if (item.status === "blocked")
        unresolved.unshift(`BLOCKED: ${item.summary}`);
      return { status: "COVERED", ticket: item.id, match_reason: matchSrc ?? "exact", matched: matchedOf(item, key), established: [item.summary].filter(Boolean), do_not_repeat: [`Covered by ${compactRef(item.canonical_key)} (${item.id})`], unresolved, evidence: cap(evidenceFor(db, item.id), 10), read_first: readFirst, candidates: [] };
    }
    if (opts.claim) {
      const priorNote = item.status === "failed" ? "prior failed attempt: " + [item.summary, item.notes].filter(Boolean).join(" | ") : "";
      const c = claimWorkItem(db, { canonicalKey: key, summary: opts.task, unresolved: opts.task, notes: priorNote, ownerSession: opts.ownerSession, source: "agent" });
      if (c.ok) {
        const sc = ensureScratch(scratchBase, c.item.id);
        if (item.status === "failed") {
          const prior = [item.summary, item.notes].filter(Boolean).join(" | ");
          return { status: "PARTIAL", ticket: c.item.id, match_reason: "prior-failure", established: prior ? [`prior failed attempt: ${prior}`] : [], do_not_repeat: [`Prior attempt failed (${compactRef(item.canonical_key)})${item.summary ? ": " + item.summary : ""}`.slice(0, 120)], unresolved: item.unresolved ? [item.unresolved] : [opts.task], evidence: cap(evidenceFor(db, c.item.id), 10), read_first: readFirst, scratch: sc, candidates: [] };
        }
        return { status: "NEW", ticket: c.item.id, match_reason: "created", established: [], do_not_repeat: [], unresolved: [opts.task], evidence: [], read_first: readFirst, scratch: sc, candidates: [] };
      }
      return { status: "IN_PROGRESS", ticket: c.inProgress.id, match_reason: "claim-conflict", established: [], do_not_repeat: [], unresolved: [], evidence: cap(evidenceFor(db, c.inProgress.id), 10), read_first: readFirst, candidates: [], owner_session: c.inProgress.owner_session ?? undefined };
    }
    if (item.status === "failed") {
      const prior = [item.summary, item.notes].filter(Boolean).join(" | ");
      return { status: "PARTIAL", match_reason: "prior-failure", established: prior ? [`prior failed attempt: ${prior}`] : [], do_not_repeat: [`Prior attempt failed (${compactRef(item.canonical_key)})${item.summary ? ": " + item.summary : ""}`.slice(0, 120)], unresolved: item.unresolved ? [item.unresolved] : [opts.task], evidence: cap(evidenceFor(db, item.id), 10), read_first: readFirst, candidates: [] };
    }
    return { status: "NEW", match_reason: "none", established: [], do_not_repeat: [], unresolved: [opts.task], evidence: [], read_first: readFirst, candidates: [] };
  }
  const doneCandidates = candidates.filter((c) => c.status === "done" || c.status === "covered" || c.status === "blocked");
  if (doneCandidates.length > 0) {
    const established = doneCandidates.map((c) => c.summary || compactRef(c.canonical_key));
    const dnr = doneCandidates.map((c) => `Covered by ${compactRef(c.canonical_key)} (${c.id})`);
    const ev = cap(doneCandidates.flatMap((c) => evidenceFor(db, c.id)), 10);
    const cand = doneCandidates.map((c) => ({ ticket: c.id, ref: compactRef(c.canonical_key), status: c.status }));
    if (opts.claim) {
      const c = claimWorkItem(db, { canonicalKey: key, summary: opts.task, unresolved: opts.task, notes: `delta of ${doneCandidates[0].canonical_key}`, ownerSession: opts.ownerSession, parentKey: doneCandidates[0].canonical_key, source: "agent" });
      if (c.ok) {
        const sc = ensureScratch(scratchBase, c.item.id);
        return { status: "PARTIAL", ticket: c.item.id, match_reason: "parent", established, do_not_repeat: dnr, unresolved: [opts.task], evidence: ev, read_first: readFirst, scratch: sc, candidates: cand };
      }
      return { status: "IN_PROGRESS", ticket: c.inProgress.id, match_reason: "claim-conflict", established, do_not_repeat: dnr, unresolved: [], evidence: ev, read_first: readFirst, candidates: cand, owner_session: c.inProgress.owner_session ?? undefined };
    }
    return { status: "PARTIAL", match_reason: "none", established, do_not_repeat: dnr, unresolved: [opts.task], evidence: ev, read_first: readFirst, candidates: cand };
  }
  if (opts.claim) {
    const c = claimWorkItem(db, { canonicalKey: key, summary: opts.task, unresolved: opts.task, ownerSession: opts.ownerSession, source: "agent" });
    if (c.ok) {
      const sc = ensureScratch(scratchBase, c.item.id);
      return { status: "NEW", ticket: c.item.id, match_reason: "created", established: [], do_not_repeat: [], unresolved: [opts.task], evidence: [], read_first: readFirst, scratch: sc, candidates: [] };
    }
    return { status: "IN_PROGRESS", ticket: c.inProgress.id, match_reason: "claim-conflict", established: [], do_not_repeat: [], unresolved: [], evidence: cap(evidenceFor(db, c.inProgress.id), 10), read_first: readFirst, candidates: [], owner_session: c.inProgress.owner_session ?? undefined };
  }
  return { status: "NEW", match_reason: "none", established: [], do_not_repeat: [], unresolved: [opts.task], evidence: [], read_first: readFirst, candidates: [] };
}
function recordResult(db, opts) {
  const item = db.query("SELECT * FROM work_items WHERE id=?").get(opts.ticket);
  if (!item)
    return { ok: false, reason: `ticket not found: ${opts.ticket}` };
  if (item.owner_session && item.owner_session !== opts.ownerSession) {
    return { ok: false, reason: `ticket ${opts.ticket} is owned by ${item.owner_session} (status=${item.status}); session ${opts.ownerSession ?? "unknown"} cannot record it (reclaim via project_work_check with reclaim_ticket=${opts.ticket} and reclaim_owner=${item.owner_session})` };
  }
  const now = nowIso();
  const status = ["done", "blocked", "failed"].includes(opts.status) ? opts.status : "done";
  db.run("UPDATE work_items SET status=?, summary=COALESCE(?, summary), unresolved=COALESCE(?, unresolved), updated_at=? WHERE id=?", [status, opts.summary ?? null, opts.unresolved ?? null, now, opts.ticket]);
  for (const p of opts.evidence ?? []) {
    const exists = db.query("SELECT 1 FROM evidence WHERE work_item_id=? AND path=?").get(opts.ticket, p);
    if (!exists)
      db.run("INSERT INTO evidence (work_item_id, path, kind, note) VALUES (?,?,?,?)", [opts.ticket, p, "file", ""]);
  }
  return { ok: true, item: db.query("SELECT * FROM work_items WHERE id=?").get(opts.ticket) };
}
function recordFailure(db, opts) {
  const d = new Date;
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const id = `FAIL-${ymd}-${ulid().slice(-8)}`;
  const key = normalizeKey(id);
  const c = claimWorkItem(db, { canonicalKey: key, summary: opts.lesson, unresolved: "", notes: `symptom: ${opts.symptom}; cause: ${opts.cause}`, ownerSession: "system", source: "agent" });
  const item = c.ok ? c.item : c.inProgress;
  db.run("UPDATE work_items SET status='done', summary=?, notes=?, updated_at=? WHERE id=?", [opts.lesson, `symptom: ${opts.symptom}; cause: ${opts.cause}`, nowIso(), item.id]);
  if (opts.topic) {
    db.run("INSERT INTO aliases (work_item_id, alias) VALUES (?,?) ON CONFLICT(alias) DO NOTHING", [item.id, normalizeKey(opts.topic)]);
  }
  return { id };
}
function bootstrap(db, projectDir, fts) {
  if (!fts)
    return { imported: 0, sources: [] };
  const dir = path.join(projectDir, ".opencode");
  const sources = [];
  db.transaction(() => {
    db.exec("DELETE FROM markdown_fts");
    const mdFiles = [];
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir))
        if (f.endsWith(".md"))
          mdFiles.push(path.join(dir, f));
    }
    const projFailures = path.join(projectDir, "FAILURES.md");
    if (fs.existsSync(projFailures))
      mdFiles.push(projFailures);
    const insMd = db.prepare("INSERT INTO markdown_fts (path, title, body) VALUES (?,?,?)");
    for (const f of mdFiles) {
      try {
        const body = fs.readFileSync(f, "utf8");
        const title = (body.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(f)).slice(0, 200);
        insMd.run(f, title, body);
        sources.push(f);
      } catch {}
    }
  })();
  syncAllFts(db, fts);
  return { imported: 0, sources };
}
function openHandle(dbPath) {
  return { db: openMemory(dbPath), path: dbPath };
}
var sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function memoryHealthy(db) {
  try {
    const r1 = db.query("SELECT COUNT(*) AS n FROM work_items").get();
    const r2 = db.query("SELECT COUNT(*) AS n FROM work_items WHERE 1=?").get(1);
    return !!r1 && typeof r1.n === "number" && !!r2 && typeof r2.n === "number";
  } catch {
    return false;
  }
}

class MemoryError extends Error {
  cause;
  constructor(message, cause) {
    super(message);
    this.name = "MemoryError";
    this.cause = cause;
  }
}
function attempt(h, fn) {
  if (!memoryHealthy(h.db))
    return;
  try {
    const v = fn(h.db);
    if (!memoryHealthy(h.db))
      return;
    return v;
  } catch {
    return;
  }
}
function runWithRecovery(handle, fn) {
  for (let i = 0;i < 3; i++) {
    const v2 = attempt(handle, fn);
    if (v2 !== undefined)
      return { handle, value: v2 };
    sleepMs(50 * (i + 1));
  }
  try {
    handle.db.close();
  } catch {}
  let reopened;
  try {
    reopened = openHandle(handle.path);
  } catch (e) {
    throw new MemoryError(`project memory unavailable (reopen failed): ${e.message}`, e);
  }
  const v = attempt(reopened, fn);
  if (v !== undefined)
    return { handle: reopened, value: v };
  throw new MemoryError("project memory connection state uncertain (recovery exhausted)");
}
function preflightSafe(handle, opts) {
  const key = normalizeKey(opts.task);
  try {
    const { handle: h, value } = runWithRecovery(handle, (db) => preflight(db, opts));
    return { handle: h, result: value };
  } catch (e) {
    const cause = e instanceof MemoryError ? e.cause !== undefined ? String(e.cause) : e.message : String(e?.message ?? e);
    return { handle, result: { status: "MEMORY_ERROR", canonical_key: key, error: { message: "project memory preflight unavailable or inconclusive", cause } } };
  }
}

// lib/project-memory-v2.ts
var IDEA_STATUSES = ["proposed", "testing", "validated", "disproven", "dormant"];
var RELATION_KINDS = ["requires", "enables", "supports", "contradicts", "combines_with", "derived_from"];
var V2_SCHEMA = `
CREATE TABLE IF NOT EXISTS ideas (
  id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL UNIQUE,
  title TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','testing','validated','disproven','dormant')),
  rationale TEXT DEFAULT '',
  evidence TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conditions (
  id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  satisfied INTEGER NOT NULL DEFAULT 0,
  satisfied_by TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idea_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('requires','enables','supports','contradicts','combines_with','derived_from')),
  target_type TEXT NOT NULL CHECK (target_type IN ('idea','condition')),
  target_id TEXT NOT NULL,
  note TEXT DEFAULT '',
  UNIQUE(idea_id, kind, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_relations_idea ON idea_relations(idea_id);
CREATE INDEX IF NOT EXISTS idx_relations_target ON idea_relations(target_type, target_id);
`;
function ensureV2Schema(db, fts) {
  db.exec(V2_SCHEMA);
  if (fts) {
    try {
      db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS idea_fts USING fts5(canonical_key, title, summary, rationale)");
    } catch {}
  }
}
function ftsQueryV2(key) {
  const toks = key.split(" ").filter(Boolean);
  if (toks.length === 0)
    return '""';
  return toks.map((t) => `"${t}"`).join(" OR ");
}
function ideaFtsExists(db) {
  try {
    return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='idea_fts'").get();
  } catch {
    return false;
  }
}
function syncIdeaFts(db, ideaId) {
  try {
    if (!ideaFtsExists(db))
      return;
    const r = db.query("SELECT rowid, canonical_key, title, summary, rationale FROM ideas WHERE id=?").get(ideaId);
    if (!r)
      return;
    db.run("DELETE FROM idea_fts WHERE rowid=?", [r.rowid]);
    db.run("INSERT INTO idea_fts(rowid, canonical_key, title, summary, rationale) VALUES (?,?,?,?,?)", [r.rowid, r.canonical_key, r.title, r.summary, r.rationale]);
  } catch {}
}
function resolveIdea(db, ref) {
  if (typeof ref !== "string" || !ref)
    return null;
  const byId = db.query("SELECT * FROM ideas WHERE id=?").get(ref);
  if (byId)
    return { id: byId.id, canonical_key: byId.canonical_key };
  const k = normalizeKey(ref);
  if (!k)
    return null;
  const byKey = db.query("SELECT * FROM ideas WHERE canonical_key=?").get(k);
  if (byKey)
    return { id: byKey.id, canonical_key: byKey.canonical_key };
  return null;
}
function resolveTarget(db, target, sameCall) {
  if (typeof target !== "string" || !target)
    return null;
  if (target.startsWith("condition:")) {
    const k2 = normalizeKey(target.slice("condition:".length));
    if (!k2)
      return null;
    const row = db.query("SELECT * FROM conditions WHERE canonical_key=?").get(k2);
    if (row)
      return { target_type: "condition", target_id: row.id, target_key: row.canonical_key };
    if (sameCall && sameCall.condIds.has(k2))
      return { target_type: "condition", target_id: sameCall.condIds.get(k2), target_key: k2 };
    return null;
  }
  if (target.startsWith("idea:")) {
    const k2 = normalizeKey(target.slice("idea:".length));
    if (!k2)
      return null;
    const row = db.query("SELECT * FROM ideas WHERE canonical_key=?").get(k2);
    if (row)
      return { target_type: "idea", target_id: row.id, target_key: row.canonical_key };
    if (sameCall && k2 === sameCall.ideaKey)
      return { target_type: "idea", target_id: sameCall.ideaId, target_key: sameCall.ideaKey };
    return null;
  }
  const byIdeaId = db.query("SELECT * FROM ideas WHERE id=?").get(target);
  if (byIdeaId)
    return { target_type: "idea", target_id: byIdeaId.id, target_key: byIdeaId.canonical_key };
  const k = normalizeKey(target);
  if (!k)
    return null;
  const byIdeaKey = db.query("SELECT * FROM ideas WHERE canonical_key=?").get(k);
  if (byIdeaKey)
    return { target_type: "idea", target_id: byIdeaKey.id, target_key: byIdeaKey.canonical_key };
  const byCondId = db.query("SELECT * FROM conditions WHERE id=?").get(target);
  if (byCondId)
    return { target_type: "condition", target_id: byCondId.id, target_key: byCondId.canonical_key };
  const byCondKey = db.query("SELECT * FROM conditions WHERE canonical_key=?").get(k);
  if (byCondKey)
    return { target_type: "condition", target_id: byCondKey.id, target_key: byCondKey.canonical_key };
  if (sameCall) {
    if (target === sameCall.ideaId || k === sameCall.ideaKey)
      return { target_type: "idea", target_id: sameCall.ideaId, target_key: sameCall.ideaKey };
    if (sameCall.condIds.has(k))
      return { target_type: "condition", target_id: sameCall.condIds.get(k), target_key: k };
  }
  return null;
}
function derivedStateFor(db, ideaId) {
  const idea = db.query("SELECT * FROM ideas WHERE id=?").get(ideaId);
  if (!idea)
    return { derived: "proposed", blockers: [] };
  if (idea.status !== "proposed")
    return { derived: idea.status, blockers: [] };
  const blockers = [];
  const reqs = db.query("SELECT * FROM idea_relations WHERE idea_id=? AND kind='requires'").all(ideaId);
  for (const r of reqs) {
    if (r.target_type === "condition") {
      const c = db.query("SELECT * FROM conditions WHERE id=?").get(r.target_id);
      if (!c || c.satisfied !== 1) {
        blockers.push({ type: "condition", key: c?.canonical_key ?? r.target_id, note: "condition unsatisfied" });
      }
    } else {
      const t = db.query("SELECT * FROM ideas WHERE id=?").get(r.target_id);
      if (!t)
        blockers.push({ type: "idea", key: r.target_id, note: "required idea missing" });
      else if (t.status === "disproven")
        blockers.push({ type: "idea", key: t.canonical_key, note: "required idea disproven" });
      else if (t.status !== "validated")
        blockers.push({ type: "idea", key: t.canonical_key, note: "required idea not validated" });
    }
  }
  return { derived: blockers.length ? "blocked" : "ready", blockers };
}
function ideaRecord(db, opts = {}) {
  const errors = [];
  const ideaOpts = { ...opts.idea ?? {} };
  if (opts.status !== undefined && ideaOpts.status === undefined)
    ideaOpts.status = opts.status;
  if (opts.evidence !== undefined && ideaOpts.evidence === undefined)
    ideaOpts.evidence = opts.evidence;
  const hasId = typeof ideaOpts.id === "string" && ideaOpts.id.length > 0;
  let key = "";
  let existingRow;
  if (hasId) {
    existingRow = db.query("SELECT * FROM ideas WHERE id=?").get(ideaOpts.id);
    if (!existingRow)
      return { ok: false, error: `idea not found by id: ${ideaOpts.id}` };
    key = existingRow.canonical_key;
  } else {
    key = normalizeKey(typeof ideaOpts.key === "string" ? ideaOpts.key : "");
    if (!key)
      return { ok: false, error: "idea.key or idea.id required" };
    existingRow = db.query("SELECT * FROM ideas WHERE canonical_key=?").get(key);
  }
  const ideaId = existingRow?.id ?? ulid();
  let statusProvided = false;
  let status = existingRow?.status ?? "proposed";
  if (typeof ideaOpts.status === "string" && ideaOpts.status !== "") {
    if (IDEA_STATUSES.includes(ideaOpts.status)) {
      statusProvided = true;
      status = ideaOpts.status;
    } else
      errors.push(`invalid idea status '${ideaOpts.status}' (expected one of: ${IDEA_STATUSES.join(", ")})`);
  }
  const evidence = typeof ideaOpts.evidence === "string" ? ideaOpts.evidence : existingRow?.evidence ?? "";
  const evidenceSupplied = typeof ideaOpts.evidence === "string" && ideaOpts.evidence.trim() !== "";
  if (status === "validated" || status === "disproven") {
    if (evidence.trim() === "") {
      errors.push(`status '${status}' requires non-empty evidence`);
    }
    const statusChanging = !existingRow || existingRow.status !== status;
    if (statusChanging && !evidenceSupplied) {
      errors.push(`transition to '${status}' requires evidence supplied for this transition`);
    }
  }
  const condSpecs = [];
  const condIds = new Map;
  for (const c of opts.conditions ?? []) {
    const ckey = normalizeKey(typeof c.key === "string" ? c.key : "");
    if (!ckey) {
      errors.push(`condition key required (got ${JSON.stringify(c.key)})`);
      continue;
    }
    if (c.satisfied === true && !(typeof c.satisfied_by === "string" && c.satisfied_by.trim() !== "")) {
      errors.push(`condition '${ckey}' satisfied=true requires satisfied_by (explicit provenance)`);
    }
    const existingCond = db.query("SELECT * FROM conditions WHERE canonical_key=?").get(ckey);
    condIds.set(ckey, existingCond?.id ?? ulid());
    condSpecs.push({ key: ckey, description: c.description, satisfied: c.satisfied, satisfied_by: c.satisfied_by });
  }
  const sameCall = { ideaId, ideaKey: key, condIds };
  const satisfiesSpecs = [];
  for (const s of opts.satisfies ?? []) {
    const skey = normalizeKey(typeof s === "string" ? s : "");
    if (!skey) {
      errors.push(`satisfies key required (got ${JSON.stringify(s)})`);
      continue;
    }
    const cond = db.query("SELECT * FROM conditions WHERE canonical_key=?").get(skey);
    if (!cond && !condIds.has(skey)) {
      errors.push(`satisfies target condition not found: ${skey}`);
      continue;
    }
    satisfiesSpecs.push(skey);
  }
  if (opts.satisfies?.length) {
    if (status !== "validated")
      errors.push("satisfies requires the idea to be validated");
    if (evidence.trim() === "")
      errors.push("satisfies requires the idea to carry evidence");
  }
  const resolveSource = (ref) => {
    const existing = resolveIdea(db, ref);
    if (existing)
      return existing;
    if (typeof ref === "string" && (ref === ideaId || normalizeKey(ref) === key))
      return { id: ideaId, canonical_key: key };
    return null;
  };
  const relSpecs = [];
  for (const r of opts.relations ?? []) {
    const src = resolveSource(r.idea);
    if (!src) {
      errors.push(`relation source idea not found: ${r.idea}`);
      continue;
    }
    if (!RELATION_KINDS.includes(r.kind)) {
      errors.push(`invalid relation kind '${r.kind}' (expected one of: ${RELATION_KINDS.join(", ")})`);
      continue;
    }
    const tr = resolveTarget(db, r.target, sameCall);
    if (!tr) {
      errors.push(`relation target not found: ${r.target}`);
      continue;
    }
    relSpecs.push({ ideaId: src.id, ideaKey: src.canonical_key, kind: r.kind, targetType: tr.target_type, targetId: tr.target_id, targetKey: tr.target_key, note: typeof r.note === "string" ? r.note : "" });
  }
  const remSpecs = [];
  for (const r of opts.remove_relations ?? []) {
    const src = resolveSource(r.idea);
    if (!src) {
      errors.push(`relation source idea not found: ${r.idea}`);
      continue;
    }
    if (!RELATION_KINDS.includes(r.kind)) {
      errors.push(`invalid relation kind '${r.kind}' (expected one of: ${RELATION_KINDS.join(", ")})`);
      continue;
    }
    const tr = resolveTarget(db, r.target, sameCall);
    if (!tr) {
      errors.push(`relation target not found: ${r.target}`);
      continue;
    }
    remSpecs.push({ ideaId: src.id, ideaKey: src.canonical_key, kind: r.kind, targetType: tr.target_type, targetId: tr.target_id, targetKey: tr.target_key });
  }
  if (errors.length > 0) {
    return { ok: false, error: errors.join("; "), errors };
  }
  try {
    return db.transaction(() => applyIdeaRecord(db, { ideaId, ideaOpts, key, existingRow, statusProvided, status, evidence, condSpecs, condIds, satisfiesSpecs, relSpecs, remSpecs }))();
  } catch (e) {
    return { ok: false, error: `idea_save failed: ${e?.message ?? e}` };
  }
}
function applyIdeaRecord(db, cfg) {
  const { ideaId, ideaOpts, key, existingRow, statusProvided, status, evidence, condSpecs, condIds, satisfiesSpecs, relSpecs, remSpecs } = cfg;
  const now = nowIso();
  if (existingRow) {
    const sets = [];
    const vals = [];
    for (const col of ["title", "summary", "rationale", "evidence"]) {
      if (typeof ideaOpts[col] === "string") {
        sets.push(`${col}=?`);
        vals.push(ideaOpts[col]);
      }
    }
    if (statusProvided) {
      sets.push("status=?");
      vals.push(status);
    }
    sets.push("updated_at=?");
    vals.push(now);
    db.run(`UPDATE ideas SET ${sets.join(", ")} WHERE id=?`, [...vals, existingRow.id]);
  } else {
    db.run(`INSERT INTO ideas (id, canonical_key, title, summary, status, rationale, evidence, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`, [
      ideaId,
      key,
      typeof ideaOpts.title === "string" ? ideaOpts.title : "",
      typeof ideaOpts.summary === "string" ? ideaOpts.summary : "",
      statusProvided ? status : "proposed",
      typeof ideaOpts.rationale === "string" ? ideaOpts.rationale : "",
      typeof ideaOpts.evidence === "string" ? ideaOpts.evidence : "",
      now,
      now
    ]);
  }
  syncIdeaFts(db, ideaId);
  const condTouched = new Map;
  for (const c of condSpecs) {
    const existing = db.query("SELECT * FROM conditions WHERE canonical_key=?").get(c.key);
    const cid = existing?.id ?? condIds.get(c.key) ?? ulid();
    const desc = typeof c.description === "string" ? c.description : existing?.description ?? c.key;
    let satisfied;
    let satisfiedBy;
    if (typeof c.satisfied === "boolean") {
      satisfied = c.satisfied ? 1 : 0;
      satisfiedBy = c.satisfied ? typeof c.satisfied_by === "string" ? c.satisfied_by : "" : "";
    } else {
      satisfied = existing?.satisfied ?? 0;
      satisfiedBy = existing?.satisfied_by ?? "";
    }
    const sets = [];
    const vals = [];
    if (typeof c.description === "string") {
      sets.push("description=?");
      vals.push(c.description);
    }
    if (typeof c.satisfied === "boolean") {
      sets.push("satisfied=?");
      vals.push(satisfied);
      sets.push("satisfied_by=?");
      vals.push(satisfiedBy);
    }
    sets.push("updated_at=?");
    vals.push(now);
    if (existing) {
      db.run(`UPDATE conditions SET ${sets.join(", ")} WHERE id=?`, [...vals, existing.id]);
    } else {
      db.run("INSERT INTO conditions (id, canonical_key, description, satisfied, satisfied_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", [cid, c.key, desc, satisfied, satisfiedBy, now, now]);
    }
    condTouched.set(c.key, { key: c.key, description: desc, satisfied: satisfied === 1, satisfied_by: satisfiedBy });
  }
  for (const skey of satisfiesSpecs) {
    const existing = db.query("SELECT * FROM conditions WHERE canonical_key=?").get(skey);
    if (!existing)
      continue;
    db.run("UPDATE conditions SET satisfied=1, satisfied_by=?, updated_at=? WHERE id=?", [ideaId, now, existing.id]);
    condTouched.set(skey, { key: skey, description: existing.description, satisfied: true, satisfied_by: ideaId });
  }
  const addedRelations = [];
  for (const r of relSpecs) {
    const res = db.run("INSERT OR IGNORE INTO idea_relations (idea_id, kind, target_type, target_id, note) VALUES (?,?,?,?,?)", [r.ideaId, r.kind, r.targetType, r.targetId, r.note ?? ""]);
    if (res.changes > 0) {
      addedRelations.push({ idea: r.ideaKey, kind: r.kind, target: (r.targetType === "idea" ? "idea:" : "condition:") + r.targetKey });
    }
  }
  let removedRelations = 0;
  for (const r of remSpecs) {
    const del = db.run("DELETE FROM idea_relations WHERE idea_id=? AND kind=? AND target_type=? AND target_id=?", [r.ideaId, r.kind, r.targetType, r.targetId]);
    removedRelations += del.changes;
  }
  const finalRow = db.query("SELECT * FROM ideas WHERE id=?").get(ideaId);
  const d = derivedStateFor(db, ideaId);
  return {
    ok: true,
    idea: {
      id: finalRow.id,
      key: finalRow.canonical_key,
      title: finalRow.title,
      summary: finalRow.summary,
      status: finalRow.status,
      rationale: finalRow.rationale,
      evidence: finalRow.evidence,
      created_at: finalRow.created_at,
      updated_at: finalRow.updated_at,
      derived: d.derived,
      blockers: d.blockers
    },
    conditions: [...condTouched.values()].slice(0, 20),
    relations: addedRelations.slice(0, 20),
    removed_relations: removedRelations
  };
}
function projectFrontier(db, opts = {}) {
  const limit = typeof opts?.limit === "number" && Number.isFinite(opts.limit) ? Math.max(1, Math.min(20, Math.floor(opts.limit))) : 8;
  const key = normalizeKey(typeof opts?.goal === "string" ? opts.goal : "");
  if (!key)
    return { ok: true, goal_key: "", limit, ideas: [], conditions: [], relations: [], counts: { ideas: 0, conditions: 0, relations: 0 } };
  let candidates = [];
  if (ideaFtsExists(db)) {
    candidates = db.query("SELECT i.* FROM idea_fts f JOIN ideas i ON i.rowid=f.rowid WHERE idea_fts MATCH ? ORDER BY rank LIMIT ?").all(ftsQueryV2(key), limit);
  } else {
    const like = `%${key}%`;
    candidates = db.query("SELECT * FROM ideas WHERE canonical_key LIKE ? OR title LIKE ? OR summary LIKE ? OR rationale LIKE ? ORDER BY updated_at DESC LIMIT ?").all(like, like, like, like, limit);
  }
  if (candidates.length === 0)
    return { ok: true, goal_key: key, limit, ideas: [], conditions: [], relations: [], counts: { ideas: 0, conditions: 0, relations: 0 } };
  const selected = new Map;
  for (const c of candidates) {
    if (!selected.has(c.id))
      selected.set(c.id, c);
    if (selected.size >= limit)
      break;
  }
  if (selected.size < limit) {
    outer:
      for (const c of candidates) {
        const rels = db.query("SELECT * FROM idea_relations WHERE idea_id=? OR (target_type='idea' AND target_id=?)").all(c.id, c.id);
        for (const rel of rels) {
          if (rel.target_type !== "idea")
            continue;
          const nid = rel.idea_id === c.id ? rel.target_id : rel.idea_id;
          if (!selected.has(nid)) {
            const nrow = db.query("SELECT * FROM ideas WHERE id=?").get(nid);
            if (nrow)
              selected.set(nid, nrow);
            if (selected.size >= limit)
              break outer;
          }
        }
      }
  }
  const selectedIds = [...selected.keys()];
  const ideas = selectedIds.map((id) => {
    const row = selected.get(id);
    const d = derivedStateFor(db, id);
    return { id: row.id, key: row.canonical_key, title: row.title, summary: row.summary, status: row.status, derived: d.derived, blockers: d.blockers, updated_at: row.updated_at };
  });
  const boundedIdeas = ideas.slice(0, limit);
  const condRows = [];
  if (selectedIds.length > 0) {
    const marks = selectedIds.map(() => "?").join(",");
    const rows = db.query(`SELECT DISTINCT c.canonical_key AS ck, c.description AS cd, c.satisfied AS cs, c.satisfied_by AS csb
       FROM idea_relations r JOIN conditions c ON c.id = r.target_id
       WHERE r.idea_id IN (${marks}) AND r.kind='requires' AND r.target_type='condition' AND c.satisfied=0
       ORDER BY c.canonical_key LIMIT 8`).all(...selectedIds);
    for (const r of rows)
      condRows.push({ key: r.ck, description: r.cd, satisfied: r.cs === 1, satisfied_by: r.csb });
  }
  const relRows = [];
  if (selectedIds.length > 0) {
    const marks = selectedIds.map(() => "?").join(",");
    const rows = db.query(`SELECT DISTINCT r.kind AS rk, r.target_type AS rt, si.canonical_key AS sk, ti.canonical_key AS tik, tc.canonical_key AS tck
       FROM idea_relations r
       JOIN ideas si ON si.id = r.idea_id
       LEFT JOIN ideas ti ON ti.id = r.target_id AND r.target_type='idea'
       LEFT JOIN conditions tc ON tc.id = r.target_id AND r.target_type='condition'
       WHERE r.idea_id IN (${marks}) OR (r.target_type='idea' AND r.target_id IN (${marks}))
       ORDER BY r.id LIMIT 12`).all(...selectedIds, ...selectedIds);
    for (const r of rows) {
      const targetKey = r.rt === "idea" ? r.tik : r.tck;
      relRows.push({ idea: r.sk, kind: r.rk, target: (r.rt === "idea" ? "idea:" : "condition:") + (targetKey ?? "") });
    }
  }
  return {
    ok: true,
    goal_key: key,
    limit,
    ideas: boundedIdeas,
    conditions: condRows.slice(0, 8),
    relations: relRows.slice(0, 12),
    counts: { ideas: boundedIdeas.length, conditions: condRows.length, relations: relRows.length }
  };
}

// project-memory.ts
var PRIMARY_AGENTS = (process.env.PROJECT_MEMORY_PRIMARY_AGENTS ?? "orchestrator,orchestrator-goal").split(",").map((s) => s.trim()).filter(Boolean);
var project_memory_default = {
  id: "project-memory",
  server: async (ctx) => {
    const directory = ctx?.directory;
    if (!directory)
      return {};
    let handle = null;
    let fts = false;
    try {
      handle = openHandle(path2.join(directory, ".opencode", "memory.sqlite"));
      fts = ftsAvailable(handle.db);
      bootstrap(handle.db, directory, fts);
      ensureV2Schema(handle.db, fts);
    } catch (e) {
      console.error("[project-memory] init failed:", e);
      handle = null;
    }
    const isPrimary = (agent) => PRIMARY_AGENTS.includes(agent);
    return {
      tool: {
        project_work_check: tool({
          description: "Check durable project work that future sessions could meaningfully reuse. Do not use for trivial, transient, or one-shot actions. Returns NEW, PARTIAL, COVERED, IN_PROGRESS, or MEMORY_ERROR.",
          args: {
            work: tool.schema.string().describe("Work to check in project memory"),
            claim: tool.schema.boolean().optional().describe("Reserve NEW/PARTIAL work (default true)"),
            reclaim_ticket: tool.schema.string().optional().describe("Reclaim this orphaned IN_PROGRESS ticket"),
            reclaim_owner: tool.schema.string().optional().describe("Expected current owner of the reclaim target")
          },
          execute: async (args, tctx) => {
            if (!handle)
              return JSON.stringify({ status: "MEMORY_ERROR", canonical_key: normalizeKey(args.work), error: { message: "project memory unavailable", cause: "init failed" } }, null, 2);
            const agent = tctx.agent ?? "";
            const claim = args.claim !== false;
            if (args.reclaim_ticket && !isPrimary(agent)) {
              return JSON.stringify({ status: "ERROR", error: "reclaim requires a primary agent (" + PRIMARY_AGENTS.join(", ") + "); subagents may not reclaim claims" });
            }
            if (args.reclaim_ticket && !args.reclaim_owner) {
              return JSON.stringify({ status: "ERROR", error: "reclaim_owner is required with reclaim_ticket (pass the owner_session from the IN_PROGRESS preflight result)" });
            }
            if (claim && !isPrimary(agent)) {
              return JSON.stringify({ status: "ERROR", error: `claim requires a primary agent (${PRIMARY_AGENTS.join(", ")}); subagents may query with claim=false` });
            }
            const { handle: h, result } = preflightSafe(handle, { task: args.work, claim, ownerSession: tctx.sessionID, projectDir: directory, fts, reclaimTicket: args.reclaim_ticket, reclaimOwner: args.reclaim_owner });
            handle = h;
            return JSON.stringify(result, null, 2);
          }
        }),
        project_work_save: tool({
          description: "Save durable reusable results and evidence from project work. Do not save trivial, transient, or one-shot information.",
          args: {
            ticket: tool.schema.string().describe("Work item id from project_work_check"),
            status: tool.schema.enum(["done", "blocked", "failed"]),
            summary: tool.schema.string().optional().describe("Result summary"),
            unresolved: tool.schema.string().optional().describe("Remaining unresolved delta, if any"),
            evidence: tool.schema.array(tool.schema.string()).optional().describe("File paths / report ids produced")
          },
          execute: async (args, tctx) => {
            if (!handle)
              return JSON.stringify({ ok: false, error: "project memory unavailable" });
            if (!isPrimary(tctx.agent ?? ""))
              return JSON.stringify({ ok: false, error: "only primary agents can record results" });
            try {
              const res = recordResult(handle.db, { ...args, ownerSession: tctx.sessionID });
              if (res.ok)
                syncAllFts(handle.db, fts);
              return JSON.stringify(res);
            } catch (e) {
              return JSON.stringify({ ok: false, error: `record failed: ${e?.message ?? e}` });
            }
          }
        }),
        project_failure_save: tool({
          description: "Save a stable or reproducible failure only when it has an actionable lesson likely to prevent repeated meaningful work. Ordinary failed attempts belong in the work result. Persisted in SQLite (canonical operational memory); available to primary agents and subagent.",
          args: {
            symptom: tool.schema.string().describe("What failed"),
            cause: tool.schema.string().describe("Known cause, or unknown"),
            lesson: tool.schema.string().describe("What future agents should do or avoid"),
            topic: tool.schema.string().optional().describe("Optional retrieval topic")
          },
          execute: async (args, tctx) => {
            if (!handle)
              return JSON.stringify({ ok: false, error: "project memory unavailable" });
            if (!canAppendFailure(tctx.agent ?? "", PRIMARY_AGENTS))
              return JSON.stringify({ ok: false, error: "agent is not allowed to record project failures" });
            try {
              const res = recordFailure(handle.db, args);
              syncAllFts(handle.db, fts);
              return JSON.stringify({ ok: true, ...res });
            } catch (e) {
              return JSON.stringify({ ok: false, error: `failure record failed: ${e?.message ?? e}` });
            }
          }
        }),
        project_idea_save: tool({
          description: "Save or update a durable idea, prerequisite and its relations. validated/disproven require non-empty evidence; satisfied conditions require explicit provenance; satisfies only works from a validated idea with evidence. Invalid input is atomic: ok:false with no partial writes.",
          args: {
            idea: tool.schema.object({
              key: tool.schema.string().optional(),
              id: tool.schema.string().optional(),
              title: tool.schema.string().optional(),
              summary: tool.schema.string().optional(),
              status: tool.schema.enum(["proposed", "testing", "validated", "disproven", "dormant"]).optional(),
              rationale: tool.schema.string().optional(),
              evidence: tool.schema.string().optional()
            }).optional().describe("Idea to save or update"),
            conditions: tool.schema.array(tool.schema.object({
              key: tool.schema.string(),
              description: tool.schema.string().optional(),
              satisfied: tool.schema.boolean().optional(),
              satisfied_by: tool.schema.string().optional()
            })).optional().describe("Prerequisites to save or update"),
            relations: tool.schema.array(tool.schema.object({
              idea: tool.schema.string(),
              kind: tool.schema.enum(RELATION_KINDS),
              target: tool.schema.string()
            })).optional().describe("Relations to add; targets must exist already or be explicitly declared in this call"),
            satisfies: tool.schema.array(tool.schema.string()).optional().describe("Condition keys this validated idea satisfies"),
            remove_relations: tool.schema.array(tool.schema.object({
              idea: tool.schema.string(),
              kind: tool.schema.enum(RELATION_KINDS),
              target: tool.schema.string()
            })).optional().describe("Relations to remove")
          },
          execute: async (args, tctx) => {
            if (!handle)
              return JSON.stringify({ ok: false, error: "project memory unavailable" });
            if (!isPrimary(tctx.agent ?? ""))
              return JSON.stringify({ ok: false, error: "only primary agents can mutate idea memory (subagents report hypotheses to the orchestrator)" });
            try {
              return JSON.stringify(ideaRecord(handle.db, args));
            } catch (e) {
              return JSON.stringify({ ok: false, error: `idea_save failed: ${e?.message ?? e}` });
            }
          }
        }),
        project_idea_search: tool({
          description: "Search durable project ideas, prerequisites and relations relevant to exploratory work.",
          args: {
            query: tool.schema.string().describe("Goal/topic to search for in idea memory"),
            limit: tool.schema.number().int().min(1).max(20).optional().describe("Max ideas to return (default 8)")
          },
          execute: async (args, tctx) => {
            if (!handle)
              return JSON.stringify({ ok: false, error: "project memory unavailable" });
            if (tctx.agent === "subagent")
              return JSON.stringify({ ok: false, error: "subagents may not search idea memory (report hypotheses to the orchestrator)" });
            try {
              return JSON.stringify(projectFrontier(handle.db, { goal: args.query, limit: args.limit }));
            } catch (e) {
              return JSON.stringify({ ok: false, error: `idea_search failed: ${e?.message ?? e}` });
            }
          }
        })
      }
    };
  }
};
export {
  project_memory_default as default
};
