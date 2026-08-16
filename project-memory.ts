// project-memory.ts — opencode plugin: project memory work/idea tools
import { tool } from "@opencode-ai/plugin"
import * as path from "node:path"
import * as PM from "./lib/project-memory-lib"
import * as PM2 from "./lib/project-memory-v2"

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
      PM2.ensureV2Schema(handle.db, fts)
    } catch (e) {
      console.error("[project-memory] init failed:", e)
      handle = null
    }
    const warnCalls = new Set<string>()
    const isPrimary = (agent: string) => PRIMARY_AGENTS.includes(agent)

    return {
      tool: {
        project_work_check: tool({
          description: "Check project memory before starting investigative work. Returns prior context and whether the work is new, partial, covered, or already in progress.",
          args: {
            work: tool.schema.string().describe("Work to check in project memory"),
            claim: tool.schema.boolean().optional().describe("Reserve NEW/PARTIAL work (default true)"),
            reclaim_ticket: tool.schema.string().optional().describe("Reclaim this orphaned IN_PROGRESS ticket"),
            reclaim_owner: tool.schema.string().optional().describe("Expected current owner of the reclaim target"),
          },
          execute: async (args: any, tctx: any) => {
            if (!handle) return JSON.stringify({ status: "MEMORY_ERROR", canonical_key: PM.normalizeKey(args.work), error: { message: "project memory unavailable", cause: "init failed" } }, null, 2)
            const agent = tctx.agent ?? ""
            const claim = args.claim !== false
            if (args.reclaim_ticket && !isPrimary(agent)) { return JSON.stringify({ status: "ERROR", error: "reclaim requires a primary agent (" + PRIMARY_AGENTS.join(", ") + "); subagents may not reclaim claims" }) }
            if (args.reclaim_ticket && !args.reclaim_owner) { return JSON.stringify({ status: "ERROR", error: "reclaim_owner is required with reclaim_ticket (pass the owner_session from the IN_PROGRESS preflight result)" }) }
            if (claim && !isPrimary(agent)) {
              return JSON.stringify({ status: "ERROR", error: `claim requires a primary agent (${PRIMARY_AGENTS.join(", ")}); subagents may query with claim=false` })
            }
            const { handle: h, result } = PM.preflightSafe(handle, { task: args.work, claim, ownerSession: tctx.sessionID, projectDir: directory, fts, reclaimTicket: args.reclaim_ticket, reclaimOwner: args.reclaim_owner })
            handle = h
            return JSON.stringify(result, null, 2)
          },
        }),
        project_work_save: tool({
          description: "Save durable results, evidence and reusable facts learned from work.",
          args: {
            ticket: tool.schema.string().describe("Work item id from project_work_check"),
            status: tool.schema.enum(["done", "blocked", "failed"]),
            summary: tool.schema.string().optional().describe("Result summary"),
            unresolved: tool.schema.string().optional().describe("Remaining unresolved delta, if any"),
            evidence: tool.schema.array(tool.schema.string()).optional().describe("File paths / report ids produced"),
            facts: tool.schema.array(tool.schema.object({ key: tool.schema.string(), value: tool.schema.string() })).optional().describe("Reusable facts learned"),
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
        project_goal_update: tool({
          description: "Update goal progress worth preserving across compaction or continuation.",
          args: { progress: tool.schema.string().describe("Goal progress to preserve") },
          execute: async (args: any, tctx: any) => {
            if (!isPrimary(tctx.agent ?? "")) return JSON.stringify({ ok: false, error: "only primary agents can update goal-state" })
            const res = PM.checkpointGoal(directory, args.progress)
            return JSON.stringify({ ok: true, ...res })
          },
        }),
        project_failure_save: tool({
          description: "Save a reusable failure or blocker when it can prevent repeated wasted work.",
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
        project_idea_save: tool({
          description: "Save or update a durable idea, prerequisite and its relations.",
          args: {
            idea: tool.schema.object({
              key: tool.schema.string().optional(),
              id: tool.schema.string().optional(),
              title: tool.schema.string().optional(),
              summary: tool.schema.string().optional(),
              status: tool.schema.enum(["proposed", "testing", "validated", "disproven", "dormant"]).optional(),
              rationale: tool.schema.string().optional(),
              evidence: tool.schema.string().optional(),
            }).optional().describe("Idea to save or update"),
            conditions: tool.schema.array(tool.schema.object({
              key: tool.schema.string(),
              description: tool.schema.string().optional(),
              satisfied: tool.schema.boolean().optional(),
              satisfied_by: tool.schema.string().optional(),
            })).optional().describe("Prerequisites to save or update"),
            relations: tool.schema.array(tool.schema.object({
              idea: tool.schema.string(),
              kind: tool.schema.enum(PM2.RELATION_KINDS as unknown as [string, ...string[]]),
              target: tool.schema.string(),
            })).optional().describe("Relations to add"),
            satisfies: tool.schema.array(tool.schema.string()).optional().describe("Condition keys this idea satisfies"),
            remove_relations: tool.schema.array(tool.schema.object({
              idea: tool.schema.string(),
              kind: tool.schema.enum(PM2.RELATION_KINDS as unknown as [string, ...string[]]),
              target: tool.schema.string(),
            })).optional().describe("Relations to remove"),
          },
          execute: async (args: any, tctx: any) => {
            if (!handle) return JSON.stringify({ ok: false, error: "project memory unavailable" })
            if (!isPrimary(tctx.agent ?? "")) return JSON.stringify({ ok: false, error: "only primary agents can mutate idea memory (subagents report hypotheses to the orchestrator)" })
            try {
              return JSON.stringify(PM2.ideaRecord(handle.db, args))
            } catch (e: any) {
              return JSON.stringify({ ok: false, error: `idea_save failed: ${e?.message ?? e}` })
            }
          },
        }),
        project_idea_search: tool({
          description: "Search durable project ideas, prerequisites and relations relevant to exploratory work.",
          args: {
            query: tool.schema.string().describe("Goal/topic to search for in idea memory"),
            limit: tool.schema.number().int().min(1).max(20).optional().describe("Max ideas to return (default 8)"),
          },
          execute: async (args: any, tctx: any) => {
            if (!handle) return JSON.stringify({ ok: false, error: "project memory unavailable" })
            if (tctx.agent === "subagent") return JSON.stringify({ ok: false, error: "subagents may not search idea memory (report hypotheses to the orchestrator)" })
            try {
              return JSON.stringify(PM2.projectFrontier(handle.db, { goal: args.query, limit: args.limit }))
            } catch (e: any) {
              return JSON.stringify({ ok: false, error: `idea_search failed: ${e?.message ?? e}` })
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