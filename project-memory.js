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
  reclaimed_at TEXT
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
  const sql = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='work_items'").get()?.sql ?? "";
  if (sql.includes("'failed'"))
    return;
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.transaction(() => {
      const sql2 = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='work_items'").get()?.sql ?? "";
      if (sql2.includes("'failed'"))
        return;
      db.exec("CREATE TABLE work_items_new (id TEXT PRIMARY KEY, canonical_key TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('new','in_progress','done','blocked','covered','failed')), summary TEXT DEFAULT '', unresolved TEXT DEFAULT '', notes TEXT DEFAULT '', owner_session TEXT, parent_key TEXT, source TEXT DEFAULT 'agent', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reclaimed_at TEXT)");
      db.run("INSERT INTO work_items_new (rowid, id, canonical_key, status, summary, unresolved, notes, owner_session, parent_key, source, created_at, updated_at, reclaimed_at) SELECT rowid, id, canonical_key, status, summary, unresolved, notes, owner_session, parent_key, source, created_at, updated_at, NULL FROM work_items");
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
function stripMarkdown(s) {
  return s.replace(/\*\*/g, "").replace(/`/g, "").trim();
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
  if (fts) {
    return db.query("SELECT path FROM markdown_fts WHERE markdown_fts MATCH ? ORDER BY rank LIMIT 6").all(ftsQuery(key)).map((r) => r.path);
  }
  return db.query("SELECT path FROM markdown_fts WHERE path LIKE ? OR title LIKE ? LIMIT 6").all(`%${key}%`, `%${key}%`).map((r) => r.path);
}
var MIN_SEMANTIC_OVERLAP = 3;
var STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "was",
  "were",
  "will",
  "with",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "not",
  "but",
  "this",
  "these",
  "those",
  "its",
  "our",
  "your",
  "their",
  "we",
  "you",
  "they",
  "he",
  "she",
  "i",
  "me",
  "my",
  "him",
  "her",
  "us",
  "them",
  "then",
  "than",
  "so",
  "if",
  "while",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "what",
  "why",
  "how",
  "all",
  "any",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "only",
  "own",
  "same",
  "too",
  "very",
  "just",
  "also",
  "even",
  "di",
  "da",
  "e",
  "a",
  "il",
  "la",
  "le",
  "i",
  "gli",
  "lo",
  "un",
  "una",
  "uno",
  "del",
  "della",
  "dei",
  "delle",
  "nel",
  "nella",
  "nei",
  "nelle",
  "con",
  "su",
  "per",
  "che",
  "chi",
  "cui",
  "piu",
  "meno",
  "non",
  "si",
  "se",
  "quando",
  "dove",
  "come",
  "cosa",
  "questo",
  "questa",
  "questi",
  "queste",
  "quello",
  "quella",
  "quelli",
  "quelle"
]);
function sigTokens(s) {
  const out = new Set;
  for (const t of normalizeKey(s).split(" ").filter(Boolean)) {
    if (t.length >= 3 && !STOPWORDS.has(t))
      out.add(t);
  }
  return out;
}
function tokenOverlap(a, b) {
  const sa = sigTokens(a);
  const sb = sigTokens(b);
  let n = 0;
  for (const t of sa)
    if (sb.has(t))
      n++;
  return n;
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
  if (item.reclaimed_at)
    return { ok: false, reason: `ticket ${opts.ticket} was already reclaimed at ${item.reclaimed_at}` };
  const key = normalizeKey(opts.task);
  const overlap = tokenOverlap(key, `${item.canonical_key} ${item.summary} ${item.unresolved}`);
  if (key !== item.canonical_key && overlap < MIN_SEMANTIC_OVERLAP) {
    return { ok: false, reason: `reclaim denied: requested work does not correspond to ticket ${opts.ticket} (canonical_key=${item.canonical_key}, overlap=${overlap})` };
  }
  const now = nowIso();
  const prevOwner = item.owner_session;
  const historyNote = `[reclaim] ${now} by ${opts.ownerSession} from ${prevOwner ?? "none"}`;
  const notes = [item.notes, historyNote].filter(Boolean).join(`
`);
  const res = db.run("UPDATE work_items SET owner_session=?, notes=?, reclaimed_at=?, updated_at=? WHERE id=? AND status='in_progress' AND reclaimed_at IS NULL", [opts.ownerSession, notes, now, now, opts.ticket]);
  if (res.changes === 0) {
    const cur = db.query("SELECT * FROM work_items WHERE id=?").get(opts.ticket);
    if (!cur)
      return { ok: false, reason: `ticket not found: ${opts.ticket}` };
    if (cur.status !== "in_progress")
      return { ok: false, reason: `ticket ${opts.ticket} is not in_progress (status=${cur.status})` };
    return { ok: false, reason: `reclaim lost: ticket ${opts.ticket} was already reclaimed by ${cur.owner_session ?? "?"} at ${cur.reclaimed_at ?? "?"}` };
  }
  return { ok: true, item: db.query("SELECT * FROM work_items WHERE id=?").get(opts.ticket), previous_owner: prevOwner, reclaimed_at: now };
}
function preflight(db, opts) {
  if (opts.reclaimTicket) {
    const r = reclaimWorkItem(db, { ticket: opts.reclaimTicket, task: opts.task, ownerSession: opts.ownerSession });
    if (r.ok) {
      const key = normalizeKey(opts.task);
      const readFirst = readFirstFor(db, key, opts.fts);
      const sc = ensureScratch(projectScratchBase(opts.projectDir), r.item.id);
      return { status: "NEW", ticket: r.item.id, canonical_key: r.item.canonical_key, requested_key: key, matched_key: r.item.canonical_key, match_reason: "reclaimed", summary: r.item.summary, established: r.item.summary ? [r.item.summary] : [], do_not_repeat: [], unresolved: r.item.unresolved ? [r.item.unresolved] : [], evidence: evidenceFor(db, r.item.id).slice(0, 10), read_first: readFirst, scratch: sc, owner_session: opts.ownerSession, candidates: [], reclaimed: { previous_owner: r.previous_owner, reclaimed_at: r.reclaimed_at } };
    }
    const res = preflightCore(db, { task: opts.task, claim: opts.claim, ownerSession: opts.ownerSession, projectDir: opts.projectDir, fts: opts.fts });
    return { ...res, reclaim_error: r.reason };
  }
  return preflightCore(db, { task: opts.task, claim: opts.claim, ownerSession: opts.ownerSession, projectDir: opts.projectDir, fts: opts.fts });
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
      return { status: "IN_PROGRESS", canonical_key: key, requested_key: key, matched_key: item.canonical_key, match_reason: matchSrc ?? "exact", ticket: item.id, owner_session: item.owner_session ?? undefined, summary: item.summary, established: [], do_not_repeat: [], unresolved: item.unresolved ? [item.unresolved] : [], evidence: cap(evidenceFor(db, item.id), 10), read_first: readFirst, candidates: [] };
    }
    if (item.status === "done" || item.status === "covered" || item.status === "blocked") {
      const unresolved = item.unresolved ? [item.unresolved] : [];
      if (item.status === "blocked")
        unresolved.unshift(`BLOCKED: ${item.summary}`);
      return { status: "COVERED", canonical_key: key, requested_key: key, matched_key: item.canonical_key, match_reason: matchSrc ?? "exact", ticket: item.id, summary: item.summary, established: [item.summary].filter(Boolean), do_not_repeat: [`Covered by ${item.canonical_key} (${item.id})`], unresolved, evidence: cap(evidenceFor(db, item.id), 10), read_first: readFirst, candidates: [] };
    }
    if (opts.claim) {
      const priorNote = item.status === "failed" ? "prior failed attempt: " + [item.summary, item.notes].filter(Boolean).join(" | ") : "";
      const c = claimWorkItem(db, { canonicalKey: key, summary: opts.task, unresolved: opts.task, notes: priorNote, ownerSession: opts.ownerSession, source: "agent" });
      if (c.ok) {
        const sc = ensureScratch(scratchBase, c.item.id);
        return { status: "NEW", ticket: c.item.id, canonical_key: key, requested_key: key, matched_key: c.item.canonical_key, match_reason: "created", established: [], do_not_repeat: [], unresolved: [opts.task], evidence: [], read_first: readFirst, scratch: sc, candidates: [] };
      }
      return { status: "IN_PROGRESS", canonical_key: key, requested_key: key, matched_key: c.inProgress.canonical_key, match_reason: "claim-conflict", ticket: c.inProgress.id, owner_session: c.inProgress.owner_session ?? undefined, summary: c.inProgress.summary, established: [], do_not_repeat: [], unresolved: [], evidence: cap(evidenceFor(db, c.inProgress.id), 10), read_first: readFirst, candidates: [] };
    }
    return { status: "NEW", canonical_key: key, requested_key: key, match_reason: "none", established: [], do_not_repeat: [], unresolved: [opts.task], evidence: [], read_first: readFirst, candidates: [] };
  }
  let reuseDenied = [];
  let reuseConsidered = [];
  const inProgressCandidates = candidates.filter((c) => c.status === "in_progress");
  if (inProgressCandidates.length > 0) {
    const scored = inProgressCandidates.map((c) => ({ c, overlap: tokenOverlap(key, `${c.canonical_key} ${c.summary} ${c.unresolved}`) }));
    const best = scored.reduce((a, b) => b.overlap > a.overlap || b.overlap === a.overlap && (b.c.fts_rank ?? 0) < (a.c.fts_rank ?? 0) ? b : a);
    reuseConsidered = scored.map(({ c, overlap }) => ({ id: c.id, key: c.canonical_key, overlap, selected: c.id === best.c.id }));
    if (best.overlap >= MIN_SEMANTIC_OVERLAP) {
      const c = best.c;
      return { status: "IN_PROGRESS", canonical_key: key, requested_key: key, matched_key: c.canonical_key, match_reason: "semantic-continuation", match_score: best.overlap, ticket: c.id, owner_session: c.owner_session ?? undefined, summary: c.summary, established: [], do_not_repeat: [], unresolved: c.unresolved ? [c.unresolved] : [], evidence: cap(evidenceFor(db, c.id), 10), read_first: readFirst, candidates: [], reuse_considered: reuseConsidered };
    }
    reuseDenied = scored.map(({ c, overlap }) => ({ id: c.id, key: c.canonical_key, overlap }));
  }
  const doneCandidates = candidates.filter((c) => c.status === "done" || c.status === "covered" || c.status === "blocked");
  if (doneCandidates.length > 0) {
    const established = doneCandidates.map((c) => `${c.canonical_key}: ${c.summary}`);
    const dnr = doneCandidates.map((c) => `Covered by ${c.canonical_key} (${c.id})`);
    const ev = cap(doneCandidates.flatMap((c) => evidenceFor(db, c.id)), 10);
    const cand = doneCandidates.map((c) => ({ key: c.canonical_key, status: c.status, id: c.id }));
    if (opts.claim) {
      const c = claimWorkItem(db, { canonicalKey: key, summary: opts.task, unresolved: opts.task, notes: `delta of ${doneCandidates[0].canonical_key}`, ownerSession: opts.ownerSession, parentKey: doneCandidates[0].canonical_key, source: "agent" });
      if (c.ok) {
        const sc = ensureScratch(scratchBase, c.item.id);
        return { status: "PARTIAL", ticket: c.item.id, canonical_key: key, requested_key: key, matched_key: c.item.canonical_key, match_reason: "parent", established, do_not_repeat: dnr, unresolved: [opts.task], evidence: ev, read_first: readFirst, scratch: sc, candidates: cand, reuse_denied: reuseDenied.length ? reuseDenied : undefined, reuse_considered: reuseConsidered.length ? reuseConsidered : undefined };
      }
      return { status: "IN_PROGRESS", canonical_key: key, requested_key: key, matched_key: c.inProgress.canonical_key, match_reason: "claim-conflict", ticket: c.inProgress.id, owner_session: c.inProgress.owner_session ?? undefined, summary: c.inProgress.summary, established, do_not_repeat: dnr, unresolved: [], evidence: ev, read_first: readFirst, candidates: cand, reuse_denied: reuseDenied.length ? reuseDenied : undefined, reuse_considered: reuseConsidered.length ? reuseConsidered : undefined };
    }
    return { status: "PARTIAL", canonical_key: key, requested_key: key, match_reason: "none", established, do_not_repeat: dnr, unresolved: [opts.task], evidence: ev, read_first: readFirst, candidates: cand, reuse_denied: reuseDenied.length ? reuseDenied : undefined, reuse_considered: reuseConsidered.length ? reuseConsidered : undefined };
  }
  if (opts.claim) {
    const c = claimWorkItem(db, { canonicalKey: key, summary: opts.task, unresolved: opts.task, ownerSession: opts.ownerSession, source: "agent" });
    if (c.ok) {
      const sc = ensureScratch(scratchBase, c.item.id);
      return { status: "NEW", ticket: c.item.id, canonical_key: key, requested_key: key, matched_key: c.item.canonical_key, match_reason: "created", established: [], do_not_repeat: [], unresolved: [opts.task], evidence: [], read_first: readFirst, scratch: sc, candidates: [], reuse_denied: reuseDenied.length ? reuseDenied : undefined, reuse_considered: reuseConsidered.length ? reuseConsidered : undefined };
    }
    return { status: "IN_PROGRESS", canonical_key: key, requested_key: key, matched_key: c.inProgress.canonical_key, match_reason: "claim-conflict", ticket: c.inProgress.id, owner_session: c.inProgress.owner_session ?? undefined, summary: c.inProgress.summary, established: [], do_not_repeat: [], unresolved: [], evidence: cap(evidenceFor(db, c.inProgress.id), 10), read_first: readFirst, candidates: [], reuse_denied: reuseDenied.length ? reuseDenied : undefined, reuse_considered: reuseConsidered.length ? reuseConsidered : undefined };
  }
  return { status: "NEW", canonical_key: key, requested_key: key, match_reason: "none", established: [], do_not_repeat: [], unresolved: [opts.task], evidence: [], read_first: readFirst, candidates: [], reuse_denied: reuseDenied.length ? reuseDenied : undefined, reuse_considered: reuseConsidered.length ? reuseConsidered : undefined };
}
function recordResult(db, opts) {
  const item = db.query("SELECT * FROM work_items WHERE id=?").get(opts.ticket);
  if (!item)
    return { ok: false, reason: `ticket not found: ${opts.ticket}` };
  const now = nowIso();
  const status = ["done", "blocked", "failed"].includes(opts.status) ? opts.status : "done";
  db.run("UPDATE work_items SET status=?, summary=COALESCE(?, summary), unresolved=COALESCE(?, unresolved), updated_at=? WHERE id=?", [status, opts.summary ?? null, opts.unresolved ?? null, now, opts.ticket]);
  for (const p of opts.evidence ?? []) {
    const exists = db.query("SELECT 1 FROM evidence WHERE work_item_id=? AND path=?").get(opts.ticket, p);
    if (!exists)
      db.run("INSERT INTO evidence (work_item_id, path, kind, note) VALUES (?,?,?,?)", [opts.ticket, p, "file", ""]);
  }
  for (const f of opts.facts ?? []) {
    db.run("INSERT INTO facts (key, value, source, updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, source=excluded.source, updated_at=excluded.updated_at", [f.key, f.value, `ticket:${opts.ticket}`, now]);
  }
  return { ok: true, item: db.query("SELECT * FROM work_items WHERE id=?").get(opts.ticket) };
}
function appendFailure(db, opts) {
  const d = new Date;
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const id = `FAIL-${ymd}-${ulid().slice(-8)}`;
  const dir = path.join(opts.projectDir, ".opencode");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "FAILURES.md");
  const block = `
## ${id} \u2014 ${new Date().toISOString()}
- **Sintomo**: ${opts.symptom}
- **Causa**: ${opts.cause}
- **Lezione**: ${opts.lesson}
`;
  fs.appendFileSync(file, block, "utf8");
  const key = normalizeKey(id);
  const c = claimWorkItem(db, { canonicalKey: key, summary: opts.lesson, unresolved: "", notes: `symptom: ${opts.symptom}; cause: ${opts.cause}`, ownerSession: "system", source: "agent" });
  const item = c.ok ? c.item : c.inProgress;
  db.run("UPDATE work_items SET status='done', summary=?, notes=?, updated_at=? WHERE id=?", [opts.lesson, `symptom: ${opts.symptom}; cause: ${opts.cause}`, nowIso(), item.id]);
  db.run("INSERT INTO evidence (work_item_id, path, kind, note) VALUES (?,?,?,?)", [item.id, file, "failures", id]);
  if (opts.topic) {
    db.run("INSERT INTO aliases (work_item_id, alias) VALUES (?,?) ON CONFLICT(alias) DO NOTHING", [item.id, normalizeKey(opts.topic)]);
  }
  return { id, path: file };
}
var GOAL_START = "<!-- PROJECT-MEMORY:CURRENT-START -->";
var GOAL_END = "<!-- PROJECT-MEMORY:CURRENT-END -->";
function checkpointGoal(projectDir, content) {
  const dir = path.join(projectDir, ".opencode");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "goal-state.md");
  let existing = "";
  if (fs.existsSync(file))
    existing = fs.readFileSync(file, "utf8");
  const s = existing.indexOf(GOAL_START);
  const e = existing.indexOf(GOAL_END);
  let next;
  if (s === -1 || e === -1 || e < s) {
    const sep = existing.length > 0 && !existing.endsWith(`
`) ? `
` : "";
    next = existing + sep + GOAL_START + `
` + content + `
` + GOAL_END + `
`;
  } else {
    next = existing.slice(0, s + GOAL_START.length) + `
` + content + `
` + existing.slice(e);
  }
  const tmp = path.join(dir, `.goal-state.md.tmp-${process.pid}`);
  fs.writeFileSync(tmp, next, "utf8");
  fs.renameSync(tmp, file);
  return { path: file, bytes: Buffer.byteLength(next) };
}
function mapStatus(statoLine) {
  const s = statoLine.toLowerCase();
  if (s.includes("bloccato"))
    return "blocked";
  if (s.includes("dead"))
    return "done";
  if (s.includes("fatto"))
    return "done";
  return "new";
}
function importVectors(db, file) {
  const content = fs.readFileSync(file, "utf8");
  const sections = [];
  let current = null;
  for (const line of content.split(`
`)) {
    if (line.startsWith("### ")) {
      current = { title: line.slice(4).trim(), lines: [] };
      sections.push(current);
    } else if (current)
      current.lines.push(line);
  }
  for (const s of sections) {
    const key = normalizeKey(s.title.split("(")[0]);
    const stato = s.lines.find((l) => l.includes("**Stato**")) ?? "";
    const sintesi = s.lines.find((l) => l.includes("**Sintesi**")) ?? "";
    const evidenza = s.lines.find((l) => l.includes("**Evidenza**")) ?? "";
    const nonRipetere = s.lines.find((l) => l.includes("**NON ripetere**")) ?? "";
    const riap = s.lines.find((l) => l.includes("**Riapertura**")) ?? "";
    const status = mapStatus(stato);
    const summary = stripMarkdown(sintesi.replace(/^.*?\*\*Sintesi\*\*\s*:?\s*/, "")).slice(0, 500);
    const notes = [
      nonRipetere ? `NON RIPETERE: ${stripMarkdown(nonRipetere.replace(/^.*?\*\*NON ripetere\*\*\s*:?\s*/, "")).slice(0, 500)}` : "",
      riap ? `Riapertura: ${stripMarkdown(riap.replace(/^.*?\*\*Riapertura\*\*\s*:?\s*/, "")).slice(0, 300)}` : ""
    ].filter(Boolean).join(`
`);
    const unresolved = riap ? stripMarkdown(riap.replace(/^.*?\*\*Riapertura\*\*\s*:?\s*/, "")).slice(0, 300) : "";
    const id = ulid();
    const now = nowIso();
    db.run("INSERT INTO work_items (id, canonical_key, status, summary, unresolved, notes, owner_session, parent_key, source, created_at, updated_at) VALUES (?,?,?,?,?,?,NULL,NULL,'bootstrap:VECTORS.md',?,?)", [id, key, status, summary, unresolved, notes, now, now]);
    db.run("INSERT INTO aliases (work_item_id, alias) VALUES (?,?) ON CONFLICT(alias) DO NOTHING", [id, normalizeKey(s.title)]);
    db.run("INSERT INTO evidence (work_item_id, path, kind, note) VALUES (?,?,?,?)", [id, file, "vectors", s.title]);
    const all = s.lines.join(`
`);
    for (const m of all.matchAll(/FAIL-\d+/g)) {
      db.run("INSERT INTO aliases (work_item_id, alias) VALUES (?,?) ON CONFLICT(alias) DO NOTHING", [id, normalizeKey(m[0])]);
      db.run("INSERT INTO evidence (work_item_id, path, kind, note) VALUES (?,?,?,?)", [id, m[0], "fail", ""]);
    }
    for (const m of all.matchAll(/report_[a-z0-9_]+\.md/g)) {
      db.run("INSERT INTO evidence (work_item_id, path, kind, note) VALUES (?,?,?,?)", [id, m[0], "report", ""]);
    }
  }
}
function importFailures(db, file) {
  const content = fs.readFileSync(file, "utf8");
  const sections = [];
  let current = null;
  for (const line of content.split(`
`)) {
    if (line.startsWith("## ")) {
      current = { title: line.slice(3).trim(), lines: [] };
      sections.push(current);
    } else if (current)
      current.lines.push(line);
  }
  for (const s of sections) {
    const m = s.title.match(/FAIL-\d+/i);
    if (!m)
      continue;
    const key = normalizeKey(m[0]);
    const first = s.lines.find((l) => l.trim().length > 0) ?? "";
    const summary = stripMarkdown(first).slice(0, 300);
    const now = nowIso();
    const existing = db.query("SELECT * FROM work_items WHERE canonical_key=?").get(key);
    if (existing) {
      db.run("UPDATE work_items SET summary=?, updated_at=? WHERE id=?", [summary || existing.summary, now, existing.id]);
      db.run("INSERT INTO evidence (work_item_id, path, kind, note) VALUES (?,?,?,?)", [existing.id, file, "failures", s.title]);
    } else {
      const id = ulid();
      db.run("INSERT INTO work_items (id, canonical_key, status, summary, unresolved, notes, owner_session, parent_key, source, created_at, updated_at) VALUES (?,?,'done',?,'','',NULL,NULL,'bootstrap:FAILURES.md',?,?)", [id, key, summary, now, now]);
      db.run("INSERT INTO aliases (work_item_id, alias) VALUES (?,?) ON CONFLICT(alias) DO NOTHING", [id, key]);
      db.run("INSERT INTO evidence (work_item_id, path, kind, note) VALUES (?,?,?,?)", [id, file, "failures", s.title]);
    }
  }
}
function importReportsIndex(db, file, projectDir) {
  const content = fs.readFileSync(file, "utf8");
  for (const line of content.split(`
`)) {
    const m = line.match(/^\|\s*(report_[a-z0-9_]+\.md)\s*\|\s*(.*?)\s*\|\s*(\w+)\s*\|/);
    if (!m)
      continue;
    const report = m[1];
    const sintesi = m[2];
    const stato = m[3].toLowerCase();
    const key = normalizeKey(report.replace(/\.md$/, ""));
    const status = stato.includes("fatto") || stato.includes("dead") ? "done" : "new";
    const id = ulid();
    const now = nowIso();
    db.run("INSERT INTO work_items (id, canonical_key, status, summary, unresolved, notes, owner_session, parent_key, source, created_at, updated_at) VALUES (?,?,?,?,'','',NULL,NULL,'bootstrap:REPORTS_INDEX.md',?,?)", [id, key, status, sintesi.slice(0, 300), now, now]);
    db.run("INSERT INTO aliases (work_item_id, alias) VALUES (?,?) ON CONFLICT(alias) DO NOTHING", [id, normalizeKey(report)]);
    db.run("INSERT INTO evidence (work_item_id, path, kind, note) VALUES (?,?,?,?)", [id, path.join(projectDir, ".opencode", report), "report", ""]);
  }
}
function bootstrap(db, projectDir, fts) {
  const dir = path.join(projectDir, ".opencode");
  const sources = [];
  const tx = db.transaction(() => {
    const prev = db.query("SELECT id FROM work_items WHERE source LIKE 'bootstrap:%'").all();
    for (const r of prev)
      db.run("DELETE FROM work_items WHERE id=?", [r.id]);
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
    const vectors = path.join(dir, "VECTORS.md");
    if (fs.existsSync(vectors))
      importVectors(db, vectors);
    const failures = path.join(dir, "FAILURES.md");
    if (fs.existsSync(failures))
      importFailures(db, failures);
    const reportsIndex = path.join(dir, "REPORTS_INDEX.md");
    if (fs.existsSync(reportsIndex))
      importReportsIndex(db, reportsIndex, projectDir);
    const goalState = path.join(dir, "goal-state.md");
    if (fs.existsSync(goalState)) {
      const content = fs.readFileSync(goalState, "utf8");
      db.run("INSERT INTO facts (key, value, source, updated_at) VALUES ('goal-state', ?, 'bootstrap', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, source=excluded.source, updated_at=excluded.updated_at", [content.slice(0, 1e5), nowIso()]);
    }
  });
  tx();
  syncAllFts(db, fts);
  const n = db.query("SELECT COUNT(*) AS n FROM work_items WHERE source LIKE 'bootstrap:%'").get().n;
  return { imported: n, sources };
}
function gateDecision(db, opts) {
  const args = opts.args ?? {};
  if (args.task_id)
    return { action: "allow", reason: "steering" };
  const st = args.subagent_type;
  if (st === "vision" || st === "verifier")
    return { action: "allow", reason: `exempt: ${st}` };
  const claim = db.query("SELECT * FROM work_items WHERE owner_session=? AND status='in_progress' ORDER BY updated_at DESC LIMIT 1").get(opts.sessionID);
  if (claim)
    return { action: "allow", reason: "preflight ticket", ticket: claim.id };
  return { action: "block", reason: "project-memory gate: no preflight ticket for this session. Run project_preflight(task=...) before delegating. (Set PROJECT_MEMORY_GATE=warn to relax.)" };
}
function bindClaimToChild(db, parentID, childSessionID) {
  db.run("UPDATE work_items SET owner_session=?, updated_at=? WHERE id=(SELECT id FROM work_items WHERE owner_session=? AND status='in_progress' ORDER BY updated_at DESC LIMIT 1)", [childSessionID, nowIso(), parentID]);
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
function gateSafe(handle, opts) {
  const args = opts.args ?? {};
  if (args.task_id)
    return { handle, decision: { action: "allow", reason: "steering" } };
  const st = args.subagent_type;
  if (st === "vision" || st === "verifier")
    return { handle, decision: { action: "allow", reason: `exempt: ${st}` } };
  try {
    const { handle: h, value } = runWithRecovery(handle, (db) => gateDecision(db, opts));
    return { handle: h, decision: value };
  } catch {
    return { handle, decision: { action: "block", reason: "Project memory preflight is unavailable or inconclusive. Delegation blocked to avoid repeating or conflicting work." } };
  }
}

// project-memory.ts
var PRIMARY_AGENTS = (process.env.PROJECT_MEMORY_PRIMARY_AGENTS ?? "orchestrator,orchestrator-goal").split(",").map((s) => s.trim()).filter(Boolean);
var GATE_MODE = process.env.PROJECT_MEMORY_GATE ?? "strict";
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
    } catch (e) {
      console.error("[project-memory] init failed:", e);
      handle = null;
    }
    const warnCalls = new Set;
    const isPrimary = (agent) => PRIMARY_AGENTS.includes(agent);
    return {
      tool: {
        project_preflight: tool({
          description: "Check project memory before investigative delegation. Returns COVERED, PARTIAL, NEW, IN_PROGRESS, or MEMORY_ERROR plus relevant context. Pass returned context to the worker. claim=true reserves NEW/PARTIAL work; reclaim_ticket explicitly reclaims an orphaned IN_PROGRESS ticket.",
          args: {
            task: tool.schema.string().describe("Work to check in project memory"),
            claim: tool.schema.boolean().optional().describe("Reserve NEW/PARTIAL work (default true)"),
            reclaim_ticket: tool.schema.string().optional().describe("Explicitly reclaim this orphaned IN_PROGRESS ticket")
          },
          execute: async (args, tctx) => {
            if (!handle)
              return JSON.stringify({ status: "MEMORY_ERROR", canonical_key: normalizeKey(args.task), error: { message: "project memory unavailable", cause: "init failed" } }, null, 2);
            const agent = tctx.agent ?? "";
            const claim = args.claim !== false;
            if (args.reclaim_ticket && !isPrimary(agent)) {
              return JSON.stringify({ status: "ERROR", error: "reclaim requires a primary agent (" + PRIMARY_AGENTS.join(", ") + "); subagents may not reclaim claims" });
            }
            if (claim && !isPrimary(agent)) {
              return JSON.stringify({ status: "ERROR", error: `claim requires a primary agent (${PRIMARY_AGENTS.join(", ")}); subagents may query with claim=false` });
            }
            const { handle: h, result } = preflightSafe(handle, { task: args.task, claim, ownerSession: tctx.sessionID, projectDir: directory, fts, reclaimTicket: args.reclaim_ticket });
            handle = h;
            return JSON.stringify(result, null, 2);
          }
        }),
        project_record: tool({
          description: "Record the final result, evidence and reusable facts for a preflight ticket. Primary agents only.",
          args: {
            ticket: tool.schema.string().describe("Work item id from project_preflight"),
            status: tool.schema.enum(["done", "blocked", "failed"]),
            summary: tool.schema.string().optional(),
            unresolved: tool.schema.string().optional().describe("Remaining unresolved delta, if any"),
            evidence: tool.schema.array(tool.schema.string()).optional().describe("File paths / report ids produced"),
            facts: tool.schema.array(tool.schema.object({ key: tool.schema.string(), value: tool.schema.string() })).optional()
          },
          execute: async (args, tctx) => {
            if (!handle)
              return JSON.stringify({ ok: false, error: "project memory unavailable" });
            if (!isPrimary(tctx.agent ?? ""))
              return JSON.stringify({ ok: false, error: "only primary agents can record results" });
            try {
              const res = recordResult(handle.db, args);
              if (res.ok)
                syncAllFts(handle.db, fts);
              return JSON.stringify(res);
            } catch (e) {
              return JSON.stringify({ ok: false, error: `record failed: ${e?.message ?? e}` });
            }
          }
        }),
        project_goal_checkpoint: tool({
          description: "Update the managed current-goal checkpoint while preserving goal-state history. Primary agents only.",
          args: { content: tool.schema.string() },
          execute: async (args, tctx) => {
            if (!isPrimary(tctx.agent ?? ""))
              return JSON.stringify({ ok: false, error: "only primary agents can checkpoint goal-state" });
            const res = checkpointGoal(directory, args.content);
            return JSON.stringify({ ok: true, ...res });
          }
        }),
        project_failure_append: tool({
          description: "Record a reusable failure/blocker in project memory and FAILURES.md. Use only when it can prevent repeated wasted work.",
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
              return JSON.stringify({ ok: false, error: "agent is not allowed to append project failures" });
            try {
              const res = appendFailure(handle.db, { projectDir: directory, ...args, fts });
              syncAllFts(handle.db, fts);
              return JSON.stringify({ ok: true, ...res });
            } catch (e) {
              return JSON.stringify({ ok: false, error: `failure append failed: ${e?.message ?? e}` });
            }
          }
        })
      },
      event: async ({ event }) => {
        if (!handle)
          return;
        const p = event?.properties;
        if (!p?.sessionID)
          return;
        if (typeof event.type === "string" && event.type.includes("session.created")) {
          const parentID = p.info?.parentID;
          if (parentID) {
            try {
              bindClaimToChild(handle.db, parentID, p.sessionID);
            } catch (e) {
              console.error("[project-memory] bindClaimToChild failed:", e);
            }
          }
        }
      },
      "tool.execute.before": async (input, output) => {
        if (input.tool !== "task")
          return;
        if (GATE_MODE === "off")
          return;
        if (!handle) {
          if (GATE_MODE === "strict")
            throw new Error("Project memory preflight is unavailable or inconclusive. Delegation blocked to avoid repeating or conflicting work.");
          warnCalls.add(input.callID);
          return;
        }
        const { handle: h, decision } = gateSafe(handle, { sessionID: input.sessionID, args: output?.args ?? {} });
        handle = h;
        if (decision.action === "block") {
          throw new Error(decision.reason ?? "project-memory gate: preflight required");
        }
        if (decision.action === "warn") {
          warnCalls.add(input.callID);
        }
      },
      "tool.execute.after": async (input, output) => {
        if (input.tool === "task" && warnCalls.has(input.callID)) {
          warnCalls.delete(input.callID);
          output.output = (output.output ?? "") + `

[project-memory] WARNING: task delegated without a project preflight ticket.`;
        }
      }
    };
  }
};
export {
  project_memory_default as default
};
