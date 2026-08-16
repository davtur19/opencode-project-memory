// test-v2-plugin.ts — Project-Memory V2 plugin wrapper + permissions
// Tools exist; orchestrator can record ideas; subagents are read-only (frontier
// allowed, idea_record denied); corrupt DB → clean "project memory unavailable".
import plugin from "../project-memory"
import * as PM from "../lib/project-memory-lib"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log("PASS", name) } else { fail++; console.log("FAIL", name, extra) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-v2-plugin-"))

// ---- healthy dir: real memory.sqlite via PM.openMemory, then close ----
const hdir = path.join(tmp, "healthy")
fs.mkdirSync(path.join(hdir, ".opencode"), { recursive: true })
const hdb = PM.openMemory(path.join(hdir, ".opencode", "memory.sqlite"))
PM.ftsAvailable(hdb)
hdb.close()

const hooks: any = await (plugin as any).server({ directory: hdir })

// tools exist
check("plugin exposes project_frontier", typeof hooks?.tool?.project_frontier?.execute === "function")
check("plugin exposes project_idea_record", typeof hooks?.tool?.project_idea_record?.execute === "function")

// orchestrator can record an idea
{
  const out = JSON.parse(await hooks.tool.project_idea_record.execute({ idea: { key: "p1", title: "plugin idea" } }, { sessionID: "s1", agent: "orchestrator", directory: hdir }))
  check("orchestrator idea_record ok", out.ok === true && out.idea?.key === "p1", JSON.stringify(out))
}

// subagent cannot mutate idea memory
{
  const out = JSON.parse(await hooks.tool.project_idea_record.execute({ idea: { key: "p2", title: "subagent idea" } }, { sessionID: "s2", agent: "subagent", directory: hdir }))
  check("subagent idea_record denied", out.ok === false && /primary agents/.test(out.error ?? ""), JSON.stringify(out))
}

// subagent CAN read the frontier
{
  const out = JSON.parse(await hooks.tool.project_frontier.execute({ goal: "plugin idea" }, { sessionID: "s2", agent: "subagent", directory: hdir }))
  check("subagent frontier allowed", out.ok === true && out.ideas.some((i: any) => i.key === "p1"), JSON.stringify(out))
}

// orchestrator can also read the frontier
{
  const out = JSON.parse(await hooks.tool.project_frontier.execute({ goal: "plugin idea", limit: 5 }, { sessionID: "s1", agent: "orchestrator", directory: hdir }))
  check("orchestrator frontier ok + limit clamp", out.ok === true && out.limit === 5, JSON.stringify(out))
}

// ---- corrupt db dir → tools fail closed without throwing ----
{
  const cdir = path.join(tmp, "corrupt")
  fs.mkdirSync(path.join(cdir, ".opencode"), { recursive: true })
  fs.writeFileSync(path.join(cdir, ".opencode", "memory.sqlite"), "garbage not sqlite")
  const chooks: any = await (plugin as any).server({ directory: cdir })
  let recordOut: any = null, frontierOut: any = null, threw = false
  try {
    recordOut = JSON.parse(await chooks.tool.project_idea_record.execute({ idea: { key: "x" } }, { sessionID: "s3", agent: "orchestrator", directory: cdir }))
    frontierOut = JSON.parse(await chooks.tool.project_frontier.execute({ goal: "anything" }, { sessionID: "s3", agent: "orchestrator", directory: cdir }))
  } catch { threw = true }
  check("corrupt db: no throw", !threw)
  check("corrupt db: idea_record unavailable", recordOut?.ok === false && recordOut?.error === "project memory unavailable", JSON.stringify(recordOut))
  check("corrupt db: frontier unavailable", frontierOut?.ok === false && frontierOut?.error === "project memory unavailable", JSON.stringify(frontierOut))
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)