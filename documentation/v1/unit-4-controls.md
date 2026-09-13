# Unit 4 control implementation

September 13, 2026. Scope: durable stop intent and native reconciliation. This does not complete Unit 4 or establish live native compatibility.

## Implemented behavior

`workflow.control` accepts `workflowId`, `expectedWorkflowRevision`, `expectedControlRevision`, `control` (`{kind: "pause", mode: "drain" | "now"}` or `{kind: "cancel"}`), and `idempotencyKey`. The SDK equivalent is `controlWorkflow`, with `operation` in place of `control`. Safe mode rejects without mutation. CLI control commands start the watcher unless `--no-watch` is selected; SDK callers use an existing watcher or explicitly reconcile attempts.

The returned `{id, controlRevision, workflowIds}` is an immutable receipt for stored intent, not proof of stopped execution. Replaying the same key and payload returns the original receipt; stale revisions and conflicting key reuse fail. A single transaction fences the workflow and registered descendants, obsoletes pending approval records, settles attempts whose launch was never claimed, and records controls for active or uncertain attempts. Independent workflows continue. Existing cancellation cannot be weakened by an ancestor pause.

The runtime allows interruption only against durable interruption intent, while rejecting ordinary native effects after control commits. Drain sends no interruption. A launch already in flight retains its resulting native identity and is reconciled without submitting a new work prompt. Interruption is claimed before dispatch and not replayed after an ambiguous outcome. Confirmed native settlement can complete a controlled attempt without requiring a result; drain retains recorded result outcomes when present. Results and artifacts remain stored. Uncertain attempts remain in watcher reconciliation.

Migration 006 adds dispatch acknowledgement timestamps to the native effect journal. A dispatched stop is distinct from a settled attempt. In-flight or ambiguous prompt/interrupt claims prevent an idle observation from being promoted to confirmed stop. Effect changes during observation require another observation. Historical prompt claims lacking acknowledgement evidence remain conservative; this migration does not fabricate native proof.

## Verification

Final verification: 116/116 tests passed with local socket access enabled for fixtures. Type checking, build, formatting, and diff whitespace checks passed; lint retains the existing `output.ts` control-regex warning. The built CLI produced a validated control receipt and paused an idle workflow in an isolated project using its matching state-home binding. SDK/operation receipt replay also passed across reopened connections.

Real SQLite tests cover pending-launch fencing, stable receipt replay, stale revisions, concurrent interrupt claims, drain, cancellation, launch/stop races, prompt and interrupt uncertainty, safe-pause rejection, and registered descendant controls with independent workflow preservation. The descendant test inserts a fixture relationship explicitly; it does not establish child admission or inheritance. Existing socket fixtures exercise the actual Herdr adapter's journal, identity checks, prompt, interrupt, and cleanup paths. These are fixtures, not a live Herdr acceptance run.

## Remaining contracts and work

Concrete recommendations for the three unresolved lifecycle contracts are in [Unit 4 lifecycle proposals](unit-4-lifecycle-proposals.md). They are proposed for review, not implemented or accepted policy.

- Safe pause needs a typed checkpoint acknowledgement tied to attempt, brief/control revision and session generation, with a defined proof of authorized checkpoint writes and native settlement. Idle alone cannot satisfy it.
- Resume needs a typed decision for retained effects, current permissions/workspace/limits checks, and uncertain prior dispatch. The current resume input cannot express that decision safely. Cancellation remains terminal.
- Managed children need an atomic admission/inheritance contract for parent context, boundaries, shared allowance, dependencies, and launch intent. Recursive control of already registered descendants does not implement that admission path.
- Brief revision, transitions (including decision resolution and child routing), limit extensions, automatic progression, and native approval forwarding are still unavailable. Pending approvals are fenced, but an approval adapter and racing forwarded effects are not proven here.
- Recovery of an ambiguous native dispatch needs positive sender/effect reconciliation. No retry, manual assumption, or lease expiry is treated as that evidence.
- Full native assignment/revision/control/handoff acceptance remains unverified. No live session was stopped or changed by this task.

No push, publication, merge, or deployment was performed.
