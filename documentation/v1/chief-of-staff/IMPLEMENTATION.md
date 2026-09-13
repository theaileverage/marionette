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

## Single-project milestone

The unrestricted original suite passed 107/107. The first integrated run passed 143/143,
including temporary SQLite, native adapter fixtures, CLI/SDK output contracts, workflow
controls, exact decisions, and service lifetime checks. A separate actual subprocess
SIGKILL test passed: a competing live owner was rejected, restart proved old process absence,
pre-submission claims were recovered, and submitted claims retained uncertainty.

Independent reviews found and corrected stale controller authority, insufficient native binding
checks, unrecovered pre-submission claims, recovered session state, and missing workflow evidence
propagation. Unbound legacy controller test sessions were changed to local-user fixtures; no
privileged grandfathering was added to production admission.

Implementation model steering: after the user's instruction, further code implementation is
assigned to `gpt-5.6-sol` sub-agents. Earlier implementation files were retained and handed off.

Live acceptance remains separate: this Codex task does not have `HERDR_ENV=1`. No live Herdr
session was inspected or controlled. No launchd/systemd registration, host reboot, or long soak
has been claimed. macOS LaunchAgents run after user login; Linux user services require the user
manager, and unattended boot requires its separately configured lifetime.

## Review-driven corrections and hierarchy

A separate migration 011 adds controller incarnation authority snapshots, native prompt receipt
linkage, and retirement evidence. It avoids rewriting migrations already committed in the earlier
slice. Policy changes revoke old credentials without pretending the native process stopped;
replacement requires positive idle observation or remains blocked/unconfirmed.

Hierarchy uses explicit same-host links and fixed receiver identities. Local project state stays
in its owning database. Signed sequence-numbered messages carry bounded commands and child events;
immutable receipts support replay after either database commits first. Grants can name the logical
controller, so replacing its native incarnation does not silently grant another principal access.

Workflow creation reserves an attempt envelope. Actual attempt admission is deduplicated and
debited across the child and all ancestor links while current authority is checked. Inherited
workflow ownership is resolved recursively. Allocation release requires confirmed terminal state
and effects; uncertainty is retained. Child result, integration, deployment and parent outcome
remain distinct facts.

Further regressions cover late worker results retained as stale, pause-closure-safe descendant
resume, downstream brief preservation, source-bound repair issues, finite no-result timeout
recovery, atomic prompt claims, old-generation inbox isolation, priority fairness, and partial
cross-database commit convergence. The final verification ledger below supersedes interim counts.

## Final source and package verification — 2026-09-13

- Full regression suite: **171/171 passed**, no skipped tests, with fixture process and
  Unix socket access enabled. This includes real SQLite migration/replay tests and a disposable
  subprocess SIGKILL/restart test; it does not establish live Herdr or OS-supervisor acceptance.
- `npm run check`: passed, with the pre-existing `src/v1/output.ts` `no-control-regex` warning.
  `npm run format:check`, `npm run build`, `npm run release:check`, and `git diff --check` passed.
- Local tarball built with `npm pack --ignore-scripts` after the source checks/build completed.
  Standard `scripts/release.mjs smoke` passed after installing it into a disposable consumer.
- Expanded installed-package acceptance: **6/6 passed** using
  `MARIONETTE_CHIEF_PACKAGE_ROOT` to select the installed CLI and SDK artifacts. Fixture setup and
  some direct assertions still use source helpers; this is public-artifact integration evidence,
  not a wholly independent black-box test or live native test.
- Independent sol reviews and regression fixes covered controller authority/replacement, ambiguous
  effect retention, workflow closure/limits, hierarchy partial commits, ancestor accounting, and
  narrow control authority after revocation. No known P1/P2 finding remains in the reviewed slices.
- Migrations 001–005 remain byte-for-byte unchanged from the baseline. Package metadata is
  consistent at `1.0.0-alpha.1`; no release was published.

Live Herdr, installed launchd/systemd recovery, actual host reboot, and sustained soak remain
**unverified**. The pull request is a draft for review with these acceptance gates outstanding.
No actual service registration or user native session was changed during these checks.
