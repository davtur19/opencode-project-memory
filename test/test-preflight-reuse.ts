import * as PM from "../lib/project-memory-lib"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log("PASS", name) } else { fail++; console.log("FAIL", name, extra) }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-reuse-"))
function freshDb(tag: string): { db: PM.DB; dir: string; fts: boolean } {
  const dir = fs.mkdtempSync(path.join(tmp, tag))
  const db = PM.openMemory(path.join(dir, "memory.sqlite"))
  return { db, dir, fts: PM.ftsAvailable(db) }
}
const claim = (db: PM.DB, key: string, owner: string) => {
  const c = PM.claimWorkItem(db, { canonicalKey: key, ownerSession: owner, summary: key })
  return c.ok ? c.item.id : c.inProgress.id
}

// T1 — ONE shared token is never a continuation (the original bug's mechanism:
// the unrelated active ticket shared only "local" with the git/PR task)
{
  const { db, dir, fts } = freshDb("t1")
  const tA = claim(db, "inspect the local database for leaked credentials", "ses_A")
  const r = PM.preflight(db, { task: "create a local branch and commit the fix", claim: true, ownerSession: "ses_B", projectDir: dir, fts })
  check("T1 single shared token NOT reused", r.status === "NEW" && r.ticket !== tA, JSON.stringify(r))
  check("T1 reuse_denied lists rejected candidate (overlap 1)", Array.isArray(r.reuse_denied) && r.reuse_denied!.some((d) => d.id === tA && d.overlap === 1), JSON.stringify(r.reuse_denied))
}

// T2 — real continuation (rephrased same task) IS reused
{
  const { db, dir, fts } = freshDb("t2")
  const tA = claim(db, "investigate why session X hangs when starting the goal task", "ses_A")
  const r = PM.preflight(db, { task: "find out why session x remains stuck when the goal task starts", claim: true, ownerSession: "ses_B", projectDir: dir, fts })
  check("T2 legit continuation reuses same ticket", r.status === "IN_PROGRESS" && r.ticket === tA, JSON.stringify(r))
  check("T2 match_reason semantic-continuation", r.match_reason === "semantic-continuation", JSON.stringify(r))
  check("T2 match_score = overlap (3)", r.match_score === 3, JSON.stringify(r))
}

// T3 — no correlation at all → no reuse, diagnostics show no candidates
{
  const { db, dir, fts } = freshDb("t3")
  const tA = claim(db, "investigate why session X hangs when starting the goal task", "ses_A")
  const r = PM.preflight(db, { task: "compile a rust program for the embedded target", claim: true, ownerSession: "ses_A", projectDir: dir, fts })
  check("T3 unrelated same-session NOT reused", r.status === "NEW" && r.ticket !== tA, JSON.stringify(r))
  check("T3 no candidates → empty reuse diagnostics", (r.reuse_denied ?? []).length === 0 && (r.reuse_considered ?? []).length === 0, JSON.stringify({ rd: r.reuse_denied, rc: r.reuse_considered }))
}

// T4 — MULTIPLE in_progress candidates: the BEST overlap wins regardless of
// array order. A ("fix local project" + notes "widget alpha flaw") matches 6 of
// the request's FTS query terms so it ranks FIRST in the FTS result, yet its
// significant overlap (canonical_key+summary+unresolved only) is 3; B
// ("fix widget alpha flaw") has overlap 4. Selecting inProgressCandidates[0]
// here would pick A — this test fails if that bug is ever reintroduced.
{
  const { db, dir, fts } = freshDb("t4")
  const cA = PM.claimWorkItem(db, { canonicalKey: "fix local project", ownerSession: "ses_A", summary: "fix local project", notes: "widget alpha flaw" })
  const tA = cA.ok ? cA.item.id : cA.inProgress.id
  const tB = claim(db, "fix widget alpha flaw", "ses_A")
  PM.syncAllFts(db, fts) // include the notes in A's FTS row before preflight
  const r = PM.preflight(db, { task: "fix the local project widget alpha flaw", claim: true, ownerSession: "ses_B", projectDir: dir, fts })
  check("T4 best-overlap candidate B selected (not A)", r.status === "IN_PROGRESS" && r.ticket === tB, JSON.stringify(r))
  check("T4 reuse_considered scores all candidates", Array.isArray(r.reuse_considered) && r.reuse_considered!.length === 2, JSON.stringify(r.reuse_considered))
  check("T4 B selected, A not", Array.isArray(r.reuse_considered) && r.reuse_considered!.find((c) => c.id === tB)?.selected === true && r.reuse_considered!.find((c) => c.id === tA)?.selected === false, JSON.stringify(r.reuse_considered))
  check("T4 B overlap > A overlap", Array.isArray(r.reuse_considered) && (r.reuse_considered!.find((c) => c.id === tB)!.overlap as number) > (r.reuse_considered!.find((c) => c.id === tA)!.overlap as number), JSON.stringify(r.reuse_considered))
  check("T4 match_score = B overlap (4)", r.match_score === 4, JSON.stringify(r))
}

// T5 — overlap numerically >= 2 but semantically weak (two generic tokens)
// must NOT be treated as a continuation. Threshold 3 makes {local, project}
// structurally unable to pass; if someone lowers it to 2 this test fails.
{
  const { db, dir, fts } = freshDb("t5")
  const tA = claim(db, "inspect local project", "ses_A")
  const r = PM.preflight(db, { task: "fix local project", claim: true, ownerSession: "ses_B", projectDir: dir, fts })
  check("T5 two generic tokens NOT reused", r.status === "NEW" && r.ticket !== tA, JSON.stringify(r))
  check("T5 reuse_denied overlap 2 below threshold", Array.isArray(r.reuse_denied) && r.reuse_denied!.some((d) => d.id === tA && d.overlap === 2), JSON.stringify(r.reuse_denied))
  check("T5 match_reason not semantic-continuation", r.match_reason !== "semantic-continuation", JSON.stringify(r))
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
