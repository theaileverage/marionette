# Marionette

[![CI](https://github.com/theaileverage/marionette/actions/workflows/ci.yml/badge.svg)](https://github.com/theaileverage/marionette/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@theaileverage/marionette)](https://www.npmjs.com/package/@theaileverage/marionette)

Coordinate Codex, Claude Code, and AGY workers through one lead conversation. Workers run in Herdr; a persistent local supervisor shares task state across MCP, CLI, and a dashboard.

- **Delegate work:** assign owned paths, dependencies, and acceptance checks; use a shared directory or isolated Git worktrees.
- **Verify outcomes:** require current evidence and independent checks before marking work complete.
- **Keep context:** preserve decisions, worker state, and an inbox across lead handovers and supervisor restarts.
- **Stay in control:** agents retain their normal permission policies; ambiguous deliveries require reconciliation before retrying.

## Quick start

Requires **macOS or Linux** and **Bun 1.3.14+**. Setup checks Git, Herdr, and the selected lead CLI before creating project state. It reports other agent CLIs as optional workers.

From your project directory:

```sh
bunx --bun @theaileverage/marionette setup
```

You can also use `npx @theaileverage/marionette setup`. Bun must still be installed and on PATH; `npx` downloads the package but does not install Bun.

The interactive setup uses editable defaults and arrow-key choices. It offers to install missing required tools, then starts the supervisor, connects a named Herdr session and project workspace, and configures MCP for Codex desktop, Codex CLI, Claude Code, or AGY.

Setup installs Herdr through Homebrew when available, or its [official installer](https://herdr.dev/docs/install/); Git through existing Homebrew; Codex through npm when available; and Claude Code through its official installer. AGY and Git without Homebrew require manual installation. Agent sign-in remains a separate step. Setup does not install every optional worker or change existing agent integrations.

The project defaults to your current directory. To select Menderly from another directory, for example, pass `setup --project /path/to/menderly`.

For a terminal lead:

```sh
bunx --bun @theaileverage/marionette lead
```

The terminal lead opens in a dedicated tab in the project’s Herdr session. Repeating `lead` focuses the existing lead without resending its prompt. If the lead has exited and its tab contains a verified idle shell, `lead` starts it again in that tab. If a process is still present or its state is uncertain, `lead` opens the tab for inspection without sending a launch command. Detach with `Ctrl-B q`; the lead and workers keep running.

Setup names each project’s MCP entry `mnett-<project>-<lead>`, such as `mnett-menderly-mendy`. Names use lowercase words and hyphens, with a numeric suffix when needed to avoid collisions. `--mcp install` installs the entry and migrates owned older names; `--mcp print` prints a command with shell quoting only where needed.

For Codex desktop, refresh MCP in Settings and give your conversation the prompt file printed by setup.

```sh
bunx --bun @theaileverage/marionette dashboard  # Print the private dashboard URL
bunx --bun @theaileverage/marionette doctor     # Diagnose connections
```

For scripted setup, use `setup --yes --json`. Add `--install-tools` to explicitly allow installation of missing required tools; `--yes` alone only accepts configuration defaults. `--dry-run` prints the plan without installations or writes; `setup --help` and `setup --schema` describe the available options. Install globally with `bun add --global @theaileverage/marionette` for the shorter `marionette` command.

If an older cached package fails on `node:sqlite`, run `bunx --bun @theaileverage/marionette@latest setup`. Marionette 0.3.0 and later use Bun’s SQLite runtime.

Setup's `trustWorkspaces` option registers native workspace trust for Codex, Claude Code, and AGY as each lead or worker starts, including managed worktrees. Use `--no-trust-workspaces` to keep native trust prompts, or `--trust-workspaces` to enable it explicitly. Tool approvals and sandbox settings remain controlled by each agent. Legacy AGY-only settings remain compatible and do not silently authorize trust for other agents.

## Update and removal

```sh
marionette update --check           # Compare installed and published versions
marionette update                   # Upgrade this instance and detected global CLI packages
marionette upgrade                  # Alias for update
marionette update --from /path/to/built/marionette  # Use a local build
```

An instance can serve several projects. Updating moves all its saved project bindings and owned MCP registrations together, restarts the supervisor, and preserves worker terminals, assignments, and lead leases. A failed restart restores the previous runtime and database. Recovery files are retained only if rollback needs attention. Refresh or restart agent MCP clients afterward. `--runtime-only` leaves the global CLI package unchanged; `--home DIR` selects another instance. Global package-manager failures are reported separately from the runtime migration and can be retried.

Setup detects a different saved or running runtime and offers the same migration. For scripts, use `setup --yes --upgrade`; without `--upgrade`, setup reports the required update command before changing project state.

`setup --upgrade` also refreshes a changed local build with the same version number. If a saved Herdr workspace no longer exists, setup finds or creates its replacement and reconnects the existing project while preserving its ID, lead lease, and history. Active tasks and unresolved operations must be resolved first. An explicitly supplied `--workspace` must exist.

```sh
marionette remove --dry-run         # Preview removal of the current project
marionette remove                   # Confirm removal interactively
marionette remove --project /path/to/project --yes
marionette uninstall --dry-run --global
marionette uninstall --global       # Remove this instance and detected Bun/npm global CLI installs
```

Project removal deletes its binding, leases, stored project history, and archives, and restores workspace trust settings that Marionette added. Its MCP registrations are removed while other projects’ entries remain. Legacy shared MCP registrations remain until the final project is removed or all dependent projects have their own entries. Uninstallation deletes the selected instance's state, logs, runtimes, and recovery files. Project source files and Git branches are preserved; collect or relocate managed worktrees before removal. Shared instance logs and any failed-upgrade recovery files remain after individual project removal.

Removal previews active tasks, pending operations, and terminal ownership before making changes. Exit lead/worker agents first, or explicitly use `--stop-agents` to close verified project agents. Use `--keep-herdr` to retain terminal resources, including offline sessions. Herdr itself and the coding-agent applications remain installed. Noninteractive removal requires `--yes`; `--json` provides structured output. `--project-id ID` can remove an orphaned project whose source directory no longer exists.

## How it runs

The supervisor keeps working when you close the lead or dashboard. `stop` drains operations and preserves Herdr workers; `start` resumes the supervisor. Task completion preserves branches and worktrees until explicit delivery and cleanup.

State defaults to `~/.local/share/marionette` (or `$XDG_DATA_HOME/marionette`), with a project-local binding. Keep dashboard links and lease files private.

Herdr leads can resume from meaningful worker events. **Idle Codex desktop conversations resume on your next message**; the dashboard and durable inbox retain updates meanwhile.

## Agent skill and SDK

Copy [skills/marionette](skills/marionette/SKILL.md) into your agent's skill directory for coordination and recovery guidance.

The dependency-free Herdr SDK provides typed requests, event subscriptions, and graphics streams:

```js
import { HerdrClient } from '@theaileverage/marionette/herdr-sdk';

const herdr = HerdrClient.fromEnv(); // Inside a Herdr-managed environment
const { panes } = await herdr.pane.list(process.env.HERDR_WORKSPACE_ID);
```

See the [SDK guide](skills/marionette/references/herdr-sdk.md). Use Marionette task APIs to manage workers; direct SDK calls do not create assignments.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run build
```

The source uses Effect v4, TypeScript diagnostics from `@effect/tsgo`, and anti-slop lint rules. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and the Effect skill.

## Documentation

- [Orchestration](ORCHESTRATION.md) — outcomes, models, task trees, handovers, and cleanup
- [Agent guide](skills/marionette/SKILL.md) — setup, assignments, controls, and recovery
- [Design](DESIGN.md) — persistence and trust boundaries
- [Verification](VERIFICATION.md) — tested behavior and operating limits
- [Changelog](CHANGELOG.md) · [Releases](RELEASING.md) · [MIT license](LICENSE)
