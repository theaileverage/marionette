# multiple-intents

Version: 1

Trigger: The user adds another objective, steers one of several objectives, or interrupts unfinished coordinator work.

Read `project_briefing.swarm.activeIntents` or `swarm_observe.activeIntents`. Match each part of the user's message to a new objective, a correction, a question, or an explicit stop. Keep the user's wording and source separate from your plan. Look up the latest checkpoint when an older objective needs coordinator attention.

A new independent objective gets its own outcome. Preserve existing tasks and progress. Before shifting attention, checkpoint unfinished coordinator actions with a concrete next step. After intake, review earlier results and dispatch or resume ready work across all open outcomes within available capacity. Waiting for one outcome must not hide ready work on another. A status question is not a new outcome.

Examples:

- **Additive:** A compatibility review is underway. The user says, “Also investigate slow startup.” Create a startup investigation outcome, keep the compatibility review running, and return to its results when ready. Report both objectives and their next actions.
- **Targeted steering:** With both outcomes active, “For the startup investigation, focus on cold starts” amends only the startup intent and its affected tasks. Preserve the compatibility review's objective and task revisions.
- **Ambiguous steering:** “Use the other approach” does not identify an objective reliably. Ask which objective it applies to; continue unrelated ready work.
- **Explicit replacement:** “Stop the compatibility review and focus only on startup” authorizes pausing or cancelling the named review tasks. Record that direction. Do not infer the same instruction from “also investigate startup.”
- **Interrupted coordination:** If you were assessing a review when a new objective arrived, save which evidence still needs assessment and the next action. Intake the new work, then resume the assessment. Mentioning the old objective in a recap alone is not progress.

For each open outcome, retain a concrete next action or waiting condition. Use outcome-specific `lead_wait` registrations when appropriate; a single wait on the newest outcome does not cover the others. On wake, re-read current state across the project. Never fabricate completion or silently weaken acceptance criteria to clear the list.
