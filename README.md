# opencode-project-memory

This plugin gives persistent project memory to OpenCode agents.

The plugin stores project facts, work items, and failures in a local SQLite database. It prevents duplicate investigative work. It keeps the project state across sessions.

## Why

Investigative agents often repeat the same work. The plugin solves these problems:

- Duplicate investigations: The preflight check detects work that is already covered.
- Concurrent claims: The atomic claim prevents two agents from owning the same work item.
- Stale or missing context: The goal state file and the memory database keep the context across sessions.
- Shared-state races: The serialized writers prevent concurrent writes to the same files.

## Requirements

- OpenCode with plugin support.
- Bun runtime.
- SQLite with FTS5 support.

The plugin does not implement a background runtime. It uses the background subagent support of OpenCode (or a compatible fork) when it is available.

## Tools

The plugin provides these tools:

- `project_preflight`: Check whether a task is already covered. It returns a context packet.
- `project_goal_checkpoint`: Write the project goal state file.
- `project_failure_append`: Append a failure to the failures file.
- `project_record`: Record the result of a delegated work item.

## Fail-closed behavior

- A successful query with no match returns NEW.
- A memory error returns MEMORY_ERROR. The gate blocks the investigative task.
- The tools `vision` and `verifier` are exempt. Steering via `task_id` is exempt.

## Files

- `project-memory.ts`: The plugin entry point.
- `lib/project-memory-lib.ts`: The core logic. It contains the schema, the FTS5 search with LIKE fallback, the atomic claim, the preflight, the bootstrap, the gate, and the fail-closed recovery.
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
bun test/claim-race.ts <db> <key> <who>
```

The file `test/claim-race.ts` requires three arguments. Exactly one contender must win the race.

## License

This project is licensed under the GNU Affero General Public License version 3. See the file LICENSE.

## Disclaimer

This code was generated with the assistance of AI.