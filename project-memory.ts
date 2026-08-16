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
          description: "Check project memory before investigative delegation. Returns COVERED, PARTIAL, NEW, IN_PROGRESS, or MEMORY_ERROR plus relevant context. Pass returned context to the worker. claim=true reserves NEW/PARTIAL work; reclaim_ticket explicitly reclaims an orphaned IN_PROGRESS ticket.",
          args: {
            task: tool.schema.string().describe("Work to check in project memory"),
            claim: tool.schema.boolean().optional().describe("Reserve NEW/PARTIAL work (default true)"),
            reclaim_ticket: tool.schema.string().optional().describe("Explicitly reclaim this orphaned IN_PROGRESS ticket"),
            reclaim_owner: tool.schema.string().optional().describe("Expected current owner of the reclaim target (owner_session from the IN_PROGRESS preflight result); required with reclaim_ticket"),
          },
          execute: async (args: any, tctx: any) => {
            if (!handle) return JSON.stringify({ status: "MEMORY_ERROR", canonical_key: PM.normalizeKey(args.task), error: { message: "project memory unavailable", cause: "init failed" } }, null, 2)
            const agent = tctx.agent ?? ""
            const claim = args.claim !== false
            if (args.reclaim_ticket && !isPrimary(agent)) { return JSON.stringify({ status: "ERROR", error: "reclaim requires a primary agent (" + PRIMARY_AGENTS.join(", ") + "); subagents may not reclaim claims" }) }
            if (args.reclaim_ticket && !args.reclaim_owner) { return JSON.stringify({ status: "ERROR", error: "reclaim_owner is required with reclaim_ticket (pass the owner_session from the IN_PROGRESS preflight result)" }) }
            if (claim && !isPrimary(agent)) {
              return JSON.stringify({ status: "ERROR", error: `claim requires a primary agent (${PRIMARY_AGENTS.join(", ")}); subagents may query with claim=false` })
            }
            const { handle: h, result } = PM.preflightSafe(handle, { task: args.task, claim, ownerSession: tctx.sessionID, projectDir: directory, fts, reclaimTicket: args.reclaim_ticket, reclaimOwner: args.reclaim_owner })
            handle = h
            return JSON.stringify(result, null, 2)
          },
        }),
        project_record: tool({
          description: "Record the final result, evidence and reusable facts for a preflight ticket. Primary agents only.",
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
          description: "Update the managed current-goal checkpoint while preserving goal-state history. Primary agents only.",
          args: { content: tool.schema.string() },
          execute: async (args: any, tctx: any) => {
            if (!isPrimary(tctx.agent ?? "")) return JSON.stringify({ ok: false, error: "only primary agents can checkpoint goal-state" })
            const res = PM.checkpointGoal(directory, args.content)
            return JSON.stringify({ ok: true, ...res })
          },
        }),
        project_failure_append: tool({
          description: "Record a reusable failure/blocker in project memory and FAILURES.md. Use only when it can prevent repeated wasted work.",
          args: {
            symptom: tool.schema.string().describe("What failed"),
            cause: tool.schema.string().describe("Known cause, or unknown"),
            lesson: tool.schema.string().describe("What future agents should do or avoid"),
            topic: tool.schema.string().optional().describe("Optional retrieval topic"),
          },
          execute: async (args: any, tctx: any) => {
            if (!handle) return JSON.stringify({ ok: false, error: "project memory unavailable" })
            if (!PM.canAppendFailure(tctx.agent ?? "", PRIMARY_AGENTS)) return JSON.stringify({ ok: false, error: "agent is not allowed to append project failures" })
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