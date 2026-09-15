# Coordinate work

Use this procedure for a direct Marionette job. The lead agent performs every step. The human supplies the objective, authority, and decisions that require judgment.

## Establish the project

1. Run `marionette context` from the repository.
2. If the repository is uninitialized and the user asked to use Marionette, run `marionette init --project ABSOLUTE_REPOSITORY_PATH`.
3. Read `marionette schema workspace.register`.
4. Inspect Git and register the target workspace. Start with `access: "inspect"` and `writes: []` for read-only work. Grant write access only for paths the user placed in scope.

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
4. Define the objective, scope, ownership, constraints, standing orders, target workspace, delivery type, and dependencies.
5. Read `marionette schema job.create`, construct the nested request, and run `job create` with a stable key and an idempotency key.
6. Read the returned job and brief. Confirm that the stored revision and authority match the request.

Completion criterion: `job get` and `job brief` reproduce the intended assignment without widening it.

## Run and supervise the worker

1. Read `marionette schema attempt.admit`.
2. Admit the job with the selected profile, native workspace ID, and current brief revision.
3. Start the returned attempt ID once.
4. Inspect the attempt. If the launch or prompt is uncertain, run `attempt reconcile` instead of starting another attempt.
5. Read relevant board messages while the worker runs. Answer questions or report a human decision requirement with the exact job, attempt, and brief revision.
6. Inspect until the attempt settles, blocks, needs manual action, or records a durable result. Use a bounded foreground `watch` when the background watcher is unavailable.

Completion criterion: the attempt has a durable result or a specific recorded blocker. Native `idle` alone does not satisfy this criterion.

## Decide and deliver the result

1. Read the current brief and the result.
2. Verify every claimed artifact and command result against the actual workspace.
3. Accept the result only when it satisfies the current brief. Otherwise reject it with a concrete reason.
4. For a patch or commit delivery, create and complete a handoff through a running integrator in the target write workspace. Run the claimed checks before completion.
5. Report the accepted outcome, retained uncertainty, or blocker to the human.

Completion criterion: Marionette records the decision, and any requested target-workspace delivery has a completed handoff with verified target state.
