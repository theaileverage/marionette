# CLI operation reference

Run `marionette schema OPERATION` for the installed contract. This file explains when each command is used. It does not replace the schema.

## Project and execution context

| Command                | Use                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`                 | Bind a repository to local Marionette state, create a private local user session, and install the project-local Marionette skill when absent. |
| `context`              | Read the effective project, host, session, role, workspace, and credential source without exposing credentials.                               |
| `schema` or `describe` | Read the installed input, output, effect, authorization, and error contract for one operation or all operations.                              |
| `watch`                | Run native reconciliation and eligible notification delivery until idle, stopped, or the optional deadline expires.                           |
| `--version`            | Read the installed CLI version.                                                                                                               |

## Workspaces and inputs

| Command              | Use                                                                        |
| -------------------- | -------------------------------------------------------------------------- |
| `workspace register` | Record an existing checkout or isolated worktree and its permitted writes. |
| `workspace get`      | Read one registered workspace.                                             |
| `workspace retire`   | Check and remove an eligible isolated worktree. Run `--dry-run` first.     |
| `input snapshot`     | Store a local file as a content-addressed input artifact.                  |

## Jobs and workflows

| Command           | Use                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `job create`      | Store an immutable original request and the first brief revision for a direct job.         |
| `job list`        | List project jobs.                                                                         |
| `job get`         | Read one job and its current state.                                                        |
| `job brief`       | Read the current or selected brief revision.                                               |
| `workflow create` | Pin a workflow package and its resources. The alpha does not run its stages automatically. |
| `workflow list`   | List pinned workflow records.                                                              |
| `workflow get`    | Read one pinned workflow record.                                                           |
| `route`           | Select the applicable pinned workflow or the direct route for a request.                   |

## Profiles, native execution, and attempts

| Command             | Use                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `profile list`      | List configured execution profiles.                                                                              |
| `profile configure` | Create or revise a named agent executable, model, and argument list with a revision fence.                       |
| `native register`   | Inspect and bind an exact Herdr socket instance and workspace.                                                   |
| `attempt admit`     | Reserve capacity and create a scoped worker session for a job and brief revision. It does not launch the worker. |
| `attempt start`     | Ask the watcher to launch and prompt one admitted attempt. Invoke it once.                                       |
| `attempt get`       | Read the durable attempt and execution state.                                                                    |
| `attempt inspect`   | Observe the registered native identity and save that observation.                                                |
| `attempt reconcile` | Resolve native state after restart, timeout, or uncertain delivery without replaying effects.                    |
| `brief acknowledge` | Record that a managed worker adopted its assigned brief revision.                                                |

## Results and delivery

| Command            | Use                                                                            |
| ------------------ | ------------------------------------------------------------------------------ |
| `result record`    | Store a worker result with content-addressed artifacts and verified evidence.  |
| `result get`       | Read one durable result.                                                       |
| `result decide`    | Accept or reject a result against the current brief.                           |
| `handoff create`   | Plan delivery of an accepted patch or commit result into a target workspace.   |
| `handoff get`      | Read a handoff and its current claim.                                          |
| `handoff claim`    | Reserve the target writer role for a running integrator attempt.               |
| `handoff check`    | Run an authorized check in the claimed target workspace and record its output. |
| `handoff complete` | Record verified integration when target state and applied content match.       |
| `handoff resolve`  | Retain or abandon a conflicted or uncertain delivery with a reason.            |
| `handoff replan`   | Replace a settled claim with a new target plan.                                |

## Board and SQL

| Command             | Use                                                                                |
| ------------------- | ---------------------------------------------------------------------------------- |
| `board create`      | Create an idempotent durable discussion thread.                                    |
| `board post`        | Add an immutable question, blocker, progress update, finding, decision, or result. |
| `board list`        | List discussion threads.                                                           |
| `board read`        | Read a bounded page of messages from one thread.                                   |
| `board search`      | Search board messages.                                                             |
| `board subscribe`   | Register a managed session for eligible board notifications.                       |
| `board unsubscribe` | Remove a board subscription.                                                       |
| `board mark-read`   | Record the last message that a session read.                                       |
| `sql read`          | Run a bounded query against project-scoped read-only views.                        |
| `sql contribute`    | Validate one board contribution through the isolated SQL contribution table.       |

## Input and failure rules

- Use scalar flags when the schema exposes them.
- Use `--input FILE`, `--input -`, or `--json JSON_OR_FILE` for nested objects and arrays.
- Keep idempotency keys stable only for identical requests. Reusing a key with different input is an error.
- Treat an error with `mutation: "unknown"` as uncertain. Inspect or reconcile before retrying.
- Keep machine-readable output on stdout and diagnostics on stderr.
