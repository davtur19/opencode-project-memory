# opencode-project-memory

Persistent project memory for OpenCode agents. SQLite is the canonical operational memory: the plugin stores all state in a local `.opencode/memory.sqlite` database and exposes exactly five tools.

The plugin persists and retrieves state. The LLM generates, combines and chooses ideas. There is no DAG, no scheduler, no graph database, no embeddings, no gate, and no task orchestration.

## What it stores

- **V1 — work memory**: work items, findings, evidence and reusable failures. It prevents duplicate investigative work and keeps project state across sessions.
- **V2 — idea memory**: ideas (hypotheses), prerequisites (conditions) and their relations. Ideas are separate from established facts.

Markdown under `.opencode/` is legacy/read-only documentation: it may be indexed for `read_first` context but is never operational state and is never imported back into work items.

## Tools

Exactly five public tools:

- `project_work_check`: Check project memory before starting investigative work. Returns prior context and whether the work is new, partial, covered, already in progress, or a memory error. Pass `reclaim_ticket` + `reclaim_owner` to take over an orphaned IN_PROGRESS claim.
- `project_work_save`: Save durable results and evidence learned from work.
- `project_failure_save`: Save a reusable failure or blocker when it can prevent repeated wasted work.
- `project_idea_search`: Search durable project ideas, prerequisites and relations relevant to exploratory work.
- `project_idea_save`: Save or update a durable idea, prerequisite and its relations.

There are no hooks, no event listeners, no task gate (no `PROJECT_MEMORY_GATE`) and no `project_goal_update`. project-memory detects and coordinates duplicate work through claims; it never intercepts or schedules `task()`. Task lifecycle, child sessions, steering and scheduling belong to OpenCode.

## Work loop (V1)

1. Before investigative work, call `project_work_check(work=...)`. A claim (default `claim: true`) atomically reserves NEW/PARTIAL work; pass `claim: false` to only query.
2. The result carries `status`, `ticket`, `established`, `do_not_repeat`, `unresolved`, `evidence`, `read_first`, `scratch`, and `candidates`. Do not repeat COVERED or IN_PROGRESS work. For PARTIAL work, do only the unresolved delta. Retrying previously `failed` work returns PARTIAL on the SAME ticket with the prior failure context, a `do_not_repeat` for the failed attempt, the prior evidence and the still-open unresolved work — never fresh NEW work with empty context.
3. Save the result with `project_work_save(ticket=..., status=..., summary=..., evidence=...)`. A ticket is owned by the session that claimed it: if the ticket has an owner, only that owner may record on it — in progress or terminal (`done`/`blocked`/`failed`/`covered`/`new`) alike. A stale pre-reclaim owner cannot overwrite a result recorded by the new owner. Legacy rows with no owner remain writable by any caller.
4. If `project_work_check` returns IN_PROGRESS, never retry `task()` for that work. Steer the existing worker via its `task_id` when possible; reclaim only if orphaned — with `reclaim_ticket` plus the `owner_session` observed in the IN_PROGRESS result (compare-and-swap on the current owner); otherwise continue other work.

FTS supplies related context only: a loose FTS match never defines SAME WORK, never turns active work into IN_PROGRESS, and never claims on behalf of an active item.

## Idea loop (V2)

1. Before generating exploratory hypotheses, call `project_idea_search(query=...)`.
2. Preserve materially distinct useful ideas with `project_idea_save(...)`.
3. BLOCKED is not the same as DISPROVEN. Confirmed state changes require evidence:
   - `validated` and `disproven` require non-empty `evidence`, and a transition INTO either strong status must carry evidence supplied in that save — stale evidence from a previous conflicting state is never silently reused (re-saving the same strong status keeps its existing evidence).
   - A condition marked `satisfied: true` requires `satisfied_by`.
   - `satisfies` is accepted only from a `validated` idea that carries evidence. Each target condition must already exist or be explicitly declared in the same call (via `conditions`); unknown targets are a validation error, never auto-created placeholders. The condition's `satisfied_by` records the satisfying idea's id.
   - Relation sources and targets must already exist or be explicitly declared in the same save call — missing targets are never auto-created into placeholders.
   - A save with any validation error is atomic: `ok: false` and nothing is written.
4. Relation kinds: `requires`, `enables`, `supports`, `contradicts`, `combines_with`, `derived_from`.
5. Idea lifecycle: `proposed`, `testing`, `validated`, `disproven`, `dormant`.

## Permissions

Primary agents are configured with `PROJECT_MEMORY_PRIMARY_AGENTS` (default `orchestrator,orchestrator-goal`).

- **Primary agents**: full access — claim and reclaim work, record results, record failures, read and write idea memory.
- **`subagent`**: may query `project_work_check` with `claim: false` and record reusable failures via `project_failure_save`. Idea memory (search and save) and result recording are denied — report hypotheses to the orchestrator.
- **Any other agent** (e.g. `verifier`, `vision`): read-only queries allowed; all mutations denied, including `project_failure_save`.

## Fail-closed behavior

- A successful query with no match returns NEW.
- A memory error returns `MEMORY_ERROR` with an error cause, so the caller can handle it explicitly. The plugin never returns a result from an uncertain connection state: it retries, then reopens the database, then fails closed.
- `project_work_check` runs through this recovery path. The other tools fail closed with `ok: false` and a readable error when memory is unavailable.

## Requirements

- OpenCode with plugin/custom-tool API support.
- Bun runtime.
- SQLite. FTS5 is optional — when unavailable, retrieval falls back to LIKE matching.

Compatibility is claimed only for the OpenCode versions this plugin was tested with.

## Files

- `project-memory.ts`: The plugin entry point.
- `lib/project-memory-lib.ts`: The core logic. It contains the schema, the FTS5 search with LIKE fallback, the atomic claim, the compare-and-swap reclaim, the preflight, the SQLite-only failure memory (no FAILURES.md dual-write), the legacy Markdown index for `read_first`, and the fail-closed recovery.
- `lib/project-memory-v2.ts`: The V2 idea memory core.
- `test/`: The standalone tests for Bun.

## Build

Run this command to build the plugin:

```bash
bun build project-memory.ts --outfile project-memory.js --external @opencode-ai/plugin --target bun
```

## Installation

1. Build the plugin. See the section "Build".
2. Copy the file `project-memory.js` to the plugins directory of your OpenCode installation.
3. Add the plugin path to the OpenCode configuration file. Example:

```jsonc
{
  "plugin": ["/path/to/plugins/project-memory.js"]
}
```

4. Restart OpenCode.

## Test

Run these commands to test the plugin:

```bash
bun test/test-lib.ts
bun test/failclosed.ts
bun test/test-reclaim.ts
bun test/reclaim-race.ts
bun test/claim-race.ts <db> <key> <who>
bun test/test-v2.ts
bun test/test-v2-e2e.ts
bun test/test-v2-plugin.ts
bun test/test-packet-compact.ts
bun test/test-scheduler-removed.ts
bun test/test-hardening.ts
bun test/test-final-hardening.ts
```

The file `test/claim-race.ts` requires three arguments. Exactly one contender must win the race.

## License

This project is licensed under the GNU Affero General Public License version 3. See the file LICENSE.

## Disclaimer

This code was generated with the assistance of AI.