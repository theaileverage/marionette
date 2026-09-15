# Board messaging

The Effect port has the same durable board and delivery contract as the Promise runtime. The board is authoritative; native prompts are content-free wake hints and never settle attempts.

`board subscribe` accepts `startPolicy` as `{ kind: "latest" }` (default), `{ kind: "beginning" }`, or `{ kind: "sequence", sequence: N }`. Setup and the initial per-thread positions commit together. Re-subscription preserves positions unless a policy is explicitly supplied, and a new session generation never inherits an old cursor implicitly.

`board inbox` provides bounded cross-thread unread pagination for the authenticated recipient. Its opaque cursor is fenced to the project, recipient, and generation. `board mark-read` accepts only an existing thread sequence and advances monotonically. Cursor evidence, not prompt submission, produces the `read` state.

New posts coalesce into one `board_subscription_wakes` row per matching subscription plus durable per-thread high-water rows. Legacy notification tables remain untouched as history. States are `pending`, `claimed`, `submitted`, `unconfirmed`, `undeliverable`, and `read`. An uncertain claimed prompt is never automatically replayed. Unsupported native delivery is `undeliverable`, not `unconfirmed`.

Scheduling is recipient-fair: eligible work is ordered by schedule time, a bounded digest is claimed for one recipient, and busy recipients back off exponentially from 5 to 60 seconds. Other recipients remain eligible. Ownership and session generation fencing survive restart.

The Effect API exposes `watcher.hasPendingWorkEffect(): Effect<boolean, WatcherError>` and the Promise wrapper `watcher.hasPendingWork()`. `WatcherService.hasPendingWork` is the typed service effect; `pollOnce` remains available. Board transactions do not depend on socket transport.

A brief-change hint contains only an instruction to reread and acknowledge the latest brief and forbids stale execution. Ordinary wake hints contain no board content and direct the agent to `board inbox`. Public SQL views are `public_board_inboxes` and `public_watcher_owners`.
