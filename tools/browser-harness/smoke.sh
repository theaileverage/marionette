#!/usr/bin/env bash
set -euo pipefail
test "${HERDR_ENV:-}" = 1
: "${HARNESS_ROOT:?Run this from the browser test session}"
: "${HARNESS_SESSION:?}"
: "${MARIONETTE_CLI:?}"
mkdir -p "$HARNESS_ROOT/evidence"
printf 'HERDR_BROWSER_OK pane=%s workspace=%s\n' "$HERDR_PANE_ID" "$HERDR_WORKSPACE_ID" | tee "$HARNESS_ROOT/evidence/environment.txt"
herdr --version | tee "$HARNESS_ROOT/evidence/herdr-version.txt"
herdr --help > "$HARNESS_ROOT/evidence/herdr-help.txt"
herdr pane > "$HARNESS_ROOT/evidence/pane-help.txt" 2>&1 || test "$?" = 2
herdr agent > "$HARNESS_ROOT/evidence/agent-help.txt" 2>&1 || test "$?" = 2
herdr pane current --current > "$HARNESS_ROOT/evidence/pane.json"
for fixture in fresh existing; do
  bun "$MARIONETTE_CLI" setup --yes --json --project "$HARNESS_ROOT/$fixture" --home "$HARNESS_ROOT/state" --session "$HARNESS_SESSION" --lead "${HARNESS_LEAD:-codex}" --lead-name Harness --mcp skip --no-trust-workspaces > "$HARNESS_ROOT/evidence/$fixture-setup.json"
  printf 'SETUP_OK %s\n' "$fixture"
done
bun "$MARIONETTE_CLI" setup --yes --json --project "$HARNESS_ROOT/fresh" --home "$HARNESS_ROOT/state" --session "$HARNESS_SESSION" --lead "${HARNESS_LEAD:-codex}" --lead-name Harness --mcp skip --no-trust-workspaces > "$HARNESS_ROOT/evidence/fresh-repeat.json"
printf 'REPEAT_SETUP_OK\n'
bun -e '
const fs = require("node:fs");
const root = process.env.HARNESS_ROOT;
const read = name => JSON.parse(fs.readFileSync(`${root}/evidence/${name}.json`, "utf8"));
const fresh = read("fresh-setup"), repeated = read("fresh-repeat"), existing = read("existing-setup");
if (!fresh.ok || !repeated.ok || !existing.ok || fresh.projectId !== repeated.projectId || fresh.projectId === existing.projectId) throw new Error("Project identity check failed");
if (fs.readFileSync(`${root}/existing/README.md`, "utf8") !== "# Existing fixture\n\nUncommitted user work — preserve me.\n") throw new Error("Dirty file changed");
if (fs.readFileSync(`${root}/existing/untracked.txt`, "utf8") !== "Preserve this untracked file.\n") throw new Error("Untracked file changed");
console.log("PROJECT_IDENTITIES_OK");
'
printf 'EXISTING_FILES_PRESERVED\n'
printf 'BROWSER_SMOKE_OK\n'
