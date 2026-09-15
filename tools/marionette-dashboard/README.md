# Marionette project dashboard

A local dashboard over a bound Marionette v1 project. Monitoring reads run through the CLI and
arrive over server-sent events. User-triggered project-board actions use the real CLI operations:

- `job.create` creates a ledger job.
- `board.create` creates a job thread when needed.
- `board.post` stores Kanban stages, clarifications, and comments.

Kanban stages are planning metadata stored in the board thread. They do not change or replace the
authoritative job ledger state. Clarifications and comments are durable thread posts; they do not
rewrite the immutable job brief.

## Lifecycle precedence

The board derives a stage on every snapshot without writing lifecycle posts:

1. The latest valid manual stage post wins, preserving drag/drop and the Stage override menu. Choose
   **Automatic** to clear that override and resume lifecycle-derived placement.
2. A `finished` job ledger state derives **Done**.
3. An accepted result can derive **Done** when Marionette exposes that signal.
4. A recorded durable result derives **Review**, never Done by itself.
5. Jobs without those facts remain in **Backlog**. A cancelled job is labeled as cancelled but is
   not presented as completed.

Cards label the fact used for placement so a manual planning choice is not confused with an
authoritative lifecycle outcome. Marionette v1 alpha currently exposes `public_results`, but no
public acceptance-decision inventory, so accepted-result synchronization is intentionally dormant.
Manual overrides are append-only and are not rewritten or removed automatically; choosing
**Automatic** adds an explicit clearing marker. New dashboard-created jobs no longer
receive an automatic Backlog stage post, allowing later lifecycle facts to take effect. Older stage
posts cannot be distinguished from manual choices in the alpha data model and remain preserved as
manual overrides.

## Run

```sh
cd tools/marionette-dashboard
bun start
```

Then open `http://127.0.0.1:4179/`.

The server binds to loopback only. Override the repository, project binding, CLI, port, or refresh
interval with `MARIONETTE_REPOSITORY`, `MARIONETTE_PROJECT`, `MARIONETTE_CLI`,
`MARIONETTE_DASHBOARD_PORT`, and `MARIONETTE_DASHBOARD_REFRESH_MS`.
