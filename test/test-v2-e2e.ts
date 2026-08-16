// test-v2-e2e.ts — Project-Memory V2 mini end-to-end acceptance proof.
// Scenario: a DHCP-token hypothesis (idea-a) blocked on an unsatisfied condition,
// made actionable by a validated bench test (idea-b), a disproven tunnel idea
// (idea-c), a dependent idea (idea-d) and an unrelated idea (idea-z).
// Keys are normalized: input "idea-a" is stored/returned as canonical "idea a".
import * as PM from "../lib/project-memory-lib"
import * as PM2 from "../lib/project-memory-v2"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log("PASS", name) } else { fail++; console.log("FAIL", name, extra) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-v2-e2e-"))
const db = PM.openMemory(path.join(dir, "memory.sqlite"))
const fts = PM.ftsAvailable(db)
PM2.ensureV2Schema(db, fts)

// 1. idea-a blocked on an open condition
{
  const r = PM2.ideaRecord(db, { idea: { key: "idea-a", title: "unlock admin via DHCP trick", summary: "inject a token through the DHCP option to reach the admin shell" }, relations: [{ idea: "idea-a", kind: "requires", target: "condition:dhcp-token-verified" }] })
  check("1 idea-a recorded", r.ok === true && r.idea?.status === "proposed" && r.relations?.length === 1, JSON.stringify(r))
}

// 2. frontier shows idea-a blocked with the open condition
let ideaAId = ""
{
  const f = PM2.projectFrontier(db, { goal: "unlock admin via DHCP trick" })
  const a = f.ideas.find((i: any) => i.key === "idea a")
  check("2 frontier includes idea-a", !!a, JSON.stringify(f.ideas.map((i: any) => i.key)))
  check("2 idea-a derived blocked", a?.derived === "blocked", JSON.stringify(a?.derived))
  check("2 blockers include dhcp-token-verified", a?.blockers.some((b: any) => b.type === "condition" && b.key === "dhcp token verified"), JSON.stringify(a?.blockers))
  check("2 conditions include open dhcp-token-verified", f.conditions.some((c: any) => c.key === "dhcp token verified" && c.satisfied === false), JSON.stringify(f.conditions))
  ideaAId = a?.id ?? ""
}

// 3. idea-b validated, satisfies the condition (status passed at top level, per spec)
{
  const r = PM2.ideaRecord(db, { idea: { key: "idea-b", title: "token test on bench device", summary: "bench dhcp capture" }, status: "validated", satisfies: ["dhcp-token-verified"] })
  check("3 idea-b validated + satisfies", r.ok === true && r.idea?.status === "validated", JSON.stringify(r))
}

// 4. frontier again: idea-a SAME id, now ready, still persisted as proposed
{
  const f = PM2.projectFrontier(db, { goal: "unlock admin via DHCP trick" })
  const a = f.ideas.find((i: any) => i.key === "idea a")
  check("4 idea-a SAME id (not recreated)", !!a && a.id === ideaAId, JSON.stringify({ had: a?.id, expected: ideaAId }))
  check("4 idea-a derived ready", a?.derived === "ready", JSON.stringify(a?.derived))
  check("4 idea-a blockers empty", a?.blockers.length === 0, JSON.stringify(a?.blockers))
  const persisted = db.query("SELECT status FROM ideas WHERE canonical_key='idea a'").get() as any
  check("4 idea-a persisted status still proposed", persisted?.status === "proposed", JSON.stringify(persisted))
}

// 5. disproven idea is remembered but never actionable
{
  const r = PM2.ideaRecord(db, { idea: { key: "idea-c", title: "tunnel via FTP bounce", summary: "bounce a tunnel through the ftp proxy" }, status: "disproven" })
  check("5 idea-c disproven recorded", r.ok === true && r.idea?.status === "disproven", JSON.stringify(r))
  const f = PM2.projectFrontier(db, { goal: "FTP bounce tunnel" })
  const c = f.ideas.find((i: any) => i.key === "idea c")
  check("5 idea-c remembered in frontier", !!c, JSON.stringify(f.ideas.map((i: any) => i.key)))
  check("5 idea-c derived disproven", c?.derived === "disproven", JSON.stringify(c?.derived))
  check("5 idea-c not ready/blocked", c?.derived !== "ready" && c?.derived !== "blocked", JSON.stringify(c?.derived))
  const persisted = db.query("SELECT status FROM ideas WHERE canonical_key='idea c'").get() as any
  check("5 idea-c persisted disproven", persisted?.status === "disproven", JSON.stringify(persisted))
}

// 6. dependent idea: disproven != blocked
{
  const r = PM2.ideaRecord(db, { idea: { key: "idea-d", summary: "depends on c" }, relations: [{ idea: "idea-d", kind: "requires", target: "idea:idea-c" }] })
  check("6 idea-d requires c", r.ok === true, JSON.stringify(r))
  const f = PM2.projectFrontier(db, { goal: "idea-d" })
  const d = f.ideas.find((i: any) => i.key === "idea d")
  const c = f.ideas.find((i: any) => i.key === "idea c")
  check("6 idea-d derived blocked", d?.derived === "blocked" && d?.blockers.some((b: any) => /disproven/i.test(b.note)), JSON.stringify(d))
  check("6 disproven != blocked (idea-c disproven, idea-d blocked)", c?.derived === "disproven" && d?.derived === "blocked", JSON.stringify({ c: c?.derived, d: d?.derived }))
}

// 7. bounded related retrieval: neighbor via combines_with, unrelated idea excluded
{
  PM2.ideaRecord(db, { idea: { key: "idea-z", title: "unrelated rust crate audit", summary: "audit a rust crate for supply chain issues" }, relations: [] })
  const r = PM2.ideaRecord(db, { idea: { key: "idea-a" }, relations: [{ idea: "idea-a", kind: "combines_with", target: "idea:idea-b" }] })
  check("7 combines_with relation added", r.ok === true && r.relations?.some((rel: any) => rel.kind === "combines_with" && rel.target === "idea:idea b"), JSON.stringify(r.relations))
  const f = PM2.projectFrontier(db, { goal: "unlock admin via DHCP trick", limit: 8 })
  const keys = f.ideas.map((i: any) => i.key)
  check("7 includes idea-a", keys.includes("idea a"), keys.join(","))
  check("7 includes idea-b via neighbor expansion", keys.includes("idea b"), keys.join(","))
  check("7 does NOT include idea-z", !keys.includes("idea z"), keys.join(","))
  check("7 bounded <= 8", f.ideas.length <= 8, String(f.ideas.length))
  console.log("  count:", f.ideas.length, "keys:", keys.join(", "))
  const fz = PM2.projectFrontier(db, { goal: "rust crate audit" })
  const zkeys = fz.ideas.map((i: any) => i.key)
  check("7 rust goal includes idea-z only", zkeys.includes("idea z") && zkeys.length === 1, zkeys.join(","))
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)