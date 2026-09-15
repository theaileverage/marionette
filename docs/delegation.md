# Direct delegation orchestration

`delegate(input)` composes the existing durable Marionette boundaries for a short direct job:

1. create the direct job with the caller's stable and idempotency keys;
2. admit one attempt against the created job's current brief revision;
3. invoke `attempt.start` exactly once;
4. use only `attempt.reconcile` for subsequent bounded supervision;
5. discover a durable result and return a `DelegationHandle`.

The handle contains the job, attempt ID, and an explicit outcome. It is the only place that exposes `accept()` and `reject(...)`; orchestration never calls either method automatically. Both decisions use the discovered result's brief revision and stable keys derived from the delegation idempotency key.

## Outcomes

The success outcome is `result`. Operational states remain visible as `blocked`, `manual-required`, `unconfirmed`, `unsupported`, `awaiting-result`, `timeout`, or `provider-failure`. A settled or idle native observation without a durable result is not success: supervision continues until discovery succeeds or the configured bound produces `awaiting-result`. Active work that exhausts the same bound produces `timeout`.

Calling `accept()` or `reject(...)` without a `result` outcome fails with `DelegationDecisionUnavailable`.

## Public API boundary

`DelegationOperations` is a `Context.Service`. `marionetteDelegationOperationsLayer(discoverResult)` implements job creation, admission, start, reconciliation, result discovery, and decisions through `MarionetteService.execute` and validates each public output contract.

The read-only `result.discover` operation accepts an `attemptId` and returns either `{ kind: 'found', result }` or `{ kind: 'pending' }`. The default layer uses this public operation, so the live one-call path needs no Store or SQL access from delegation. Callers may still inject `discoverResult` for deterministic tests or adapters; an injected capability may additionally report `unsupported`. Native idle is never treated as completion.

```ts
const program = delegate({
  job: {
    stableKey: 'review-readme',
    request,
    brief,
    workspaceId,
    delivery: 'report',
    dependencies: [],
    idempotencyKey: 'review-readme/job',
  },
  attempt: {
    profile: 'codex',
    nativeWorkspaceId: 'local',
    inputResultIds: [],
  },
  idempotencyKey: 'review-readme',
  supervision: { maxChecks: 30, interval: '1 second' },
})
```

The supervision schedule is finite. Scope interruption cancels outstanding reconciliation or discovery effects, and replaying the one-call effect remains safe only when the supplied job/admission/decision keys retain their Marionette idempotency semantics. Start is never retried by this module; uncertainty is reconciled.
