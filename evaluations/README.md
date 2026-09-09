# Swarm evaluation suite

This is an adapter-driven comparison harness, with six small reproducible fixtures. It supports `single-agent`, `current-marionette` (a pinned prior build), and `revised-marionette`. The same fixture and independent checks apply to each strategy. It is a baseline for iteration, not a claim that these small tasks represent all production work.

| Scenario               | What it exercises                                      |
| ---------------------- | ------------------------------------------------------ |
| simple                 | Whether delegation pays for a small change             |
| multiple-objectives    | Independent work plus targeted mid-task steering       |
| competing-explanations | Timezone bug, reproduction and counterfactual evidence |
| parallel-integration   | Three modules sharing a normalization contract         |
| failure-restart        | Interruption and recovery with preserved evidence      |
| conflicting-research   | Current primary evidence versus a superseded FAQ       |

Build once with `bun run build` in the repository. The distributed evaluator is `dist/evaluate-swarm.js` and runs without development dependencies. List scenarios with `bun run eval:swarm --list`. Run a trial with `bun run eval:swarm --config /absolute/trial.json`:

```json
{
  "scenarioId": "multiple-objectives",
  "strategy": "revised-marionette",
  "model": "EXACT_AVAILABLE_MODEL",
  "adapter": ["/absolute/your-trial-adapter", "--existing-config", "/private/adapter-config.json"],
  "allowance": { "timeoutMs": 1200000, "maxTurns": 60 },
  "output": "/absolute/results/revised-multiple-objectives-1.json"
}
```

The harness invokes the adapter with two final arguments: request JSON path and response JSON path. Its working directory is a fresh temporary trial checkout containing the task files. The request includes objective, strategy, model, allowance, and workspace path. Keep credentials in the adapter's existing private configuration. The adapter must establish its own Git/project/agent setup where needed, implement the selected strategy and enforce the shared turn allowance. For Marionette experiments, initialize and commit the fixture before dispatching worktrees.

The harness enforces wall time for the local adapter process group, executes acceptance checks outside the trial directory, retains the workspace and logs, and writes a result JSON. If an adapter creates persistent Herdr sessions or remote work, it must stop its own trial work on cancellation; killing the adapter cannot stop unrelated external processes. Trial results intentionally retain files and branches for audit.

For steering and restart scenarios, the adapter writes `.evaluation/progress.json` with `{"phase":"initial"}` after initial work has been durably established. The harness then supplies `.evaluation/steering.json`. The adapter must deliver it while the trial is in progress. For recovery, it executes its strategy's interruption procedure and records the actual commands, observations and identities. Never simulate a production crash outside the disposable trial's resources.

The response JSON should include:

```json
{
  "runtimeVersion": "exact runtime commit, or single-agent CLI version",
  "models": ["actual-model-id"],
  "turns": 8,
  "interventions": 0,
  "usage": null,
  "trajectory": "/absolute/local/trajectory.json",
  "notes": "Actual observations and limitations"
}
```

Report available provider token/cost data in `usage` with its source; omit it or use null when unavailable. `interventions` counts human assistance beyond the scripted scenario injection. Do not estimate absent measurements or call them zero. `budgetVerified` checks only the adapter's reported turn count against the requested allowance; audit the trajectory to verify accounting.

`acceptancePassed` means executable behavior and basic artifact-presence checks passed and the adapter exited successfully. It does **not** certify strategy fidelity, model identity, causal explanations, research quality or actual recovery. Every result names these required independent reviews. Save those reviews with evidence before recording overall success through `swarm.evaluation.record`. Research and recovery scenarios especially require this step. Checks are visible in this repository; fixture agents should receive only the request and workspace, and real trials should supplement them with held-out production cases.

Aggregate result files with `bun run eval:swarm --compare /absolute/result1.json /absolute/result2.json`. The report groups scenario, strategy and requested model, checks requested allowance equality, and includes acceptance rate, mean elapsed time, turns, interventions and cost with measurement coverage. Cost requires `usage.costUsd` and a nonempty `usage.source`; absent values remain unknown rather than zero.

Compare repeated runs for every scenario and strategy under equal model choices, time/turn allowances, tool access and starting state. Alternate run order to reduce service-load bias. Report acceptance rate, reviewed success, elapsed time, turns, measured cost where available, and human interventions. Preserve failed trials and unknown values. Do not infer stronger-model gains from deterministic test fixtures.

`bun test tests/evaluation.test.mjs` verifies that all six initial fixtures fail acceptance, reference solutions pass, and mid-task steering reaches an adapter. This tests the evaluation machinery. It does not run models or produce a model-performance comparison. No paid model trial is launched by package build or the test suite.
