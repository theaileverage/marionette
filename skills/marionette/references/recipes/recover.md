# recover

Version: 1

Trigger: When a worker is stalled, disconnected, confused or has uncertain delivery.

Read the addressed task, pending messages, observations, decisions and current run identity. A timeout is not proof a service died; idle is not proof that a long tool call ended. Inspect conflicting evidence before deciding. Answer a question already resolved by the assignment; otherwise send a specific correction. For an uncertain side effect use reconciliation, not replay. Pause and settle the exact worker before changing ownership or relaunching. Preserve files, commits, task identity and progress context. Bound attempted recovery and escalate with evidence, consequence and the smallest necessary decision. Never reset state or restart a shared service merely because one worker reports trouble.

This is optional guidance. The lead may adapt the method while preserving the user objective, permissions, evidence and concurrent work.

Example: After a supervisor restart, inspect the preserved run identity and current pane before deciding whether to resume; an unavailable connection is insufficient evidence to redispatch.
