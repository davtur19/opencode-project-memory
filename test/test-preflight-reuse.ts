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

// T1 — unrelated active ticket is NOT reused (the reported bug)
{
  const { db, dir, fts } = freshDb("t1")
  const tA = claim(db, "investigate why session X hangs when starting a goal", "ses_A")
  const r = PM.preflight(db, { task: "sync a git branch with upstream and open a pull request", claim: true, ownerSession: "ses_B", projectDir: dir, fts })
  check("T1 unrelated active ticket NOT reused", r.status === "NEW" && r.ticket !== tA, JSON.stringify(r))
  check("T1 a new ticket is created", !!r.ticket && r.ticket !== tA, JSON.stringify(r))
}

// T2 — legitimate continuation (rephrasing) still reuses the same ticket
{
  const { db, dir, fts } = freshDb("t2")
  const tA = claim(db, "investigate why session X hangs when starting a goal", "ses_A")
  const r = PM.preflight(db, { task: "find out why session x is stuck at goal start", claim: true, ownerSession: "ses_B", projectDir: dir, fts })
  check("T2 legit continuation reuses same ticket", r.status === "IN_PROGRESS" && r.ticket === tA, JSON.stringify(r))
}

// T3 — unrelated task in the SAME session/scope is NOT reused
{
  const { db, dir, fts } = freshDb("t3")
  const tA = claim(db, "investigate why session X hangs when starting a goal", "ses_A")
  const r = PM.preflight(db, { task: "compile a rust program for the embedded target", claim: true, ownerSession: "ses_A", projectDir: dir, fts })
  check("T3 same-session unrelated NOT reused", r.status === "NEW" && r.ticket !== tA, JSON.stringify(r))
}

// T4 — diagnostics: requested vs matched key, reason, score
{
  const { db, dir, fts } = freshDb("t4")
  const tA = claim(db, "investigate why session X hangs when starting a goal", "ses_A")
  const r = PM.preflight(db, { task: "find out why session x is stuck at goal start", claim: true, ownerSession: "ses_B", projectDir: dir, fts })
  check("T4 requested_key present", !!r.requested_key, JSON.stringify(r))
  check("T4 matched_key is stored ticket key", r.matched_key === "investigate why session x hangs when starting a goal", JSON.stringify(r))
  check("T4 requested != matched", r.requested_key !== r.matched_key, JSON.stringify(r))
  check("T4 match_reason exposed", r.match_reason === "semantic-continuation", JSON.stringify(r))
  check("T4 match_score numeric", typeof r.match_score === "number", JSON.stringify(r))
  const r2 = PM.preflight(db, { task: "brand new unrelated topic zzqq", claim: true, ownerSession: "ses_B", projectDir: dir, fts })
  check("T4 created path reason", r2.status === "NEW" && r2.match_reason === "created" && r2.matched_key === r2.requested_key, JSON.stringify(r2))
}

// T5 — loose single-token overlap cannot override identity; exact still works
{
  const { db, dir, fts } = freshDb("t5")
  const tA = claim(db, "inspect the local database for leaked credentials", "ses_A")
  const r = PM.preflight(db, { task: "create a local branch and commit the fix", claim: true, ownerSession: "ses_B", projectDir: dir, fts })
  check("T5 single-token overlap NOT reused", r.status === "NEW" && r.ticket !== tA, JSON.stringify(r))
  check("T5 reuse_denied explains rejection", Array.isArray(r.reuse_denied) && r.reuse_denied!.some((d) => d.id === tA), JSON.stringify(r))
  check("T5 overlap reported < threshold", Array.isArray(r.reuse_denied) && (r.reuse_denied!.find((d) => d.id === tA)!.overlap as number) < 2, JSON.stringify(r))
  const r2 = PM.preflight(db, { task: "inspect the local database for leaked credentials", claim: false, ownerSession: "ses_B", projectDir: dir, fts })
  check("T5 exact match still IN_PROGRESS", r2.status === "IN_PROGRESS" && r2.ticket === tA, JSON.stringify(r2))
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
