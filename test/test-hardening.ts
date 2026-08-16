// test-hardening.ts — regression for the post-simplification hardening pass:
//   1. failed retry returns prior failure context/evidence (PARTIAL, same ticket);
//   2. work ownership: a foreign session cannot save an in_progress ticket;
//      the current/reclaimed owner can; reclaim race stays correct;
//   3. V2 strong-state transitions (validated/disproven) require evidence supplied
//      for THAT transition, atomically — stale evidence from a conflicting state is
//      never silently reused;
//   4. V2 relation traversal: for A -> B, searching from either A or B discovers the
//      other related idea (outgoing AND incoming expansion);
//   5. same-call V2 relations: an explicitly declared idea/condition is referenceable
//      by relations in the same call; unknown targets still fail with no placeholder;
//   6. idea search stays relevance-oriented (derived READY/BLOCKED is metadata only).
import * as PM from "../lib/project-memory-lib"
import * as PM2 from "../lib/project-memory-v2"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log("PASS", name) } else { fail++; console.log("FAIL", name, extra) }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-harden-"))
function freshDb(tag: string): { db: PM.DB; dir: string; fts: boolean } {
  const dir = fs.mkdtempSync(path.join(tmp, tag))
  const db = PM.openMemory(path.join(dir, "memory.sqlite"))
  return { db, dir, fts: PM.ftsAvailable(db) }
}
const claim = (db: PM.DB, key: string, owner: string) => {
  const c = PM.claimWorkItem(db, { canonicalKey: key, ownerSession: owner, summary: key })
  return c.ok ? c.item.id : c.inProgress.id
}
const save = (db: PM.DB, ticket: string, status: string, ownerSession: string, extra: any = {}) => PM.recordResult(db, { ticket, status, ...extra, ownerSession })

// ---- 2/3: ownership — foreign owner cannot save an in_progress ticket ----
{
  const { db, dir, fts } = freshDb("owner")
  const t = claim(db, "disable VOX25 DHCP", "ses_A")
  const foreign = save(db, t, "done", "ses_B", { summary: "stolen" })
  check("H foreign owner save denied", foreign.ok === false && /owned by ses_A/.test(foreign.reason ?? "") && /reclaim/.test(foreign.reason ?? ""), JSON.stringify(foreign))
  const row = db.query("SELECT * FROM work_items WHERE id=?").get(t) as any
  check("H foreign save leaves row untouched", row.status === "in_progress" && row.owner_session === "ses_A", JSON.stringify(row))

  // current owner CAN save
  const own = save(db, t, "done", "ses_A", { summary: "owned" })
  check("H current owner save ok", own.ok === true && own.item.status === "done", JSON.stringify(own))

  // no ownerSession presented → denied (fail closed) while still in_progress
  const t2 = claim(db, "second item", "ses_A")
  const noSess = PM.recordResult(db, { ticket: t2, status: "done", summary: "x" })
  check("H missing ownerSession denied", noSess.ok === false && /session unknown/.test(noSess.reason ?? ""), JSON.stringify(noSess))
}

// ---- 2: current/reclaimed owner can save; reclaim race stays correct ----
{
  const { db, dir, fts } = freshDb("reclaimowner")
  const t = claim(db, "disable VOX25 DHCP", "ses_A")
  const r = PM.preflight(db, { task: "disable VOX25 DHCP", claim: true, ownerSession: "ses_B", projectDir: dir, fts, reclaimTicket: t, reclaimOwner: "ses_A" })
  check("H reclaim ok", r.status === "NEW" && r.ticket === t && r.owner_session === "ses_B", JSON.stringify(r))
  const old = save(db, t, "done", "ses_A")
  check("H pre-reclaim owner save denied after reclaim", old.ok === false, JSON.stringify(old))
  const rec = save(db, t, "done", "ses_B", { summary: "reclaimed work done" })
  check("H reclaimed owner save ok", rec.ok === true && rec.item.owner_session === "ses_B" && rec.item.status === "done", JSON.stringify(rec))

  // reclaim race: exactly one winner still
  const { db: dbR, dir: dirR, fts: ftsR } = freshDb("reclaimrace")
  const tR = claim(dbR, "disable VOX25 DHCP", "ses_orphan")
  const results = await Promise.all(Array.from({ length: 8 }, async (_, i) => PM.preflight(dbR, { task: "disable VOX25 DHCP", claim: true, ownerSession: "ses_race_" + i, projectDir: dirR, fts: ftsR, reclaimTicket: tR, reclaimOwner: "ses_orphan" })))
  const winners = results.filter((r) => r.status === "NEW" && r.ticket === tR)
  check("H reclaim race exactly one winner", winners.length === 1, JSON.stringify(results.map((r) => ({ s: r.status, o: r.owner_session }))))
  const w = winners[0] as any
  // losers must be denied while the ticket is still in_progress (owned by the winner);
  // loser identity = the race sessions that did NOT win (IN_PROGRESS results report the
  // current owner, so derive losers from the session ids directly)
  let loserDenied = true
  for (let i = 0; i < 8; i++) {
    const who = "ses_race_" + i
    if (who === w.owner_session) continue
    const l = save(dbR, tR, "done", who)
    if (l.ok) loserDenied = false
  }
  check("H race loser save denied (in_progress)", loserDenied)
  const saveW = save(dbR, tR, "done", w.owner_session, { summary: "winner done" })
  check("H race winner can save", saveW.ok === true, JSON.stringify(saveW))
}

// ---- 5: V2 strong-state transition without new evidence fails atomically ----
{
  const { db, dir, fts } = freshDb("evidence")
  PM2.ensureV2Schema(db, fts)
  PM2.ideaRecord(db, { idea: { key: "transition idea", summary: "t" } })

  // proposed -> validated without evidence → denied, atomically (stays proposed)
  const v1 = PM2.ideaRecord(db, { idea: { key: "transition idea", status: "validated" } })
  check("H validated transition no evidence denied", v1.ok === false && /evidence supplied/.test(v1.error ?? ""), JSON.stringify(v1))
  let row = db.query("SELECT * FROM ideas WHERE canonical_key='transition idea'").get() as any
  check("H denied transition atomic (status unchanged)", row.status === "proposed" && row.evidence === "", JSON.stringify(row))

  // proposed -> validated WITH evidence → ok
  const v2 = PM2.ideaRecord(db, { idea: { key: "transition idea", status: "validated", evidence: "evidence-v1" } })
  check("H validated with evidence ok", v2.ok === true && v2.idea?.status === "validated" && v2.idea?.evidence === "evidence-v1", JSON.stringify(v2))

  // validated -> disproven WITHOUT evidence → denied (stale validated evidence NOT reused), atomic
  const d1 = PM2.ideaRecord(db, { idea: { key: "transition idea", status: "disproven" } })
  check("H validated->disproven no evidence denied", d1.ok === false && /evidence supplied/.test(d1.error ?? ""), JSON.stringify(d1))
  row = db.query("SELECT * FROM ideas WHERE canonical_key='transition idea'").get() as any
  check("H disproven denied atomic (still validated, evidence-v1)", row.status === "validated" && row.evidence === "evidence-v1", JSON.stringify(row))
  const relCount = (db.query("SELECT COUNT(*) AS n FROM idea_relations").get() as { n: number }).n

  // validated -> disproven WITH evidence → ok
  const d2 = PM2.ideaRecord(db, { idea: { key: "transition idea", status: "disproven", evidence: "evidence-v2" } })
  check("H disproven with evidence ok", d2.ok === true && d2.idea?.status === "disproven" && d2.idea?.evidence === "evidence-v2", JSON.stringify(d2))
  row = db.query("SELECT * FROM ideas WHERE canonical_key='transition idea'").get() as any
  check("H disproven applied", row.status === "disproven" && row.evidence === "evidence-v2", JSON.stringify(row))

  // re-save same strong status without new evidence → allowed, evidence kept
  const keep = PM2.ideaRecord(db, { idea: { key: "transition idea", summary: "touched" } })
  check("H same strong status keeps evidence", keep.ok === true && keep.idea?.status === "disproven" && keep.idea?.evidence === "evidence-v2", JSON.stringify(keep))
  const keep2 = PM2.ideaRecord(db, { idea: { key: "transition idea", status: "disproven" } })
  check("H explicit same strong status no evidence ok", keep2.ok === true && keep2.idea?.evidence === "evidence-v2", JSON.stringify(keep2))

  // disproven -> validated without evidence → denied, atomic
  const back = PM2.ideaRecord(db, { idea: { key: "transition idea", status: "validated" } })
  check("H disproven->validated no evidence denied", back.ok === false && /evidence supplied/.test(back.error ?? ""), JSON.stringify(back))
  row = db.query("SELECT * FROM ideas WHERE canonical_key='transition idea'").get() as any
  check("H validated denied atomic (still disproven, evidence-v2)", row.status === "disproven" && row.evidence === "evidence-v2", JSON.stringify(row))
  check("H no relations leaked", (db.query("SELECT COUNT(*) AS n FROM idea_relations").get() as { n: number }).n === relCount)
}

// ---- 4: relation traversal — outgoing AND incoming discovery ----
{
  const { db, dir, fts } = freshDb("traversal")
  PM2.ensureV2Schema(db, fts)
  PM2.ideaRecord(db, { idea: { key: "alpha source", title: "zebra alpha", summary: "zebra alpha content" } })
  PM2.ideaRecord(db, { idea: { key: "beta target", title: "banana beta", summary: "banana beta content" } })
  PM2.ideaRecord(db, { idea: { key: "alpha source" }, relations: [{ idea: "alpha source", kind: "requires", target: "idea:beta target" }] })

  const out = PM2.projectFrontier(db, { goal: "zebra alpha" })
  const outKeys = out.ideas.map((i) => i.key)
  check("H outgoing search finds target", outKeys.includes("beta target") && outKeys.includes("alpha source"), outKeys.join(","))

  const inc = PM2.projectFrontier(db, { goal: "banana beta" })
  const incKeys = inc.ideas.map((i) => i.key)
  check("H incoming search finds source", incKeys.includes("alpha source") && incKeys.includes("beta target"), incKeys.join(","))
  check("H incoming search still shows the relation", inc.relations.some((r) => r.idea === "alpha source" && r.kind === "requires" && r.target === "idea:beta target"), JSON.stringify(inc.relations))
}

// ---- 5: same-call explicit condition/relation ----
{
  const { db, dir, fts } = freshDb("samecall")
  PM2.ensureV2Schema(db, fts)
  const r = PM2.ideaRecord(db, {
    idea: { key: "samecall idea", summary: "sc" },
    conditions: [{ key: "C1", description: "cond c1" }],
    relations: [{ idea: "samecall idea", kind: "requires", target: "condition:C1" }],
  })
  check("H same-call condition target ok", r.ok === true && r.relations?.some((rel) => rel.kind === "requires" && rel.target === "condition:c1"), JSON.stringify(r))
  check("H same-call condition created", (db.query("SELECT COUNT(*) AS n FROM conditions WHERE canonical_key='c1'").get() as { n: number }).n === 1)
  const aId = (db.query("SELECT id FROM ideas WHERE canonical_key='samecall idea'").get() as any).id
  const d = PM2.derivedStateFor(db, aId)
  check("H same-call idea derived blocked", d.derived === "blocked" && d.blockers.some((b: any) => b.type === "condition" && b.key === "c1"), JSON.stringify(d))

  // same-call bare condition reference too
  const r2 = PM2.ideaRecord(db, { idea: { key: "samecall idea" }, conditions: [{ key: "C2" }], relations: [{ idea: "samecall idea", kind: "enables", target: "C2" }] })
  check("H same-call bare condition target ok", r2.ok === true && r2.relations?.some((rel) => rel.kind === "enables" && rel.target === "condition:c2"), JSON.stringify(r2))

  // the same-call idea as a relation target
  PM2.ideaRecord(db, { idea: { key: "other idea" } })
  const r3 = PM2.ideaRecord(db, { idea: { key: "samecall idea" }, relations: [{ idea: "other idea", kind: "combines_with", target: "idea:samecall idea" }] })
  check("H same-call idea as target ok", r3.ok === true && r3.relations?.some((rel) => rel.kind === "combines_with" && rel.target === "idea:samecall idea"), JSON.stringify(r3))

  // unknown target (not in DB, not declared in the call) → still fails, no placeholder
  const before = (db.query("SELECT COUNT(*) AS n FROM conditions").get() as { n: number }).n
  const bad = PM2.ideaRecord(db, { idea: { key: "samecall idea" }, relations: [{ idea: "samecall idea", kind: "requires", target: "condition:never-declared" }] })
  check("H unknown same-call target denied", bad.ok === false && /target not found/.test(bad.error ?? ""), JSON.stringify(bad))
  check("H unknown target no placeholder condition", (db.query("SELECT COUNT(*) AS n FROM conditions").get() as { n: number }).n === before)
  check("H unknown target no placeholder idea", (db.query("SELECT COUNT(*) AS n FROM ideas WHERE canonical_key='never-declared'").get() as { n: number }).n === 0)
}

// ---- 6: idea search stays relevance-oriented (derived is metadata, not a sort key) ----
{
  const { db, dir, fts } = freshDb("ordering")
  PM2.ensureV2Schema(db, fts)
  PM2.ideaRecord(db, { idea: { key: "ready topic", summary: "widget ready idea here" } })
  PM2.ideaRecord(db, { idea: { key: "validated topic", summary: "widget widget widget widget" }, status: "validated", evidence: "evidence" })
  const f = PM2.projectFrontier(db, { goal: "widget" })
  const keys = f.ideas.map((i) => i.key)
  check("H relevance order preserved (validated first, not ready-first)", keys[0] === "validated topic" && keys.includes("ready topic"), keys.join(","))
  const v = f.ideas.find((i) => i.key === "validated topic")
  check("H derived returned as metadata", v?.derived === "validated", JSON.stringify(v?.derived))
  const rd = f.ideas.find((i) => i.key === "ready topic")
  check("H ready still reported as derived ready", rd?.derived === "ready", JSON.stringify(rd?.derived))
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)