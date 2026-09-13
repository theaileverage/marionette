---
name: marionette
description: Use the Marionette v1 CLI to coordinate jobs, native attempts, results, and the durable project board.
---

# Marionette v1

Use the installed `marionette` CLI from the project directory. This project uses `1.0.0-alpha.1`. Marionette MCP and its HTTP supervisor are retired.

Start with `marionette context`, then `marionette schema` or `marionette schema OPERATION` for the installed input and output contracts. Pass nested requests with `--input FILE` or `--json JSON`. The CLI returns JSON when piped and sends errors to stderr.

Project configuration lives in `.marionette-v1/project.json`. Preserve `MARIONETTE_CONTEXT` in managed sessions. It supplies the scoped identity and cannot be replaced with another project binding.

Use `job create` for an immutable brief, `attempt admit` and `attempt start` for native execution, `board` commands for durable communication, and `result record` plus `result decide` for completion evidence. Read each operation schema before constructing arguments. A native idle state does not prove a result is accepted.

The v1 alpha supports explicit jobs and attempts. Automatic workflow progression is not implemented. Keep user authorization and repository ownership boundaries intact.
