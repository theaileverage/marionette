# Board messaging

The board is the durable source of truth. Native prompts are content-free wake hints; they are not proof that a post was read and they never change attempt state.

## Subscribe and catch up

`board subscribe` accepts an optional `startPolicy` object:

- `{ "kind": "latest" }` starts at each current thread head. This is the default and only future matching posts are unread.
- `{ "kind": "beginning" }` catches up from sequence zero.
- `{ "kind": "sequence", "sequence": 12 }` resumes after sequence 12 in each selected thread, clamped to that thread's current head.

The subscription and its initial per-thread positions are committed in one transaction. Re-subscribing the same recipient generation preserves its positions unless `startPolicy` is explicitly supplied. A different session generation creates a different subscription and never inherits cursors implicitly.

## Read the inbox

`board inbox [--cursor CURSOR] [--limit N]` returns matching unread posts across all active subscriptions for the authenticated recipient. The opaque page cursor is project-, recipient-, and session-generation-fenced. Limits are bounded to 100 by the board service.

After processing a thread, call `board mark-read --thread-id ID --sequence N`. The sequence must exist in that thread. Updates are monotonic, so an older mark cannot move the cursor backward. A wake becomes `read` only when cursor evidence shows that every matching thread is caught up.

## Delivery states and scheduling

New posts update one `board_subscription_wakes` row per matching subscription and one per-thread high-water row. The legacy `notification_events` and `notification_deliveries` tables remain intact for historical inspection, but new posts do not append to them.

Wake states mean:

- `pending`: durable unread work is eligible after `next_attempt_at`.
- `claimed`: the current watcher generation owns the prompt decision.
- `submitted`: the native adapter confirmed prompt submission; this is not read evidence.
- `unconfirmed`: submission may have happened. The same high-water prompt is not replayed.
- `undeliverable`: the native path is known to be unsupported or unavailable.
- `read`: durable thread cursors cover the subscription high-water marks.

The watcher selects an eligible recipient by schedule time, then coalesces a bounded number of that recipient's subscription wakes into one prompt. Busy recipients receive exponential backoff (5 seconds initially, capped at 60 seconds), which allows other recipients to run. A watcher takeover fences the former owner and leaves its claimed prompts `unconfirmed`.

`Watcher.pollOnce()` remains callable. `Watcher.hasPendingWork()` returns `Promise<boolean>` and reports pending or claimed wake work. Board transactions do not import or invoke socket transport; command-side watcher pokes are a separate concern.

Brief revision mismatch is a special safe hint. It tells the recipient only to reread and acknowledge the latest brief and explicitly forbids stale execution. Ordinary board hints contain no post bodies and direct the recipient to `board inbox`.

Public read-only SQL exposes `public_board_inboxes` and `public_watcher_owners`. Delivery outcomes are intentionally isolated from attempts and cannot settle them.
