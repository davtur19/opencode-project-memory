# opencode-project-memory

Persistent project memory for OpenCode agents. The plugin stores state in a local SQLite database and exposes six tools.

The plugin persists and retrieves state. The LLM generates, combines and chooses ideas. There is no DAG, no scheduler, no graph database and no embeddings.

## What it stores

- **V1 — work memory**: work items, findings, evidence and reusable facts. It prevents duplicate investigative work and keeps project state across sessions.
- **V2 — idea memory**: ideas (hypotheses), prerequisites (conditions) and their relations. Ideas are separate from established facts.

## Tools

- `project_work_check`: Check project memory before starting investigative work. Returns prior context and whether the work is new, partial, covered, or already in progress.
- `project_work_save`: Save durable results, evidence and reusable facts learned from work.
- `project_failure_save`: Save a reusable failure or blocker when it can prevent repeated wasted work.
- `project_goal_update`: Update goal progress worth preserving across compaction or continuation.
- `project_idea_search`: Search durable project ideas, prerequisites and relations relevant to exploratory work.
- `project_idea_save`: Save or update a durable idea, prerequisite and its relations.

## Work loop (V1)

1. Before investigative work, call `project_work_check(work=...)`.
2. Do not repeat COVERED or IN_PROGRESS work. For PARTIAL work, do only the unresolved delta.
3. Run independent work with `task(background=true)`. Steer an existing worker via its `task_id`.
4. Save the result with `project_work_save(ticket=..., status=..., summary=..., evidence=..., facts=...)`.

## Idea loop (V2)

1. Before generating exploratory hypotheses, call `project_idea_search(query=...)`.
2. Preserve materially distinct useful ideas with `project_idea_save(...)`.
3. BLOCKED is not the same as DISPROVEN. Confirmed state changes require evidence.
4. Relation kinds: `requires`, `enables`, `supports`, `contradicts`, `combines_with`, `derived_from`.
5. Idea lifecycle: `proposed`, `testing`, `validated`, `disproven`, `dormant`.

## Permissions

- `orchestrator` / `orchestrator-goal`: idea search and idea save allowed.
- `subagent`: idea search and idea save denied; failure save allowed.
- `verifier` / `vision`: project-memory mutation denied.

## Fail-closed behavior

- A successful query with no match returns NEW.
- A memory error returns MEMORY_ERROR. The gate blocks the investigative task.
- The tools `vision` and `verifier` are exempt. Steering via `task_id` is exempt.

## Requirements

- OpenCode with plugin/custom-tool API support.
- Bun runtime.
- SQLite with FTS5 support.

Background subagents are not required for memory and preflight themselves. The recommended async orchestration workflow — `task(background=true)` for independent work and `task_id` to continue or steer an existing worker — requires an OpenCode version with native background subagent support. Enable it with:

OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true

Compatibility is claimed only for the OpenCode versions this plugin was tested with.

## Files

- `project-memory.ts`: The plugin entry point.
- `lib/project-memory-lib.ts`: The core logic. It contains the schema, the FTS5 search with LIKE fallback, the atomic claim, the preflight, the bootstrap, the gate, and the fail-closed recovery.
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
```

The file `test/claim-race.ts` requires three arguments. Exactly one contender must win the race.

## License

This project is licensed under the GNU Affero General Public License version 3. See the file LICENSE.

## Disclaimer

This code was generated with the assistance of AI.