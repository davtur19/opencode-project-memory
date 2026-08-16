import * as PM from "../lib/project-memory-lib"
const dbPath = process.argv[2]
const key = process.argv[3]
const who = process.argv[4]
const db = PM.openMemory(dbPath)
PM.ftsAvailable(db)
const r = PM.claimWorkItem(db, { canonicalKey: key, ownerSession: who, summary: key })
console.log(JSON.stringify({ who, ok: r.ok, id: r.ok ? r.item.id : r.inProgress.id, owner: r.ok ? r.item.owner_session : r.inProgress.owner_session }))