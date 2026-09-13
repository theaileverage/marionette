# Chief of Staff implementation audit

## Baseline and contract freeze

Implementation started from clean detached `068ef7ef94a76f71a603430211f8497e39755a08`,
the exact source inspected by architecture.md. Branch: `codex/always-on-chief-of-staff`.
Migrations 001–005 remain immutable. Installation/probing/activation are explicit operations,
never migration side effects. Existing workflows require explicit activation for scheduling.

The local user credential remains bound to the project binding and host. Controller lifecycle
administration requires an active authorized session; replacement rotates session credentials
and fences old claims. Model history never owns runtime state. Budget units initially mean
attempts, repeats, concurrent attempts and milliseconds; token/currency claims require provider
metering and must not be fabricated. Package edges require explicit requests unless a uniquely
specified automatic policy exists; ordinary edge presence does not authorize automatic action.

## Effect and recovery contract

| Effect boundary | Durable precondition | Lost response / restart |
| --- | --- | --- |
| Controller launch or turn submission | incarnation and generation-bound claim | observe exact identity; otherwise unconfirmed; never resubmit from timeout |
| Worker tab / agent / prompt | existing native_effects claim and revision gates | reconcile exact locator; missing locator requires manual reconciliation |
| Workflow control | immutable intent and affected closure | settlement requires observation; safe without checkpoint remains manual |
| Native approval | exact operation, fingerprint, server generation and current authority | one forwarding claim; ambiguity cannot be retried |
| Board delivery | fenced notification claim | transport acknowledgement remains distinct from inbox processing |
| Handoff / retirement | existing target identity and protected claim | retain reservations until confirmed settlement |
| Cross-project command | source outbox and child-local authority / budget check | deduplicate link and sequence; child owns runtime mutation |
| Inbox acknowledgement | current incarnation/claim plus committed decision receipt | replay same receipt; no transport-only acknowledgement |

Local admission, control, approval and hierarchy mutations check current revisions inside the
transaction which writes their claim. External effects cannot be rolled back; claims survive
process failure. A replacement service must prove the prior process absent before taking over.
All nonterminal records classify as safe local continuation, exact observation, or manual
reconciliation; time elapsed is never evidence of settlement.

## Verification ledger

- Source drift: none at start; clean checkout and exact design commit verified.
- Dependencies: installed from frozen Bun lockfile using Node 26.8.1 / Bun 1.3.14.
- Baseline restricted run: Unix socket listen and process-inspection restrictions prevented
  native fixtures; this is not evidence of a product regression. Unrestricted rerun pending.
- Live Herdr, OS restart/reboot and packaged acceptance: pending; fixture evidence must remain
  separately labeled.

## Delivery phases

1. Durable events/inbox/controllers and generation fencing.
2. OS supervision and conservative recovery scans.
3. Harness catalog/profile admission routing and controller runtime integration.
4. Workflow transitions, revisions, controls, limits and scheduling.
5. Human decisions and native approval handling.
6. Same-host hierarchy after the single-project safety checks pass.
7. Independent seam review, migration/package/live checks, push and PR; no merge or publish.
