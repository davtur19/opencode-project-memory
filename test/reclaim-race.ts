// reclaim-race.ts — multi-process R3: exactly one concurrent reclaim wins.
// Worker mode: argv = [bun, script, dbPath, ticket, who, task]
// Runner mode: no args → spawns N workers against a shared DB and asserts a single winner.
import * as PM from "../lib/project-memory-lib"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

if (process.argv.length >= 6) {
  const dbPath = process.argv[2]
  const ticket = process.argv[3]
  const who = process.argv[4]
  const task = process.argv[5]
  const db = PM.openMemory(dbPath)
  PM.ftsAvailable(db)
  const r = PM.preflight(db, { task, claim: true, ownerSession: who, projectDir: "/tmp", fts: false, reclaimTicket: ticket })
  console.log(JSON.stringify({ who, status: r.status, ticket: r.ticket, owner: r.owner_session, reclaim_error: (r as any).reclaim_error }))
  process.exit(0)
}

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log("PASS", name) } else { fail++; console.log("FAIL", name, extra) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-reclaim-race-"))
const dbPath = path.join(tmp, "memory.sqlite")
const db = PM.openMemory(dbPath)
PM.ftsAvailable(db)
const c = PM.claimWorkItem(db, { canonicalKey: "disable VOX25 DHCP", ownerSession: "ses_orphan", summary: "disable VOX25 DHCP" })
const ticket = c.ok ? c.item.id : c.inProgress.id
db.close()

const N = 8
const runWorker = (i: number) => new Promise<any>(async (resolve, reject) => {
  try {
    const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "reclaim-race.ts"), dbPath, ticket, "ses_race_" + i, "disable VOX25 DHCP"], { stdout: "pipe" })
    const out = await new Response(proc.stdout).text()
    resolve(JSON.parse(out.trim()))
  } catch (e) {
    reject(e)
  }
})

const results = await Promise.all(Array.from({ length: N }, (_, i) => runWorker(i)))
const winners = results.filter((r) => r.status === "NEW" && r.ticket === ticket)
check("race exactly one winner", winners.length === 1, JSON.stringify(results))
const winner = winners[0]

const db2 = PM.openMemory(dbPath)
const n = (db2.query("SELECT COUNT(*) AS n FROM work_items WHERE canonical_key='disable vox25 dhcp'").get() as { n: number }).n
check("race count 1", n === 1, String(n))
const row = db2.query("SELECT * FROM work_items WHERE id=?").get(ticket) as any
check("race row in_progress", row.status === "in_progress", JSON.stringify(row))
check("race owner = winner", row.owner_session === winner.who, JSON.stringify(row))
db2.close()

console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)