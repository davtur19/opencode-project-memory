import * as PM from "../lib/project-memory-lib"
import plugin from "../project-memory"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

let pass = 0, fail = 0
const check = (name: string, cond: boolean, extra = "") => { if (cond) { pass++; console.log("PASS", name) } else { fail++; console.log("FAIL", name, extra) } }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-failclosed-"))

// ---------- Test 1: DB unavailable/corrupt → MEMORY_ERROR, never NEW ----------
{
  const p = path.join(tmp, "corrupt", "memory.sqlite")
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const h = PM.openHandle(p)
  h.db.close()
  fs.writeFileSync(p, "this is definitely not a sqlite database file, garbage bytes 0123456789")
  const r = PM.preflightSafe(h, { task: "investigate anything", claim: true, ownerSession: "ses_1", projectDir: path.dirname(path.dirname(p)), fts: false })
  check("T1 corrupt → MEMORY_ERROR", r.result.status === "MEMORY_ERROR", JSON.stringify(r.result))
  check("T1 never NEW", r.result.status !== "NEW")
  const err = (r.result as any).error ?? {}
  check("T1 readable error + cause", typeof err.message === "string" && err.message.length > 0 && typeof err.cause === "string" && err.cause.length > 0, JSON.stringify(err))
}

// ---------- Test 2: gate fail-closed ----------
{
  const p = path.join(tmp, "corrupt2", "memory.sqlite")
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const h = PM.openHandle(p)
  h.db.close()
  fs.writeFileSync(p, "garbage not sqlite")
  const g = PM.gateSafe(h, { sessionID: "ses_2", args: { subagent_type: "subagent" } })
  check("T2 gate block on memory error", g.decision.action === "block", JSON.stringify(g.decision))
  check("T2 mandated message", g.decision.reason === "Project memory preflight is unavailable or inconclusive. Delegation blocked to avoid repeating or conflicting work.", g.decision.reason ?? "")
  const g2 = PM.gateSafe(h, { sessionID: "ses_2", args: { task_id: "ses_abc" } })
  check("T2 steering exempt with broken memory", g2.decision.action === "allow", JSON.stringify(g2.decision))
  const g3 = PM.gateSafe(h, { sessionID: "ses_2", args: { subagent_type: "vision" } })
  check("T2 vision exempt with broken memory", g3.decision.action === "allow", JSON.stringify(g3.decision))
}

// ---------- Test 2b: plugin-level gate (init failure → strict block) ----------
{
  const dir3 = path.join(tmp, "plugincorrupt")
  fs.mkdirSync(path.join(dir3, ".opencode"), { recursive: true })
  fs.writeFileSync(path.join(dir3, ".opencode", "memory.sqlite"), "garbage not sqlite")
  const hooks: any = await (plugin as any).server({ directory: dir3 })
  let threw = false, msg = ""
  try { await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_3", callID: "c1" }, { args: { subagent_type: "subagent", prompt: "x" } }) } catch (e: any) { threw = true; msg = e.message }
  check("T2b plugin gate blocks on init failure", threw && msg.includes("unavailable or inconclusive"), msg)
  const pre = JSON.parse(await hooks.tool.project_preflight.execute({ task: "anything", claim: true }, { sessionID: "ses_3", agent: "orchestrator", directory: dir3 }))
  check("T2b plugin preflight MEMORY_ERROR", pre.status === "MEMORY_ERROR" && !!pre.error?.message && !!pre.error?.cause, JSON.stringify(pre))
}

// ---------- Test 3: genuine no-match → NEW ----------
{
  const p = path.join(tmp, "healthy", "memory.sqlite")
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const h = PM.openHandle(p)
  const fts = PM.ftsAvailable(h.db)
  const r = PM.preflightSafe(h, { task: "zzzqqq never seen topic", claim: true, ownerSession: "ses_4", projectDir: path.dirname(path.dirname(p)), fts })
  check("T3 genuine no-match → NEW", r.result.status === "NEW" && !!r.result.ticket, JSON.stringify(r.result))
  const n = (h.db.query("SELECT COUNT(*) AS n FROM work_items WHERE canonical_key='zzzqqq never seen topic'").get() as any).n
  check("T3 exactly one row", n === 1, String(n))
}

// ---------- Test 4: transient recovery (closed connection → reopen) ----------
{
  const p = path.join(tmp, "recover", "memory.sqlite")
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const h = PM.openHandle(p)
  const fts = PM.ftsAvailable(h.db)
  const c = PM.claimWorkItem(h.db, { canonicalKey: "alpha task", ownerSession: "ses_5" })
  PM.recordResult(h.db, { ticket: c.ok ? c.item.id : c.inProgress.id, status: "done", summary: "alpha done" })
  const oldDb = h.db
  h.db.close()
  const r = PM.preflightSafe(h, { task: "alpha task", claim: false, ownerSession: "ses_5", projectDir: path.dirname(path.dirname(p)), fts })
  check("T4 recovery → COVERED", r.result.status === "COVERED", JSON.stringify(r.result))
  check("T4 reopened connection", r.handle.db !== oldDb && PM.memoryHealthy(r.handle.db))
  const h2 = PM.openHandle(p)
  h2.db.close()
  const r2 = PM.preflightSafe(h2, { task: "beta zzqq", claim: true, ownerSession: "ses_5", projectDir: path.dirname(path.dirname(p)), fts })
  check("T4 claim after recovery → NEW", r2.result.status === "NEW" && !!r2.result.ticket, JSON.stringify(r2.result))
  const n2 = (r2.handle.db.query("SELECT COUNT(*) AS n FROM work_items WHERE canonical_key='beta zzqq'").get() as any).n
  check("T4 no duplicate claim", n2 === 1, String(n2))
  const r3 = PM.preflightSafe(r2.handle, { task: "beta zzqq", claim: true, ownerSession: "ses_5", projectDir: path.dirname(path.dirname(p)), fts })
  check("T4 re-preflight same ticket", r3.result.status === "IN_PROGRESS" && r3.result.ticket === r2.result.ticket, JSON.stringify(r3.result))
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)