#!/usr/bin/env bash
set -euo pipefail
test "${HERDR_ENV:-}" = 1
: "${HARNESS_ROOT:?Run inside the browser harness}"
: "${MARIONETTE_CLI:?}"
herdr pane current --current > "$HARNESS_ROOT/evidence/launch-controller.json"
control_tab=$(bun -e 'console.log(require(process.argv[1]).result.pane.tab_id)' "$HARNESS_ROOT/evidence/launch-controller.json")
for fixture in fresh existing; do
  bun "$MARIONETTE_CLI" lead --project "$HARNESS_ROOT/$fixture" > "$HARNESS_ROOT/evidence/$fixture-launch.log" 2>&1
  project_id=$(bun -e 'console.log(require(process.argv[1]).projectId)' "$HARNESS_ROOT/evidence/$fixture-setup.json")
  receipt="$HARNESS_ROOT/state/leads/$project_id.terminal.json"
  cp "$receipt" "$HARNESS_ROOT/evidence/$fixture-terminal-before.json"
  agent_name=$(bun -e 'console.log(require(process.argv[1]).name)' "$receipt")
  pane_id=$(bun -e 'console.log(require(process.argv[1]).pane_id)' "$receipt")
  # agent.start can acknowledge while native startup is still pending. This
  # scenario deliberately leaves these fresh fixtures untrusted and model-free.
  herdr pane wait-output "$pane_id" --match 'Do you trust the contents of this directory?' --timeout 30000 > "$HARNESS_ROOT/evidence/$fixture-ready.json"
  herdr agent get "$agent_name" > "$HARNESS_ROOT/evidence/$fixture-agent.json"
  herdr pane process-info --pane "$pane_id" > "$HARNESS_ROOT/evidence/$fixture-process.json"
  herdr agent read "$agent_name" --source recent-unwrapped --lines 60 > "$HARNESS_ROOT/evidence/$fixture-screen.json"
  bun "$MARIONETTE_CLI" lead --project "$HARNESS_ROOT/$fixture" > "$HARNESS_ROOT/evidence/$fixture-reuse.log" 2>&1
  cmp "$receipt" "$HARNESS_ROOT/evidence/$fixture-terminal-before.json"
  printf 'GUARDED_LAUNCH_AND_REUSE_OK %s\n' "$fixture"
done
herdr agent list > "$HARNESS_ROOT/evidence/launched-agents.json"
herdr tab focus "$control_tab" > /dev/null
printf 'GUARDED_LAUNCH_SCENARIO_OK controller=%s\n' "$HERDR_PANE_ID"
