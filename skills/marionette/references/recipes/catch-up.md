# catch-up

Version: 1

Trigger: When the user requests status, a recap, or help resuming several objectives.

Distinguish a recap from a fresh observation. For current state call swarm.observe, page changes with the returned cursor and disclose unknown or stale observations. Present decisions needed, completed outcomes, active work and gated next work, grouped by objective. For a conversational recap use only events in the requested interval and do not call historical facts current. Preserve older unresolved decisions. Translate worker reports into result, consequence and recommendation. Show technical details and artifact paths when they help the user inspect or act. A status request alone does not authorize new work.

This is optional guidance. The lead may adapt the method while preserving the user objective, permissions, evidence and concurrent work.

Example: When onboarding and billing are active, report each objective separately with its changes, open decisions, verified evidence, and next meaningful action.
