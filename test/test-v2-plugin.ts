// test-v2-plugin.ts — Project-Memory V2 plugin wrapper + permissions
// Tools exist; orchestrator can record ideas; subagents are denied (idea_search
// and idea_save denied); corrupt DB → clean "project memory unavailable".
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
check("plugin exposes project_idea_search", typeof hooks?.tool?.project_idea_search?.execute === "function")
check("plugin exposes project_idea_save", typeof hooks?.tool?.project_idea_save?.execute === "function")

// orchestrator can record an idea
{
  const out = JSON.parse(await hooks.tool.project_idea_save.execute({ idea: { key: "p1", title: "plugin idea" } }, { sessionID: "s1", agent: "orchestrator", directory: hdir }))
  check("orchestrator idea_save ok", out.ok === true && out.idea?.key === "p1", JSON.stringify(out))
}

// subagent cannot mutate idea memory
{
  const out = JSON.parse(await hooks.tool.project_idea_save.execute({ idea: { key: "p2", title: "subagent idea" } }, { sessionID: "s2", agent: "subagent", directory: hdir }))
  check("subagent idea_save denied", out.ok === false && /primary agents/.test(out.error ?? ""), JSON.stringify(out))
}

// subagent CANNOT search idea memory
{
  const out = JSON.parse(await hooks.tool.project_idea_search.execute({ query: "plugin idea" }, { sessionID: "s2", agent: "subagent", directory: hdir }))
  check("subagent idea_search denied", out.ok === false && /subagents may not search/.test(out.error ?? ""), JSON.stringify(out))
}

// orchestrator CAN search idea memory
{
  const out = JSON.parse(await hooks.tool.project_idea_search.execute({ query: "plugin idea", limit: 5 }, { sessionID: "s1", agent: "orchestrator", directory: hdir }))
  check("orchestrator idea_search ok + limit clamp", out.ok === true && out.limit === 5, JSON.stringify(out))
}

// ---- corrupt db dir → tools fail closed without throwing ----
{
  const cdir = path.join(tmp, "corrupt")
  fs.mkdirSync(path.join(cdir, ".opencode"), { recursive: true })
  fs.writeFileSync(path.join(cdir, ".opencode", "memory.sqlite"), "garbage not sqlite")
  const chooks: any = await (plugin as any).server({ directory: cdir })
  let recordOut: any = null, frontierOut: any = null, threw = false
  try {
    recordOut = JSON.parse(await chooks.tool.project_idea_save.execute({ idea: { key: "x" } }, { sessionID: "s3", agent: "orchestrator", directory: cdir }))
    frontierOut = JSON.parse(await chooks.tool.project_idea_search.execute({ query: "anything" }, { sessionID: "s3", agent: "orchestrator", directory: cdir }))
  } catch { threw = true }
  check("corrupt db: no throw", !threw)
  check("corrupt db: idea_save unavailable", recordOut?.ok === false && recordOut?.error === "project memory unavailable", JSON.stringify(recordOut))
  check("corrupt db: idea_search unavailable", frontierOut?.ok === false && frontierOut?.error === "project memory unavailable", JSON.stringify(frontierOut))
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
