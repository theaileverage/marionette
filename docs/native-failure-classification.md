# Native failure classification

The Herdr adapter exposes a conservative optional `failure` object on non-working native observations. Its `kind` is one of:

- `trust-required`: the registered pane contains the known native trust prompt.
- `provider-refusal`: the registered pane contains a direct first-person refusal line, or Herdr returns one of the explicit provider-refusal error codes supported by the classifier.
- `idle-without-result`: Herdr reports `idle` or `done`, `interactive_ready: true`, and `launch_pending: false`. This means only that the native slot is ready. It does not establish a recorded, accepted, or successful Marionette result.
- `transport-failure`: a Herdr boundary error has a transport-owned `herdr_*` code, such as disconnect, timeout, unavailable, invalid response, or response-size failure.
- `unknown`: the available evidence does not prove one of the preceding categories.

Every classification carries `diagnostic`. Pane classifications retain the exact pane text and its `truncated` flag. Boundary classifications retain the exact error message plus the Herdr code and named operation when available. Existing observation `reason` strings remain unchanged or provide a stable summary for compatibility.

## Conservative rules

The classifier does not infer provider refusal from `blocked`, from a task mentioning refusal, or from a general Herdr error. Provider refusal requires an explicit refusal sentence at the beginning of a pane line or one of `provider_refusal`, `provider_refused`, and `provider_rejected` from the boundary. A semantic error such as `not_ready` remains `unknown`.

Trust detection reuses the already-supported trust-screen phrases. Approval prompts still return `manual-required`, but their failure classification is `unknown` because `approval-required` is not one of this contract's categories.

The adapter reads only `recent_unwrapped` output for the already-registered pane and never sends input while classifying. It does not retry a launch, prompt, interrupt, or cleanup operation. Third-party drivers composed through the adapter may omit `failure` for compatibility; the built-in `HerdrNativeAdapter` populates it for every non-working observation it produces.

## Limits

Pane text is provider-rendered output, not a structured provider result protocol. Wording outside the narrow explicit patterns remains `unknown`. Truncated output may omit decisive context; the retained `truncated` flag lets callers treat that evidence accordingly. Native readiness and durable result acceptance remain separate concerns owned by the runtime and result store.
