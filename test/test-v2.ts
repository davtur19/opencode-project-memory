// test-v2.ts — Project-Memory V2: unit + concurrency tests
// V1 must keep working on the same db; V2 schema/ideas/conditions/relations,
// derived BLOCKED/READY state, satisfies, frontier, the LIKE fallback path,
// and the hardened evidence/provenance/atomicity rules.
import * as PM from "../lib/project-memory-lib"
import * as PM2 from "../lib/project-memory-v2"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log("PASS", name) } else { fail++; console.log("FAIL", name, extra) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-v2-"))
const db = PM.openMemory(path.join(dir, "memory.sqlite"))
const fts = PM.ftsAvailable(db)
PM2.ensureV2Schema(db, fts)
console.log("FTS available:", fts)

// ---- V1 tables still work on the same db (V2 must not break V1) ----
{
  const c = PM.claimWorkItem(db, { canonicalKey: "v1 sanity", ownerSession: "ses_A" })
  const t = c.ok ? c.item.id : c.inProgress.id
  const pre = PM.preflight(db, { task: "v1 sanity", claim: false, ownerSession: "ses_A", projectDir: dir, fts })
  const rec = PM.recordResult(db, { ticket: t, status: "done", summary: "ok", ownerSession: "ses_A" })
  check("V1 claim+preflight+record works on V2 db", c.ok && pre.status === "IN_PROGRESS" && rec.ok, JSON.stringify({ pre, rec }))
}

// ---- schema ----
{
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ideas','conditions','idea_relations')").all() as any[]).map((r) => r.name)
  check("schema tables ideas+conditions+idea_relations", tables.includes("ideas") && tables.includes("conditions") && tables.includes("idea_relations"), tables.join(","))
}

// ---- ideaRecord creates idea ----
let aId = ""
{
  const r = PM2.ideaRecord(db, { idea: { key: "alpha idea", title: "Alpha", summary: "first idea" } })
  check("create idea ok", r.ok === true && !!r.idea?.id && r.idea.status === "proposed" && !!r.idea.created_at && !!r.idea.updated_at, JSON.stringify(r))
  aId = r.idea!.id
}

// ---- second ideaRecord same key, new summary → same id, 1 row, summary updated ----
{
  const r = PM2.ideaRecord(db, { idea: { key: "alpha idea", summary: "updated summary" } })
  check("update same key → same id", r.ok && r.idea?.id === aId, JSON.stringify(r.idea))
  check("update count 1", (db.query("SELECT COUNT(*) AS n FROM ideas WHERE canonical_key='alpha idea'").get() as any).n === 1)
  check("update summary applied", r.idea?.summary === "updated summary", JSON.stringify(r.idea?.summary))
  check("update status preserved (proposed)", r.idea?.status === "proposed", JSON.stringify(r.idea?.status))
}

// ---- bogus status → ok:false, atomic (no writes) ----
{
  const r = PM2.ideaRecord(db, { idea: { key: "alpha idea", status: "bogus" as any } })
  check("bogus status ok:false", r.ok === false && /status/i.test(r.error ?? ""), JSON.stringify(r))
  check("bogus status unchanged", (db.query("SELECT status FROM ideas WHERE id=?").get(aId) as any).status === "proposed")
}

// ---- relation kind bogus → ok:false, atomic (no row, no condition created) ----
{
  const r = PM2.ideaRecord(db, { idea: { key: "alpha idea" }, relations: [{ idea: "alpha idea", kind: "bogus" as any, target: "condition:zz" }] })
  check("bogus kind ok:false", r.ok === false && /kind/i.test(r.error ?? ""), JSON.stringify(r))
  check("bogus kind no relation row", (db.query("SELECT COUNT(*) AS n FROM idea_relations WHERE kind='bogus'").get() as any).n === 0)
  check("bogus kind no placeholder condition", (db.query("SELECT COUNT(*) AS n FROM conditions WHERE canonical_key='zz'").get() as any).n === 0)
}

// ---- create idea A (relation source must pre-exist) ----
{
  const r = PM2.ideaRecord(db, { idea: { key: "idea A", title: "A" } })
  check("idea A created", r.ok === true && !!r.idea?.id, JSON.stringify(r))
}

// ---- missing relation target → ok:false, NO placeholder created ----
{
  const r = PM2.ideaRecord(db, { idea: { key: "idea A" }, relations: [{ idea: "idea A", kind: "requires", target: "condition:X" }] })
  check("missing target ok:false", r.ok === false && /target not found/.test(r.error ?? ""), JSON.stringify(r))
  check("missing target no condition placeholder", (db.query("SELECT COUNT(*) AS n FROM conditions WHERE canonical_key='x'").get() as any).n === 0)
  check("missing target no idea placeholder", (db.query("SELECT COUNT(*) AS n FROM ideas WHERE canonical_key='x'").get() as any).n === 0)
  check("missing target no relation row", (db.query("SELECT COUNT(*) AS n FROM idea_relations").get() as any).n === 0)
}

// ---- explicit condition + relation: A blocked ----
let aRowId = ""
{
  const r = PM2.ideaRecord(db, { idea: { key: "idea A", title: "A" }, conditions: [{ key: "X", description: "condition x" }] })
  check("create condition X ok", r.ok === true && r.conditions?.some((c) => c.key === "x"), JSON.stringify(r))
  const r2 = PM2.ideaRecord(db, { idea: { key: "idea A" }, relations: [{ idea: "idea A", kind: "requires", target: "condition:X" }] })
  check("relation requires ok", r2.ok === true && r2.relations?.length === 1, JSON.stringify(r2.relations))
  const condX = db.query("SELECT * FROM conditions WHERE canonical_key='x'").get() as any
  check("condition X unsatisfied", !!condX && condX.satisfied === 0, JSON.stringify(condX))
  const relX = db.query("SELECT * FROM idea_relations WHERE kind='requires' AND target_type='condition'").get() as any
  check("relation row exists", !!relX && relX.target_id === condX.id, JSON.stringify(relX))
  aRowId = (db.query("SELECT id FROM ideas WHERE canonical_key='idea a'").get() as any).id
  const d = PM2.derivedStateFor(db, aRowId)
  check("A derived blocked", d.derived === "blocked" && d.blockers.some((b: any) => b.type === "condition" && b.key === "x"), JSON.stringify(d))
}

// ---- satisfies requires a VALIDATED idea with evidence; A is proposed → denied ----
{
  const r = PM2.ideaRecord(db, { idea: { key: "idea A" }, satisfies: ["X"] })
  check("satisfies from non-validated idea ok:false", r.ok === false && /validated/.test(r.error ?? ""), JSON.stringify(r))
  check("satisfies denied is atomic (X still unsatisfied)", (db.query("SELECT satisfied FROM conditions WHERE canonical_key='x'").get() as any).satisfied === 0)
}

// ---- idea B validated with evidence + satisfies X → X satisfied, provenance = B id ----
{
  const r = PM2.ideaRecord(db, { idea: { key: "idea B", title: "B", status: "validated", evidence: "bench test log bench.log" }, satisfies: ["X"] })
  check("B validated+evidence+satisfies ok", r.ok === true && r.idea?.status === "validated", JSON.stringify(r))
  const condX = db.query("SELECT * FROM conditions WHERE canonical_key='x'").get() as any
  check("condition satisfied", condX.satisfied === 1, JSON.stringify(condX))
  const bId = (db.query("SELECT id FROM ideas WHERE canonical_key='idea b'").get() as any).id
  check("satisfied_by is B's idea id", condX.satisfied_by === bId, condX.satisfied_by)
  const d = PM2.derivedStateFor(db, aRowId)
  check("A derived ready after satisfy", d.derived === "ready" && d.blockers.length === 0, JSON.stringify(d))
}

// ---- validated WITHOUT evidence → ok:false, atomic (fresh idea) ----
{
  const r = PM2.ideaRecord(db, { idea: { key: "idea E" }, status: "validated" })
  check("validated without evidence ok:false", r.ok === false && /evidence/.test(r.error ?? ""), JSON.stringify(r))
  check("idea E not created", (db.query("SELECT COUNT(*) AS n FROM ideas WHERE canonical_key='idea e'").get() as any).n === 0)
}

// ---- disproven requires evidence ----
{
  const rNoEv = PM2.ideaRecord(db, { idea: { key: "idea C", title: "C", status: "disproven" } })
  check("disproven without evidence ok:false", rNoEv.ok === false && /evidence/.test(rNoEv.error ?? ""), JSON.stringify(rNoEv))
  const r = PM2.ideaRecord(db, { idea: { key: "idea C", title: "C", status: "disproven", evidence: "repro failed with no token on three devices" } })
  check("C disproven record ok", r.ok === true && r.idea?.status === "disproven", JSON.stringify(r))
  const cRowId = (db.query("SELECT id FROM ideas WHERE canonical_key='idea c'").get() as any).id
  const d = PM2.derivedStateFor(db, cRowId)
  check("C derived disproven (never blocked)", d.derived === "disproven" && d.blockers.length === 0, JSON.stringify(d))
}

// ---- satisfied condition requires explicit provenance ----
{
  const r = PM2.ideaRecord(db, { idea: { key: "idea A" }, conditions: [{ key: "Q", satisfied: true }] })
  check("satisfied without satisfied_by ok:false", r.ok === false && /satisfied_by/.test(r.error ?? ""), JSON.stringify(r))
  check("satisfied-atomic: Q not created", (db.query("SELECT COUNT(*) AS n FROM conditions WHERE canonical_key='q'").get() as any).n === 0)
  const r2 = PM2.ideaRecord(db, { idea: { key: "idea A" }, conditions: [{ key: "Q", satisfied: true, satisfied_by: "observe via device log" }] })
  check("satisfied with provenance ok", r2.ok === true, JSON.stringify(r2))
  const q = db.query("SELECT * FROM conditions WHERE canonical_key='q'").get() as any
  check("Q satisfied + provenance", q.satisfied === 1 && q.satisfied_by === "observe via device log", JSON.stringify(q))
}

// ---- idea D requires idea:C → blocked, note mentions disproven ----
{
  const r0 = PM2.ideaRecord(db, { idea: { key: "idea D", summary: "depends on c" } })
  check("D created", r0.ok === true, JSON.stringify(r0))
  const r = PM2.ideaRecord(db, { idea: { key: "idea D" }, relations: [{ idea: "idea D", kind: "requires", target: "idea:idea C" }] })
  check("D requires C ok", r.ok === true, JSON.stringify(r))
  const dRowId = (db.query("SELECT id FROM ideas WHERE canonical_key='idea d'").get() as any).id
  const d = PM2.derivedStateFor(db, dRowId)
  check("D blocked via disproven C", d.derived === "blocked" && d.blockers.some((b: any) => b.type === "idea" && /disproven/i.test(b.note)), JSON.stringify(d))
}

// ---- atomicity: one bad part voids the whole write ----
{
  const before = {
    ideas: (db.query("SELECT COUNT(*) AS n FROM ideas").get() as any).n,
    conds: (db.query("SELECT COUNT(*) AS n FROM conditions").get() as any).n,
    rels: (db.query("SELECT COUNT(*) AS n FROM idea_relations").get() as any).n,
  }
  const r = PM2.ideaRecord(db, { idea: { key: "atomic idea", title: "should not persist" }, conditions: [{ key: "ok cond" }], relations: [{ idea: "atomic idea", kind: "requires", target: "condition:does-not-exist" }] })
  check("atomic: bad relation voids write", r.ok === false && /target not found/.test(r.error ?? ""), JSON.stringify(r))
  const after = {
    ideas: (db.query("SELECT COUNT(*) AS n FROM ideas").get() as any).n,
    conds: (db.query("SELECT COUNT(*) AS n FROM conditions").get() as any).n,
    rels: (db.query("SELECT COUNT(*) AS n FROM idea_relations").get() as any).n,
  }
  check("atomic: no partial idea", after.ideas === before.ideas, JSON.stringify(after))
  check("atomic: no partial condition", after.conds === before.conds, JSON.stringify(after))
  check("atomic: no partial relation", after.rels === before.rels, JSON.stringify(after))
}

// ---- unknown idea id → ok:false ----
{
  const r = PM2.ideaRecord(db, { idea: { id: "nonexistent-id-123" } })
  check("unknown id → ok:false", r.ok === false && /not found by id/.test(r.error ?? ""), JSON.stringify(r))
}

// ---- no key and no id → ok:false ----
{
  const r = PM2.ideaRecord(db, { idea: {} })
  check("no key/id → ok:false", r.ok === false && /idea.key or idea.id required/.test(r.error ?? ""), JSON.stringify(r))
}

// ---- frontier: empty goal ----
{
  const f = PM2.projectFrontier(db, { goal: "" })
  check("frontier empty goal empty", f.ok === true && f.goal_key === "" && f.ideas.length === 0 && f.counts.ideas === 0, JSON.stringify(f))
}

// ---- frontier: no-match goal ----
{
  const f = PM2.projectFrontier(db, { goal: "zzzzqqqq never seen" })
  check("frontier no-match empty", f.ok === true && f.ideas.length === 0 && f.counts.ideas === 0 && f.counts.conditions === 0, JSON.stringify(f))
}

// ---- concurrency: 20× ideaRecord same key different title → 1 row, no throw ----
{
  const titles = Array.from({ length: 20 }, (_, i) => `title ${i}`)
  let threw = false
  let cRes: any[] = []
  try { cRes = await Promise.all(titles.map((t) => PM2.ideaRecord(db, { idea: { key: "concurrent idea", title: t } }))) } catch { threw = true }
  check("20 concurrent same-key ideaRecord no throw", !threw, JSON.stringify({ threw }))
  check("20 concurrent all ok", cRes.every((r) => r.ok === true), JSON.stringify(cRes.filter((r) => !r.ok)))
  check("20 concurrent same key → 1 row", (db.query("SELECT COUNT(*) AS n FROM ideas WHERE canonical_key='concurrent idea'").get() as any).n === 1)
  const cur = db.query("SELECT title FROM ideas WHERE canonical_key='concurrent idea'").get() as any
  check("concurrent title is one of submitted", titles.includes(cur.title), cur.title)
}

// ---- concurrency: 10× conditions satisfied → satisfied=1, provenance preserved ----
{
  let threw = false
  let cRes: any[] = []
  try { cRes = await Promise.all(Array.from({ length: 10 }, async () => PM2.ideaRecord(db, { idea: { key: "concurrent idea" }, conditions: [{ key: "c", satisfied: true, satisfied_by: "provenance-1" }] }))) } catch { threw = true }
  check("10 concurrent condition satisfy no throw", !threw, JSON.stringify({ threw }))
  check("10 concurrent condition satisfy all ok", cRes.every((r) => r.ok === true), JSON.stringify(cRes.filter((r) => !r.ok)))
  check("condition c satisfied=1", (db.query("SELECT satisfied FROM conditions WHERE canonical_key='c'").get() as any).satisfied === 1)
}

// ---- LIKE fallback path: second db opened WITHOUT FTS schema ----
{
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "pm-v2-like-"))
  const db2 = PM.openMemory(path.join(dir2, "memory.sqlite"))
  PM2.ensureV2Schema(db2, false) // force LIKE branch even if FTS would be available
  const r = PM2.ideaRecord(db2, { idea: { key: "fallback idea", title: "like fallback topic" } })
  const f = PM2.projectFrontier(db2, { goal: "like fallback" })
  check("like-fallback ideaRecord ok", r.ok === true, JSON.stringify(r))
  check("like-fallback frontier finds idea", f.ok === true && f.ideas.some((i: any) => i.key === "fallback idea"), JSON.stringify(f))
  db2.close()
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)