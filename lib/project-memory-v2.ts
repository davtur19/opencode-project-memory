// project-memory-v2.ts — Project-Memory V2 core (pure logic, no opencode plugin API).
// Persistent idea/hypothesis memory layered on top of V1 (work_items/facts/claims)
// WITHOUT touching V1 tables or behavior. Adds: ideas, conditions (prerequisites),
// relations (requires/enables/supports/contradicts/combines_with/derived_from) and a
// DERIVED BLOCKED/READY state computed from requires-relations — never persisted.
// Imports only from "./project-memory-lib" (Database type, normalizeKey, ulid, nowIso).
import type { Database } from "bun:sqlite"
import { normalizeKey, ulid, nowIso } from "./project-memory-lib"

export const IDEA_STATUSES = ["proposed", "testing", "validated", "disproven", "dormant"] as const
export const RELATION_KINDS = ["requires", "enables", "supports", "contradicts", "combines_with", "derived_from"] as const

const V2_SCHEMA = `
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
`

// Idempotent, additive schema; never destructive. Called on every open. If fts is
// true, also tries to create the FTS5 index (failure is ignored like V1's ftsAvailable).
export function ensureV2Schema(db: Database, fts: boolean): void {
  db.exec(V2_SCHEMA)
  if (fts) {
    try {
      db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS idea_fts USING fts5(canonical_key, title, summary, rationale)")
    } catch {
      // FTS5 unavailable — retrieval falls back to LIKE
    }
  }
}

// ---------- helpers ----------

type IdeaRow = {
  id: string; canonical_key: string; title: string; summary: string; status: string;
  rationale: string; evidence: string; created_at: string; updated_at: string
}
type ConditionRow = {
  id: string; canonical_key: string; description: string; satisfied: number; satisfied_by: string;
  created_at: string; updated_at: string
}
type RelationRow = { idea_id: string; kind: string; target_type: string; target_id: string; note: string }

function ftsQueryV2(key: string): string {
  const toks = key.split(" ").filter(Boolean)
  if (toks.length === 0) return '""'
  return toks.map((t) => `"${t}"`).join(" OR ")
}

function ideaFtsExists(db: Database): boolean {
  try {
    return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='idea_fts'").get()
  } catch {
    return false
  }
}

// Refresh the FTS row for one idea (delete + reinsert), like V1's syncAllFts pattern.
function syncIdeaFts(db: Database, ideaId: string): void {
  try {
    if (!ideaFtsExists(db)) return
    const r = db.query("SELECT rowid, canonical_key, title, summary, rationale FROM ideas WHERE id=?").get(ideaId) as any
    if (!r) return
    db.run("DELETE FROM idea_fts WHERE rowid=?", [r.rowid])
    db.run("INSERT INTO idea_fts(rowid, canonical_key, title, summary, rationale) VALUES (?,?,?,?,?)", [r.rowid, r.canonical_key, r.title, r.summary, r.rationale])
  } catch {
    // FTS optional — never fail the write because of it
  }
}

// Resolve an idea by exact id first, then by normalized key.
function resolveIdea(db: Database, ref: string): { id: string; canonical_key: string } | null {
  if (typeof ref !== "string" || !ref) return null
  const byId = db.query("SELECT * FROM ideas WHERE id=?").get(ref) as IdeaRow | undefined
  if (byId) return { id: byId.id, canonical_key: byId.canonical_key }
  const k = normalizeKey(ref)
  if (!k) return null
  const byKey = db.query("SELECT * FROM ideas WHERE canonical_key=?").get(k) as IdeaRow | undefined
  if (byKey) return { id: byKey.id, canonical_key: byKey.canonical_key }
  return null
}

// Resolve a relation target to an EXISTING idea/condition, or to an entity
// explicitly declared in the SAME call (the idea being written, and conditions
// declared in `conditions`). Never creates placeholder ideas or conditions for
// missing relation targets: a target that neither exists nor is declared in the
// same call is a validation error, not an implicit insertion. Prefixed
// "idea:KEY"/"condition:KEY" resolve by normalized key; bare targets resolve by
// exact id then key across ideas then conditions.
type SameCallTargets = { ideaId: string; ideaKey: string; condIds: Map<string, string> }
function resolveTarget(db: Database, target: string, sameCall?: SameCallTargets): { target_type: "idea" | "condition"; target_id: string; target_key: string } | null {
  if (typeof target !== "string" || !target) return null
  if (target.startsWith("condition:")) {
    const k = normalizeKey(target.slice("condition:".length))
    if (!k) return null
    const row = db.query("SELECT * FROM conditions WHERE canonical_key=?").get(k) as ConditionRow | undefined
    if (row) return { target_type: "condition", target_id: row.id, target_key: row.canonical_key }
    if (sameCall && sameCall.condIds.has(k)) return { target_type: "condition", target_id: sameCall.condIds.get(k)!, target_key: k }
    return null
  }
  if (target.startsWith("idea:")) {
    const k = normalizeKey(target.slice("idea:".length))
    if (!k) return null
    const row = db.query("SELECT * FROM ideas WHERE canonical_key=?").get(k) as IdeaRow | undefined
    if (row) return { target_type: "idea", target_id: row.id, target_key: row.canonical_key }
    if (sameCall && k === sameCall.ideaKey) return { target_type: "idea", target_id: sameCall.ideaId, target_key: sameCall.ideaKey }
    return null
  }
  // bare: exact id in ideas, key in ideas, exact id in conditions, key in conditions
  const byIdeaId = db.query("SELECT * FROM ideas WHERE id=?").get(target) as IdeaRow | undefined
  if (byIdeaId) return { target_type: "idea", target_id: byIdeaId.id, target_key: byIdeaId.canonical_key }
  const k = normalizeKey(target)
  if (!k) return null
  const byIdeaKey = db.query("SELECT * FROM ideas WHERE canonical_key=?").get(k) as IdeaRow | undefined
  if (byIdeaKey) return { target_type: "idea", target_id: byIdeaKey.id, target_key: byIdeaKey.canonical_key }
  const byCondId = db.query("SELECT * FROM conditions WHERE id=?").get(target) as ConditionRow | undefined
  if (byCondId) return { target_type: "condition", target_id: byCondId.id, target_key: byCondId.canonical_key }
  const byCondKey = db.query("SELECT * FROM conditions WHERE canonical_key=?").get(k) as ConditionRow | undefined
  if (byCondKey) return { target_type: "condition", target_id: byCondKey.id, target_key: byCondKey.canonical_key }
  if (sameCall) {
    if (target === sameCall.ideaId || k === sameCall.ideaKey) return { target_type: "idea", target_id: sameCall.ideaId, target_key: sameCall.ideaKey }
    if (sameCall.condIds.has(k)) return { target_type: "condition", target_id: sameCall.condIds.get(k)!, target_key: k }
  }
  return null
}

// ---------- derived state (never persisted) ----------
export type Blocker = { type: "condition" | "idea"; key: string; note: string }
export function derivedStateFor(db: Database, ideaId: string): { derived: string; blockers: Blocker[] } {
  const idea = db.query("SELECT * FROM ideas WHERE id=?").get(ideaId) as IdeaRow | undefined
  if (!idea) return { derived: "proposed", blockers: [] }
  // Terminal statuses are never re-derived: validated/disproven/testing/dormant
  // stay as-is (BLOCKED is NOT DISPROVEN).
  if (idea.status !== "proposed") return { derived: idea.status, blockers: [] }
  const blockers: Blocker[] = []
  const reqs = db.query("SELECT * FROM idea_relations WHERE idea_id=? AND kind='requires'").all(ideaId) as RelationRow[]
  for (const r of reqs) {
    if (r.target_type === "condition") {
      const c = db.query("SELECT * FROM conditions WHERE id=?").get(r.target_id) as ConditionRow | undefined
      if (!c || c.satisfied !== 1) {
        blockers.push({ type: "condition", key: c?.canonical_key ?? r.target_id, note: "condition unsatisfied" })
      }
    } else {
      const t = db.query("SELECT * FROM ideas WHERE id=?").get(r.target_id) as IdeaRow | undefined
      if (!t) blockers.push({ type: "idea", key: r.target_id, note: "required idea missing" })
      else if (t.status === "disproven") blockers.push({ type: "idea", key: t.canonical_key, note: "required idea disproven" })
      else if (t.status !== "validated") blockers.push({ type: "idea", key: t.canonical_key, note: "required idea not validated" })
    }
  }
  return { derived: blockers.length ? "blocked" : "ready", blockers }
}

// ---------- ideaRecord (validation-first, atomic persistence) ----------
export type IdeaRecordOpts = {
  idea?: {
    key?: string; id?: string; title?: string; summary?: string; status?: string;
    rationale?: string; evidence?: string
  }
  // top-level convenience fields (the spec's e2e calls pass status/evidence at
  // top level); merged into `idea` when the corresponding idea field is not set
  status?: string
  evidence?: string
  conditions?: { key: string; description?: string; satisfied?: boolean; satisfied_by?: string }[]
  relations?: { idea: string; kind: string; target: string; note?: string }[]
  satisfies?: string[]
  remove_relations?: { idea: string; kind: string; target: string }[]
}

export type IdeaRecordResult = {
  ok: boolean
  error?: string
  errors?: string[]
  idea?: {
    id: string; key: string; title: string; summary: string; status: string; rationale: string;
    evidence: string; created_at: string; updated_at: string; derived: string; blockers: Blocker[]
  }
  conditions?: { key: string; description: string; satisfied: boolean; satisfied_by: string }[]
  relations?: { idea: string; kind: string; target: string }[]
  removed_relations?: number
}

type ValidatedSpec = {
  ideaId: string
  ideaKey: string
  kind: string
  targetType: "idea" | "condition"
  targetId: string
  targetKey: string
  note?: string
}

export function ideaRecord(db: Database, opts: IdeaRecordOpts = {}): IdeaRecordResult {
  const errors: string[] = []
  const ideaOpts = { ...(opts.idea ?? {}) } as { key?: string; id?: string; title?: string; summary?: string; status?: string; rationale?: string; evidence?: string }
  if (opts.status !== undefined && ideaOpts.status === undefined) ideaOpts.status = opts.status
  if (opts.evidence !== undefined && ideaOpts.evidence === undefined) ideaOpts.evidence = opts.evidence

  // 1. resolve/validate the idea identity — hard precondition
  const hasId = typeof ideaOpts.id === "string" && ideaOpts.id.length > 0
  let key = ""
  let existingRow: IdeaRow | undefined
  if (hasId) {
    existingRow = db.query("SELECT * FROM ideas WHERE id=?").get(ideaOpts.id) as IdeaRow | undefined
    if (!existingRow) return { ok: false, error: `idea not found by id: ${ideaOpts.id}` }
    key = existingRow.canonical_key
  } else {
    key = normalizeKey(typeof ideaOpts.key === "string" ? ideaOpts.key : "")
    if (!key) return { ok: false, error: "idea.key or idea.id required" }
    existingRow = db.query("SELECT * FROM ideas WHERE canonical_key=?").get(key) as IdeaRow | undefined
  }
  // The idea id is fixed up front so same-call relations can reference this idea
  // as their source (the idea being created/updated in this call).
  const ideaId = existingRow?.id ?? ulid()

  // 2. validate status and evidence rules against the EFFECTIVE final state
  //    (what the idea will look like after this call applies)
  let statusProvided = false
  let status = existingRow?.status ?? "proposed"
  if (typeof ideaOpts.status === "string" && ideaOpts.status !== "") {
    if ((IDEA_STATUSES as readonly string[]).includes(ideaOpts.status)) { statusProvided = true; status = ideaOpts.status }
    else errors.push(`invalid idea status '${ideaOpts.status}' (expected one of: ${IDEA_STATUSES.join(", ")})`)
  }
  const evidence = typeof ideaOpts.evidence === "string" ? ideaOpts.evidence : (existingRow?.evidence ?? "")
  const evidenceSupplied = typeof ideaOpts.evidence === "string" && ideaOpts.evidence.trim() !== ""
  if (status === "validated" || status === "disproven") {
    // Invariant: an idea in a strong status always carries evidence.
    if (evidence.trim() === "") {
      errors.push(`status '${status}' requires non-empty evidence`)
    }
    // A transition INTO a strong status must be justified by evidence supplied in
    // THIS call — never silently reuse evidence recorded under a conflicting
    // status. Re-saving an already strong status without new evidence keeps the
    // existing evidence (the status is not changing).
    const statusChanging = !existingRow || existingRow.status !== status
    if (statusChanging && !evidenceSupplied) {
      errors.push(`transition to '${status}' requires evidence supplied for this transition`)
    }
  }

  // 3. conditions: keys required; satisfied=true requires explicit provenance.
  //    Ids are pre-assigned up front so same-call relations can reference a
  //    condition declared in THIS call (never a placeholder for unknown targets).
  type CondSpec = { key: string; description?: string; satisfied?: boolean; satisfied_by?: string }
  const condSpecs: CondSpec[] = []
  const condIds = new Map<string, string>()
  for (const c of opts.conditions ?? []) {
    const ckey = normalizeKey(typeof c.key === "string" ? c.key : "")
    if (!ckey) { errors.push(`condition key required (got ${JSON.stringify(c.key)})`); continue }
    if (c.satisfied === true && !(typeof c.satisfied_by === "string" && c.satisfied_by.trim() !== "")) {
      errors.push(`condition '${ckey}' satisfied=true requires satisfied_by (explicit provenance)`)
    }
    const existingCond = db.query("SELECT * FROM conditions WHERE canonical_key=?").get(ckey) as ConditionRow | undefined
    condIds.set(ckey, existingCond?.id ?? ulid())
    condSpecs.push({ key: ckey, description: c.description, satisfied: c.satisfied, satisfied_by: c.satisfied_by })
  }
  const sameCall: SameCallTargets = { ideaId, ideaKey: key, condIds }

  // 4. satisfies: only from a validated idea with evidence, against an EXISTING
  //    condition, recording the idea id as provenance
  const satisfiesSpecs: string[] = []
  for (const s of opts.satisfies ?? []) {
    const skey = normalizeKey(typeof s === "string" ? s : "")
    if (!skey) { errors.push(`satisfies key required (got ${JSON.stringify(s)})`); continue }
    const cond = db.query("SELECT * FROM conditions WHERE canonical_key=?").get(skey) as ConditionRow | undefined
    if (!cond) { errors.push(`satisfies target condition not found: ${skey}`); continue }
    satisfiesSpecs.push(skey)
  }
  if (opts.satisfies?.length) {
    if (status !== "validated") errors.push("satisfies requires the idea to be validated")
    if (evidence.trim() === "") errors.push("satisfies requires the idea to carry evidence")
  }

  // 5. relations: sources and targets must exist (no placeholders), kinds valid.
  //    The idea being written in this call counts as a valid source.
  const resolveSource = (ref: string): { id: string; canonical_key: string } | null => {
    const existing = resolveIdea(db, ref)
    if (existing) return existing
    if (typeof ref === "string" && (ref === ideaId || normalizeKey(ref) === key)) return { id: ideaId, canonical_key: key }
    return null
  }
  const relSpecs: ValidatedSpec[] = []
  for (const r of opts.relations ?? []) {
    const src = resolveSource(r.idea)
    if (!src) { errors.push(`relation source idea not found: ${r.idea}`); continue }
    if (!(RELATION_KINDS as readonly string[]).includes(r.kind)) { errors.push(`invalid relation kind '${r.kind}' (expected one of: ${RELATION_KINDS.join(", ")})`); continue }
    const tr = resolveTarget(db, r.target, sameCall)
    if (!tr) { errors.push(`relation target not found: ${r.target}`); continue }
    relSpecs.push({ ideaId: src.id, ideaKey: src.canonical_key, kind: r.kind, targetType: tr.target_type, targetId: tr.target_id, targetKey: tr.target_key, note: typeof r.note === "string" ? r.note : "" })
  }
  const remSpecs: ValidatedSpec[] = []
  for (const r of opts.remove_relations ?? []) {
    const src = resolveSource(r.idea)
    if (!src) { errors.push(`relation source idea not found: ${r.idea}`); continue }
    if (!(RELATION_KINDS as readonly string[]).includes(r.kind)) { errors.push(`invalid relation kind '${r.kind}' (expected one of: ${RELATION_KINDS.join(", ")})`); continue }
    const tr = resolveTarget(db, r.target, sameCall)
    if (!tr) { errors.push(`relation target not found: ${r.target}`); continue }
    remSpecs.push({ ideaId: src.id, ideaKey: src.canonical_key, kind: r.kind, targetType: tr.target_type, targetId: tr.target_id, targetKey: tr.target_key })
  }

  // 6. ATOMIC: any validation error => ok:false, nothing written.
  if (errors.length > 0) {
    return { ok: false, error: errors.join("; "), errors }
  }

  // 7. apply all writes in one transaction.
  try {
    return db.transaction(() => applyIdeaRecord(db, { ideaId, ideaOpts, key, existingRow, statusProvided, status, evidence, condSpecs, condIds, satisfiesSpecs, relSpecs, remSpecs }))()
  } catch (e: any) {
    return { ok: false, error: `idea_save failed: ${e?.message ?? e}` }
  }
}

function applyIdeaRecord(db: Database, cfg: {
  ideaId: string
  ideaOpts: { key?: string; id?: string; title?: string; summary?: string; status?: string; rationale?: string; evidence?: string }
  key: string
  existingRow?: IdeaRow
  statusProvided: boolean
  status: string
  evidence: string
  condSpecs: { key: string; description?: string; satisfied?: boolean; satisfied_by?: string }[]
  condIds: Map<string, string>
  satisfiesSpecs: string[]
  relSpecs: ValidatedSpec[]
  remSpecs: ValidatedSpec[]
}): IdeaRecordResult {
  const { ideaId, ideaOpts, key, existingRow, statusProvided, status, evidence, condSpecs, condIds, satisfiesSpecs, relSpecs, remSpecs } = cfg
  const now = nowIso()

  if (existingRow) {
    const sets: string[] = []
    const vals: any[] = []
    for (const col of ["title", "summary", "rationale", "evidence"] as const) {
      if (typeof ideaOpts[col] === "string") { sets.push(`${col}=?`); vals.push(ideaOpts[col] as string) }
    }
    if (statusProvided) { sets.push("status=?"); vals.push(status) }
    sets.push("updated_at=?")
    vals.push(now)
    db.run(`UPDATE ideas SET ${sets.join(", ")} WHERE id=?`, [...vals, existingRow.id])
  } else {
    db.run(
      `INSERT INTO ideas (id, canonical_key, title, summary, status, rationale, evidence, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        ideaId, key,
        typeof ideaOpts.title === "string" ? ideaOpts.title : "",
        typeof ideaOpts.summary === "string" ? ideaOpts.summary : "",
        statusProvided ? status : "proposed",
        typeof ideaOpts.rationale === "string" ? ideaOpts.rationale : "",
        typeof ideaOpts.evidence === "string" ? ideaOpts.evidence : "",
        now, now,
      ],
    )
  }
  syncIdeaFts(db, ideaId)

  const condTouched = new Map<string, { key: string; description: string; satisfied: boolean; satisfied_by: string }>()
  for (const c of condSpecs) {
    const existing = db.query("SELECT * FROM conditions WHERE canonical_key=?").get(c.key) as ConditionRow | undefined
    const cid = existing?.id ?? condIds.get(c.key) ?? ulid()
    const desc = typeof c.description === "string" ? c.description : (existing?.description ?? c.key)
    let satisfied: number
    let satisfiedBy: string
    if (typeof c.satisfied === "boolean") {
      satisfied = c.satisfied ? 1 : 0
      satisfiedBy = c.satisfied ? (typeof c.satisfied_by === "string" ? c.satisfied_by : "") : ""
    } else {
      satisfied = existing?.satisfied ?? 0
      satisfiedBy = existing?.satisfied_by ?? ""
    }
    const sets: string[] = []
    const vals: any[] = []
    if (typeof c.description === "string") { sets.push("description=?"); vals.push(c.description) }
    if (typeof c.satisfied === "boolean") {
      sets.push("satisfied=?"); vals.push(satisfied)
      sets.push("satisfied_by=?"); vals.push(satisfiedBy)
    }
    sets.push("updated_at=?")
    vals.push(now)
    if (existing) {
      db.run(`UPDATE conditions SET ${sets.join(", ")} WHERE id=?`, [...vals, existing.id])
    } else {
      db.run("INSERT INTO conditions (id, canonical_key, description, satisfied, satisfied_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", [cid, c.key, desc, satisfied, satisfiedBy, now, now])
    }
    condTouched.set(c.key, { key: c.key, description: desc, satisfied: satisfied === 1, satisfied_by: satisfiedBy })
  }

  // satisfies — the recorded idea id is the provenance
  for (const skey of satisfiesSpecs) {
    const existing = db.query("SELECT * FROM conditions WHERE canonical_key=?").get(skey) as ConditionRow | undefined
    if (!existing) continue // validated earlier; defensive
    db.run("UPDATE conditions SET satisfied=1, satisfied_by=?, updated_at=? WHERE id=?", [ideaId, now, existing.id])
    condTouched.set(skey, { key: skey, description: existing.description, satisfied: true, satisfied_by: ideaId })
  }

  const addedRelations: { idea: string; kind: string; target: string }[] = []
  for (const r of relSpecs) {
    const res = db.run("INSERT OR IGNORE INTO idea_relations (idea_id, kind, target_type, target_id, note) VALUES (?,?,?,?,?)", [r.ideaId, r.kind, r.targetType, r.targetId, r.note ?? ""])
    if (res.changes > 0) {
      addedRelations.push({ idea: r.ideaKey, kind: r.kind, target: (r.targetType === "idea" ? "idea:" : "condition:") + r.targetKey })
    }
  }

  let removedRelations = 0
  for (const r of remSpecs) {
    const del = db.run("DELETE FROM idea_relations WHERE idea_id=? AND kind=? AND target_type=? AND target_id=?", [r.ideaId, r.kind, r.targetType, r.targetId])
    removedRelations += del.changes
  }

  const finalRow = db.query("SELECT * FROM ideas WHERE id=?").get(ideaId) as IdeaRow
  const d = derivedStateFor(db, ideaId)
  return {
    ok: true,
    idea: {
      id: finalRow.id, key: finalRow.canonical_key, title: finalRow.title, summary: finalRow.summary,
      status: finalRow.status, rationale: finalRow.rationale, evidence: finalRow.evidence,
      created_at: finalRow.created_at, updated_at: finalRow.updated_at, derived: d.derived, blockers: d.blockers,
    },
    conditions: [...condTouched.values()].slice(0, 20),
    relations: addedRelations.slice(0, 20),
    removed_relations: removedRelations,
  }
}

// ---------- projectFrontier (retrieval) ----------
export type FrontierOpts = { goal: string; limit?: number }
export type FrontierResult = {
  ok: boolean
  goal_key: string
  limit: number
  ideas: { id: string; key: string; title: string; summary: string; status: string; derived: string; blockers: Blocker[]; updated_at: string }[]
  conditions: { key: string; description: string; satisfied: boolean; satisfied_by: string }[]
  relations: { idea: string; kind: string; target: string }[]
  counts: { ideas: number; conditions: number; relations: number }
}

export function projectFrontier(db: Database, opts: FrontierOpts = {}): FrontierResult {
  const limit = typeof opts?.limit === "number" && Number.isFinite(opts.limit) ? Math.max(1, Math.min(20, Math.floor(opts.limit))) : 8
  const key = normalizeKey(typeof opts?.goal === "string" ? opts.goal : "")
  if (!key) return { ok: true, goal_key: "", limit, ideas: [], conditions: [], relations: [], counts: { ideas: 0, conditions: 0, relations: 0 } }

  // 2. candidate ideas
  let candidates: IdeaRow[] = []
  if (ideaFtsExists(db)) {
    candidates = db.query("SELECT i.* FROM idea_fts f JOIN ideas i ON i.rowid=f.rowid WHERE idea_fts MATCH ? ORDER BY rank LIMIT ?").all(ftsQueryV2(key), limit) as IdeaRow[]
  } else {
    const like = `%${key}%`
    candidates = db.query("SELECT * FROM ideas WHERE canonical_key LIKE ? OR title LIKE ? OR summary LIKE ? OR rationale LIKE ? ORDER BY updated_at DESC LIMIT ?").all(like, like, like, like, limit) as IdeaRow[]
  }
  if (candidates.length === 0) return { ok: true, goal_key: key, limit, ideas: [], conditions: [], relations: [], counts: { ideas: 0, conditions: 0, relations: 0 } }

  // 4. neighbor expansion (relations from or to each candidate; other idea endpoint)
  const selected = new Map<string, IdeaRow>()
  for (const c of candidates) {
    if (!selected.has(c.id)) selected.set(c.id, c)
    if (selected.size >= limit) break
  }
  if (selected.size < limit) {
    outer: for (const c of candidates) {
      const rels = db.query("SELECT * FROM idea_relations WHERE idea_id=? OR (target_type='idea' AND target_id=?)").all(c.id, c.id) as RelationRow[]
      for (const rel of rels) {
        if (rel.target_type !== "idea") continue
        // The other idea endpoint: the candidate is the source (outgoing) or the
        // target (incoming relation — the neighbor is the relation's source).
        const nid = rel.idea_id === c.id ? rel.target_id : rel.idea_id
        if (!selected.has(nid)) {
          const nrow = db.query("SELECT * FROM ideas WHERE id=?").get(nid) as IdeaRow | undefined
          if (nrow) selected.set(nid, nrow)
          if (selected.size >= limit) break outer
        }
      }
    }
  }

  // 5. derived state + bound at limit. Ordering stays relevance-oriented (the FTS
  //    rank / fallback order from the candidate query) — derived READY/BLOCKED is
  //    returned as metadata, never re-ordered ahead of relevance.
  const selectedIds = [...selected.keys()]
  const ideas = selectedIds.map((id) => {
    const row = selected.get(id)!
    const d = derivedStateFor(db, id)
    return { id: row.id, key: row.canonical_key, title: row.title, summary: row.summary, status: row.status, derived: d.derived, blockers: d.blockers, updated_at: row.updated_at }
  })
  const boundedIdeas = ideas.slice(0, limit)

  // 6. open conditions referenced by requires-relations of selected ideas
  const condRows: { key: string; description: string; satisfied: boolean; satisfied_by: string }[] = []
  if (selectedIds.length > 0) {
    const marks = selectedIds.map(() => "?").join(",")
    const rows = db.query(
      `SELECT DISTINCT c.canonical_key AS ck, c.description AS cd, c.satisfied AS cs, c.satisfied_by AS csb
       FROM idea_relations r JOIN conditions c ON c.id = r.target_id
       WHERE r.idea_id IN (${marks}) AND r.kind='requires' AND r.target_type='condition' AND c.satisfied=0
       ORDER BY c.canonical_key LIMIT 8`,
    ).all(...selectedIds) as { ck: string; cd: string; cs: number; csb: string }[]
    for (const r of rows) condRows.push({ key: r.ck, description: r.cd, satisfied: r.cs === 1, satisfied_by: r.csb })
  }

  // 7. relations touching selected ideas (outgoing, or incoming idea-targets)
  const relRows: { idea: string; kind: string; target: string }[] = []
  if (selectedIds.length > 0) {
    const marks = selectedIds.map(() => "?").join(",")
    const rows = db.query(
      `SELECT DISTINCT r.kind AS rk, r.target_type AS rt, si.canonical_key AS sk, ti.canonical_key AS tik, tc.canonical_key AS tck
       FROM idea_relations r
       JOIN ideas si ON si.id = r.idea_id
       LEFT JOIN ideas ti ON ti.id = r.target_id AND r.target_type='idea'
       LEFT JOIN conditions tc ON tc.id = r.target_id AND r.target_type='condition'
       WHERE r.idea_id IN (${marks}) OR (r.target_type='idea' AND r.target_id IN (${marks}))
       ORDER BY r.id LIMIT 12`,
    ).all(...selectedIds, ...selectedIds) as { rk: string; rt: string; sk: string; tik: string | null; tck: string | null }[]
    for (const r of rows) {
      const targetKey = r.rt === "idea" ? r.tik : r.tck
      relRows.push({ idea: r.sk, kind: r.rk, target: (r.rt === "idea" ? "idea:" : "condition:") + (targetKey ?? "") })
    }
  }

  return {
    ok: true,
    goal_key: key,
    limit,
    ideas: boundedIdeas,
    conditions: condRows.slice(0, 8),
    relations: relRows.slice(0, 12),
    counts: { ideas: boundedIdeas.length, conditions: condRows.length, relations: relRows.length },
  }
}