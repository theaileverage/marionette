# Browser terminal harness

Run real Herdr and Marionette commands through wterm in a browser. This is a local development harness, with its own dependencies and disposable Git fixtures.

From the Marionette repository:

```sh
bun install --frozen-lockfile
bun install --cwd tools/browser-harness --frozen-lockfile
bun tools/browser-harness/server.mjs
```

The launcher bundles current CLI/MCP source into a temporary runtime, using the repository's installed dependencies and existing `public/` dashboard assets. If `public/` is missing, run `bun run build` first. It does not replace the repository's `dist/` files. To test a specific already-built package, set `MARIONETTE_CLI=/absolute/package/dist/cli.js` before starting the server.

Open the printed private localhost URL. In the browser terminal, enter:

```sh
herdr --session "$HARNESS_SESSION"
```

Once the Herdr shell appears:

```sh
test "${HERDR_ENV:-}" = 1
bash "$HARNESS_SMOKE"
```

The baseline uses the guarded Codex CLI lead. Set `HARNESS_LEAD=codex-desktop` only when testing an older runtime that supports that setup mode.

For real coordinator/worker coverage, follow [Multiple intents and prompt restoration](multiple-intents.md). That scenario uses a validated model profile and paid model turns; it is separate from baseline smoke.

For scoped MCP wait coverage without model turns, run `bun /absolute/path/to/tools/browser-harness/scoped-waits.mjs` in the same verified Herdr shell after baseline smoke. It connects the real scoped STDIO MCP for both fixtures, creates two test outcomes, registers a separate wait for each, and asserts both appear in the briefing. It retains those fixture outcomes and writes `evidence/scoped-waits.json`.

For the guarded Codex launch regression, run `bash /absolute/path/to/tools/browser-harness/guarded-launch.sh` from the same browser-controlled shell after baseline smoke. It starts leads in both disposable repositories, waits for Codex's native trust screen, captures Herdr process/agent state, and verifies repeat launch keeps the same terminal receipt. It leaves trust prompts unanswered and does not request model work. Inspect the screens and complete native argv as well as the script result. To test exit/relaunch, choose **No, quit** in the disposable lead, return to the controller tab, and rerun the scenario. Reload and resize the browser, then verify the same pane identity before continuing.

The smoke scenario verifies the real `HERDR_ENV=1` environment, captures Herdr CLI discovery, sets up fresh and existing repositories, repeats setup to check stable project identity, and verifies preservation of dirty and untracked files. It uses a private Marionette home, skips MCP registration and workspace-trust changes, and does not launch paid agent turns.

`HARNESS_ROOT/evidence/` contains private JSON results; setup output can contain capability URLs and should not be published. Fixture source and runtime state are retained for inspection. An existing repository fixture is not a historical Marionette database: version-migration fixtures and real lead/worker task scenarios remain to be added.

## Browser automation

Use a dedicated agent-browser session. Open the printed URL, inspect the page, and type into its focused terminal using `keyboard type` followed by `press Enter`. The terminal's mounted text is readable through the DOM. Reloading reconnects to the same outer PTY; verify the same `HERDR_PANE_ID` before continuing. Changing the browser viewport forwards terminal dimensions to the PTY and Herdr.

The server permits only one browser controller at a time. Close the previous page before opening another controller. The localhost URL contains a random capability path; wrong paths, hosts, and cross-origin WebSockets are rejected. Never expose this server through a public tunnel: its terminal has the launching user's shell permissions.

The most recent 4 MiB of terminal output is retained in memory for reload. This is a smoke-test replay buffer, not a durable terminal recording; after truncation, a full-screen app may need a resize/redraw to restore its display. Terminal responses are suppressed during replay so reconnect does not resend old queries as input. There is no automatic command retry.

## Tests and lifecycle

```sh
bun test tools/browser-harness/security.test.mjs
```

Closing the page preserves the shell. Ctrl-C in the server's launching terminal stops the bridge and outer PTY, but deliberately leaves Herdr's server and Marionette supervisor intact. Use normal Marionette/Herdr lifecycle commands from the test session when finished; restrict cleanup to the printed test session and temporary fixture paths.

See [VERIFICATION.md](VERIFICATION.md) for the observed acceptance results and limits.
