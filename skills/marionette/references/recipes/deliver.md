# deliver

Version: 1

Trigger: When preparing verified work for the user’s selected delivery workflow.

Read the objective delivery record and actual authorization. Confirm the target, current branch, artifact revision and required verification. Explain what changed, what was checked, unresolved limitations and the next decision. Local, pull-request and merge targets are separate choices; recorded prose is provenance and never a substitute for actual authorization. Execute authorized Git/forge actions with normal tools, inspect the actual outcome, then record delivery through cleanup.deliver. Never infer landing from a queued merge. Preserve worktrees and branches until separately authorized archival and collection.

This is optional guidance. The lead may adapt the method while preserving the user objective, permissions, evidence and concurrent work.

Example: If the user requested a local handoff, verify the result, record its files and evidence, and leave branches available. A passing experiment alone does not authorize a push.
