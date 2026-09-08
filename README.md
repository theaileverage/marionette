# Marionette

[![CI](https://github.com/theaileverage/marionette/actions/workflows/ci.yml/badge.svg)](https://github.com/theaileverage/marionette/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@theaileverage/marionette)](https://www.npmjs.com/package/@theaileverage/marionette)

Coordinate Codex, Claude Code, and AGY workers through one lead conversation. Workers run in Herdr; a persistent local supervisor shares task state across MCP, CLI, and a dashboard.

- **Delegate work:** assign owned paths, dependencies, and acceptance checks; use a shared directory or isolated Git worktrees.
- **Verify outcomes:** require current evidence and independent checks before marking work complete.
- **Keep context:** preserve decisions, worker state, and an inbox across lead handovers and supervisor restarts.
- **Stay in control:** agents retain their normal permission policies; ambiguous deliveries require reconciliation before retrying.

## Quick start

Requires **macOS or Linux**, **Bun 1.3.14+**, **Herdr** on PATH, and your chosen agent CLIs installed and signed in.

From your project directory:

```sh
bunx --bun @theaileverage/marionette setup
```

You can also use `npx @theaileverage/marionette setup`. Bun must still be installed and on PATH; `npx` downloads the package but does not install Bun.

Setup starts the supervisor, connects a named Herdr session and project workspace, and configures MCP for your chosen lead: Codex desktop, Codex CLI, Claude Code, or AGY.

For a terminal lead:

```sh
bunx --bun @theaileverage/marionette lead
```

For Codex desktop, refresh MCP in Settings and give your conversation the prompt file printed by setup.

```sh
bunx --bun @theaileverage/marionette dashboard  # Print the private dashboard URL
bunx --bun @theaileverage/marionette doctor     # Diagnose connections
```

For scripted setup, use `setup --yes --json`; `setup --help` and `setup --schema` describe the available options. Install globally with `bun add --global @theaileverage/marionette` for the shorter `marionette` command.

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
