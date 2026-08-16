// project-memory.ts — opencode plugin: project memory preflight/gate/record
import { tool } from "@opencode-ai/plugin"
import * as path from "node:path"
import * as PM from "./lib/project-memory-lib"

const PRIMARY_AGENTS = (process.env.PROJECT_MEMORY_PRIMARY_AGENTS ?? "orchestrator,orchestrator-goal").split(",").map((s) => s.trim()).filter(Boolean)
const GATE_MODE = (process.env.PROJECT_MEMORY_GATE ?? "strict") as "strict" | "warn" | "off"

export default {
  id: "project-memory",
  server: async (ctx: any) => {
    const directory = ctx?.directory
    if (!directory) return {}
    let handle: PM.MemoryHandle | null = null
    let fts = false
    try {
      handle = PM.openHandle(path.join(directory, ".opencode", "memory.sqlite"))
      fts = PM.ftsAvailable(handle.db)
      PM.bootstrap(handle.db, directory, fts)
    } catch (e) {
      console.error("[project-memory] init failed:", e)
      handle = null
    }
    const warnCalls = new Set<string>()
    const isPrimary = (agent: string) => PRIMARY_AGENTS.includes(agent)

    return {
      tool: {
        project_preflight: tool({
          description: "Project memory preflight. Before delegating investigative work, run this to check whether the work is already covered (COVERED), partially covered (PARTIAL), new (NEW), or already in progress by another worker (IN_PROGRESS). Returns a structured context packet (established facts, do-not-repeat, unresolved delta, evidence, read-first references, ticket, scratch dir). Pass the packet to the worker. claim=true (default) atomically acquires ownership for NEW/PARTIAL. Returns MEMORY_ERROR (with readable error + technical cause) when the memory is unavailable or inconclusive — in that case delegation must be blocked.",
          args: {
            task: tool.schema.string().describe("Short description of the work to be delegated"),
            claim: tool.schema.boolean().optional().describe("Acquire ownership claim (default true)"),
          },
          execute: async (args: any, tctx: any) => {
            if (!handle) return JSON.stringify({ status: "MEMORY_ERROR", canonical_key: PM.normalizeKey(args.task), error: { message: "project memory unavailable", cause: "init failed" } }, null, 2)
            const agent = tctx.agent ?? ""
            const claim = args.claim !== false
            if (claim && !isPrimary(agent)) {
              return JSON.stringify({ status: "ERROR", error: `claim requires a primary agent (${PRIMARY_AGENTS.join(", ")}); subagents may query with claim=false` })
            }
            const { handle: h, result } = PM.preflightSafe(handle, { task: args.task, claim, ownerSession: tctx.sessionID, projectDir: directory, fts })
            handle = h
            return JSON.stringify(result, null, 2)
          },
        }),
        project_record: tool({
          description: "Record the structured result of a delegated work item (ticket). Serialized single-writer registration of status, summary, evidence paths and facts. Primary agents only.",
          args: {
            ticket: tool.schema.string().describe("Work item id from project_preflight"),
            status: tool.schema.enum(["done", "blocked", "failed"]),
            summary: tool.schema.string().optional(),
            unresolved: tool.schema.string().optional().describe("Remaining unresolved delta, if any"),
            evidence: tool.schema.array(tool.schema.string()).optional().describe("File paths / report ids produced"),
            facts: tool.schema.array(tool.schema.object({ key: tool.schema.string(), value: tool.schema.string() })).optional(),
          },
          execute: async (args: any, tctx: any) => {
            if (!handle) return JSON.stringify({ ok: false, error: "project memory unavailable" })
            if (!isPrimary(tctx.agent ?? "")) return JSON.stringify({ ok: false, error: "only primary agents can record results" })
            try {
              const res = PM.recordResult(handle.db, args)
              if (res.ok) PM.syncAllFts(handle.db, fts)
              return JSON.stringify(res)
            } catch (e: any) {
              return JSON.stringify({ ok: false, error: `record failed: ${e?.message ?? e}` })
            }
          },
        }),
        project_goal_checkpoint: tool({
          description: "Write the current checkpoint section of the project goal-state.md (single logical writer: the orchestrator). Primary agents only. Content is the current checkpoint section; historical content outside the managed markers is preserved byte-for-byte.",
          args: { content: tool.schema.string() },
          execute: async (args: any, tctx: any) => {
            if (!isPrimary(tctx.agent ?? "")) return JSON.stringify({ ok: false, error: "only primary agents can checkpoint goal-state" })
            const res = PM.checkpointGoal(directory, args.content)
            return JSON.stringify({ ok: true, ...res })
          },
        }),
        project_failure_append: tool({
          description: "Append a structured failure to the project FAILURES.md via the serialized writer, with a collision-safe FAIL-YYYYMMDD-<id> identifier, and register it in project memory. Primary agents only.",
          args: {
            symptom: tool.schema.string(),
            cause: tool.schema.string(),
            lesson: tool.schema.string(),
            topic: tool.schema.string().optional().describe("Optional topic alias for retrieval"),
          },
          execute: async (args: any, tctx: any) => {
            if (!handle) return JSON.stringify({ ok: false, error: "project memory unavailable" })
            if (!isPrimary(tctx.agent ?? "")) return JSON.stringify({ ok: false, error: "only primary agents can append failures" })
            try {
              const res = PM.appendFailure(handle.db, { projectDir: directory, ...args, fts })
              PM.syncAllFts(handle.db, fts)
              return JSON.stringify({ ok: true, ...res })
            } catch (e: any) {
              return JSON.stringify({ ok: false, error: `failure append failed: ${e?.message ?? e}` })
            }
          },
        }),
      },
      event: async ({ event }: any) => {
        if (!handle) return
        const p = event?.properties
        if (!p?.sessionID) return
        if (typeof event.type === "string" && event.type.includes("session.created")) {
          const parentID = p.info?.parentID
          if (parentID) {
            try { PM.bindClaimToChild(handle.db, parentID, p.sessionID) } catch (e) { console.error("[project-memory] bindClaimToChild failed:", e) }
          }
        }
      },
      "tool.execute.before": async (input: any, output: any) => {
        if (input.tool !== "task") return
        if (GATE_MODE === "off") return
        if (!handle) {
          if (GATE_MODE === "strict") throw new Error("Project memory preflight is unavailable or inconclusive. Delegation blocked to avoid repeating or conflicting work.")
          warnCalls.add(input.callID)
          return
        }
        const { handle: h, decision } = PM.gateSafe(handle, { sessionID: input.sessionID, args: output?.args ?? {} })
        handle = h
        if (decision.action === "block") {
          throw new Error(decision.reason ?? "project-memory gate: preflight required")
        }
        if (decision.action === "warn") {
          warnCalls.add(input.callID)
        }
      },
      "tool.execute.after": async (input: any, output: any) => {
        if (input.tool === "task" && warnCalls.has(input.callID)) {
          warnCalls.delete(input.callID)
          output.output = (output.output ?? "") + "\n\n[project-memory] WARNING: task delegated without a project preflight ticket."
        }
      },
    }
  },
}