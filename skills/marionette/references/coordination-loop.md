# Coordinate work

Use this procedure for a direct Marionette job. The lead agent performs every step. The human supplies the objective, authority, and decisions that require judgment.

## Establish the project

1. Run `marionette context` from the repository.
2. If the repository is uninitialized and the user asked to use Marionette, run `marionette init --project ABSOLUTE_REPOSITORY_PATH`.
3. Read `marionette schema workspace.register`.
4. Inspect Git and register the target workspace. Start with `access: "inspect"` and `writes: []` for read-only work. Grant write access only for paths the user placed in scope. If the path is already registered, read that registration and reuse it instead of registering again.

Completion criterion: `marionette workspace get` returns the intended path, repository root, access, and write boundaries.

## Discover execution

1. Run `marionette profile list`.
2. Before using Herdr, inspect its installed help. Check the server, available workspaces, and installed agent integrations with the commands supported by that version.
3. If the target repository has no Herdr workspace, create one with the installed Herdr CLI and read back its workspace ID.
4. Verify the selected agent executable and authentication independently. An installed Herdr integration only reports status hooks. It does not prove that the agent CLI is installed or authenticated.
5. If no matching profile exists, read `marionette schema profile.configure` and create one whose `kind`, `model`, and `args` match the verified executable.
6. If the Herdr workspace is not registered, read `marionette schema native.register` and register its exact socket path and workspace ID.

Completion criterion: the chosen profile and native binding both exist, and their executable, model, socket, and workspace were observed on this host.

## Create the job

1. Keep the original request text unchanged.
2. Calculate its SHA-256 digest from the exact bytes used in `request.text`.
3. Snapshot referenced local files with `input snapshot` when the worker must receive immutable inputs.
4. Define the objective, scope, ownership, constraints, standing orders, target workspace, delivery type, and dependencies. `dependencies` holds job IDs; accepted result IDs go to `attempt.admit.inputResultIds`.
5. Read `marionette schema job.create`, construct the nested request, and run `job create` with a stable key and an idempotency key.
6. Read the returned job and brief. Confirm that the stored revision and authority match the request.

Completion criterion: `job get` and `job brief` reproduce the intended assignment without widening it.

## Run and supervise the worker

1. Read `marionette schema attempt.admit`.
2. Admit the job with the selected profile, native workspace ID, and current brief revision. Admission reserves the attempt and can start a watcher; it does not prove the worker launched.
3. Read `attempt get` before starting. Start the returned attempt ID once.
4. Inspect the attempt. If the launch or prompt is uncertain, run `attempt reconcile` instead of starting another attempt.
5. Read relevant board messages while the worker runs. Answer questions or report a human decision requirement with the exact job, attempt, and brief revision.
6. Inspect until the attempt settles, blocks, needs manual action, or records a durable result. Use a bounded foreground `watch` when the background watcher is unavailable.

Completion criterion: the attempt has a durable result or a specific recorded blocker. Native `idle` alone does not satisfy this criterion.

## Recover an uncertain native effect

An interrupted turn, a timeout, or an error carrying `mutation: "unknown"` leaves the effect undecided. Read before you write.

1. Read `attempt get` and `attempt inspect` first. An admitted attempt can already be `running` after an interrupted turn even when no successful `attempt.start` response was observed. Never replay `attempt start` on that evidence.
2. Expect ledger phase and native state to disagree. An attempt can sit at ledger `unconfirmed` while the native identity reports `working`, and later while it reports `settled`. A single reconcile that preserves `unconfirmed` is a valid outcome, not a failure to retry.
3. Do not force-settle an attempt or release its reservation from `blocked`, `manual`, `working`, or `unconfirmed` evidence. Retain the uncertain reservation and report it.
4. Do not retry a failed watcher takeover. `watch` refusing with `watcher takeover requires confirmed former process absence` leaves mutation unknown; confirm the former process is gone by other means or leave it.
5. When a session gate blocks an unconfirmed worker from recording its own result, do not reopen or impersonate that session. Create a fresh isolated verifier job that inspects the exact commit, reruns the checks, and records the durable result. This is the supported recovery path for work that exists in Git but not in the ledger.

## Sequence handoffs before integrating

The alpha reserves one target writer at a time, so a plan that claims several handoffs before integration begins is not executable. Choose one of the two supported strategies, and remember that a brief instruction telling an integrator to wait is not a control.

**Aggregate through one reservation.** Use one accepted result's handoff to reserve the integrator, and attach the other accepted results to that integrator attempt through `attempt.admit.inputResultIds`. Record every input on the integration result and on the board so the durable record names all of them.

**Or sequence one handoff at a time.** Create, claim, check, and complete or replan a single handoff. Then recapture the target state and plan the next one from it. Never plan a handoff against target state observed before the previous integration landed.

In either strategy:

1. Confirm a claim by reading `handoff get`, not by trusting the claim response. A response reporting a stale claim can coexist with a handoff already `integrating` at claim revision 1.
2. After any stale or unknown claim response, inspect every handoff and the current target state before retrying or replanning.
3. Recompute `expectedTarget` from the newly captured Git state before each `handoff create` or `handoff replan`. Every completed integration invalidates an `expectedTarget` captured earlier.
4. When the target state has moved past a plan, use `handoff replan` or `handoff resolve` with a recorded reason. Do not force a completion whose expected target no longer matches.

### Apply several accepted commits safely

Repeated `git cherry-pick -n` across dependent commits leaves HEAD fixed, so every pick replays against the same base and dependent commits collide as add/add conflicts. Use normal cherry-picks followed by a deliberate squash, or apply one aggregate diff per accepted final tree.

## Handle the verification environment honestly

Separate what the change did from what the environment allowed.

- When a repository's standard test wrapper stops before selecting tests, record that as infrastructure-blocked and run the owned tests directly through the pinned build tool. Never report the wrapper as passing.
- When a repository-wide check already fails on pre-existing findings, run it scoped to the owned files and retain the repository-wide failure as evidence of a pre-existing condition. Never weaken or disable rules to obtain a pass.
- When a toolchain exits `0` while emitting advisory output, report errors, warnings, and advisories separately rather than collapsing them into a pass.
- Treat sandbox denials — an unwritable tempdir, a refused socket bind — as environment limits. Escalate or use a verified writable location. Do not change source to route around them.

## Decide and deliver the result

1. Read the current brief and the result.
2. Verify every claimed artifact and command result against the actual workspace.
3. Accept the result only when it satisfies the current brief. Otherwise reject it with a concrete reason. A result whose verification honestly failed may be accepted only after the lead independently runs the missing checks and records the basis for acceptance.
4. For a patch or commit delivery, create and complete a handoff through a running integrator in the target write workspace. Run the claimed checks before completion.
5. Report the accepted outcome, retained uncertainty, or blocker to the human.

Completion criterion: Marionette records the decision, and any requested target-workspace delivery has a completed handoff with verified target state.
