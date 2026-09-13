# Marionette v1 design

The CLI and TypeScript SDK call the same domain operations. SQLite owns project identity, session generations, immutable inputs, result evidence, and effect claims. An explicitly installed OS-supervised project service handles durable inbox processing, admitted execution, controls, recovery, and board notifications. The legacy bounded watcher remains available. There is no Marionette MCP or HTTP server.

```text
CLI / TypeScript SDK
        |
shared operations
        |
SQLite + artifact files
        |
project service + inbox + native effect journal
        |
Herdr SDK / registered native agent
```

Each project belongs to one execution host. Managed agents inherit a context file that identifies their project and session. Read-only SQL exposes bounded project-scoped views; controlled writes become validated board contributions.

An attempt's execution state is separate from result verification, acceptance, integration, and notification delivery. Uncertain native effects retain reservations until reconciled. Retry keys prevent duplicate recorded mutations.

Workflow packages pin skill resources and execution rules. The complete intended behavior is described in [execution contracts](documentation/v1/execution-contracts.md). [The implementation plan](documentation/v1/implementation-plan.md) tracks what is implemented. The control plane implements explicit workflow transitions, finite repair, brief revisions, pause/cancel/resume, and revisioned limits. Upgraded workflows remain inactive until explicitly activated; a pinned edge alone does not authorize automatic progression. See the [Chief of Staff architecture and audit](documentation/v1/chief-of-staff/IMPLEMENTATION.md) for implemented boundaries and verification.

The retained Herdr SDK is generated from the vendored protocol. All new runtime code lives in `src/v1`. The previous runtime remains recoverable from Git history and is not included in the alpha package.
