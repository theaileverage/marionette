# Assignment and outcome inputs

CLI calls accept JSON files; MCP calls accept the same fields with the lease supplied in the object. Replace IDs, paths and checks with observed project values.

```json
{
  "assignment": {
    "projectId": "PROJECT_ID",
    "key": "parser-v1",
    "title": "Implement invoice parser",
    "kind": "codex",
    "prompt": "Implement the parser and its behavior tests. Preserve concurrent edits.",
    "ownership": ["src/parser.ts", "tests/parser.test.ts"],
    "execution": { "mode": "shared" },
    "dependencies": [],
    "checks": [
      {
        "type": "command",
        "command": "npm",
        "args": ["test", "--", "tests/parser.test.ts"],
        "timeoutMs": 30000
      }
    ],
    "maxAttempts": 2
  }
}
```

```sh
marionette call task.submit --file assignment.json --lease /private/path/lead.json
marionette call task.get --json '{"taskId":"RETURNED_TASK_ID"}'
```

Command checks execute without a shell. Use a real executable and argument array; shell syntax is not interpreted. File checks support `path`, optional `contains` and `sha256`, and `allowUnchanged` (false by default). A file normally must change from its dispatch digest. Worker-reported artifacts must be owned by the assignment.

For an isolated checkout use `"execution": { "mode": "worktree", "baseRef": "main" }` only when that branch and workflow are appropriate. `baseRef` is optional. Inspect returned `task.worktree` and `task.cwd`; don't invent the checkout path.

A persistent outcome starts with:

```json
{
  "outcome": {
    "projectId": "PROJECT_ID",
    "key": "parser-outcome-v1",
    "objective": "Deliver correct invoice parsing",
    "scope": ["src/parser.ts", "tests/parser.test.ts", "review"],
    "category": "software",
    "criteria": [
      {
        "id": "correct",
        "description": "Valid invoices parse and invalid inputs fail clearly",
        "requiredEvidence": "Independent tests and review"
      }
    ],
    "maxTurns": 30,
    "maxDepth": 2
  }
}
```

Call `outcome.create`, then add the returned `outcomeId` and current `expectedTreeRevision` to assignments. `maxTurns` bounds supervisor-triggered execution turns, not tokens or cost. Each required addition changes the tree revision; fetch fresh state before the next revision-sensitive call.

For each criterion call `outcome.assess` with `outcomeId`, `expectedRevision`, `criterionId`, `rationale`, and `references` (file path strings). Call `outcome.integrate` with the current revision, `summary`, and `references`; then `outcome.complete`. All require the lease. References into managed checkouts use `task:TASK_ID:relative/owned/file`. Never weaken the completion contract merely to pass it.
