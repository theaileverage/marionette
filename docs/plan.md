# Effect port migration plan

The port lives in `effect-port/`. The captured Node/Zod implementation, its dirty changes, root dependencies, public package exports, and live project state remain the baseline.

## Work list

- [x] Read the project Principles index and required migration, architecture, TypeScript, writing, Effect, and verification guidance.
- [x] Frame the task and inspect the captured dirty diff.
- [x] Ground the authority and native execution paths. Compare two architecture sketches, then record the lead's decision.
- [x] Capture source hashes and execute the baseline verification before implementation.
- [x] Build a separate package and reproducible comparison harness.
- [x] Port domain schemas and deterministic package behavior. Compare valid and invalid inputs.
- [x] Port database and authoritative state operations. Verify real SQLite rollback, restart, idempotency, and fences.
- [x] Port native adapters, runtime orchestration, and watcher lifecycle. Verify interruption and durable uncertainty without replay.
- [x] Port the facade and CLI. Compare operation schemas, command output, errors, and isolated project workflows.
- [x] Add a small versioned extension contract with validated inputs and no execution authority of its own.
- [x] Review artifacts and the decision trail. Run the complete parity predicate and record gaps.

## Falsifiable completion predicate

Whole-project parity is VERIFIED only if all of the following hold:

1. Every baseline source module has an explicit disposition in a coverage manifest. All supported CLI operations and SDK behavior have an executable comparison or a documented live acceptance check.
2. The baseline and port produce equivalent observable results for the same valid and invalid requests in isolated state directories. Normalize only generated IDs, timestamps, and absolute temporary paths, preserving relationships between them.
3. The current test suite passes against both implementations. Additional port tests demonstrate Effect interruption, resource finalization, no repeated ambiguous native effects, transaction rollback, nested transactions, restart, revision fences, and durable result acceptance.
4. The port uses Effect Schema at untrusted boundaries and real Effect service composition for application workflows. Delegating all work to the baseline is not a completed port. Synchronous SQLite transaction callbacks remain synchronous.
5. An actual native assignment reaches a durable, evidence-checked result decision through the port. Fixtures and idle observations do not meet this requirement.
6. The public dependency-free Herdr SDK remains usable without importing Effect. Existing package exports and user-owned changes remain intact.
7. Extension descriptors are versioned, decoded, and immutable once selected. They cannot grant workspace writes, credentials, execution profiles, or permission to bypass the authoritative store.

Each slice receives VERIFIED, NOT VERIFIED, or INCONCLUSIVE with evidence paths. A subset passing never implies whole-project parity.

## Rigor and checkpoints

This is a high-rigor migration because persistence and native execution can cause durable external effects. It spans the entire `src/v1` tree and its CLI, not merely dependency replacement. Work proceeds in independently verifiable slices. The first throughput checkpoint follows baseline execution and architecture synthesis; later estimates use observed slice results. No release, merge, or production-state migration is part of this run.

Two Sol agents own separate read-only architecture reports while the Astra lead prepares the baseline. Implementation workers receive exclusive files in the new folder. The lead owns package configuration, integration, evidence, and final review. The available agent tools do not expose a non-OpenAI model family; a same-family independent review will be labelled as such rather than claimed as the skill's cross-family review.

## Initial constraints

- Node 26.8.1 and Bun 1.3.14 are installed. The captured root package has Zod 3.25.76 in its lockfile and no Effect dependency.
- The saved source checkout has Effect 4.0.0-rc.112 installed. The new package must pin and verify its own copy.
- This worktree has no live project binding. The originating inventory job belongs to the saved source checkout. Inspect its durable record using that binding; do not relaunch it.
- There is no project `verify-*` skill in this capture. Verification uses `principle-prove-it-works`, the existing CLI tests, and the Effect testing reference. The verification-skill generators are not substitutes for a passing app check.
- The source contains unimplemented workflow controls. Preserve truthful rejection unless a separately specified slice implements and verifies those contracts.

## Audit

The append-only decision trail is `decisions.tsv`. Evidence is retained under `evidence/`; scripts own repeatable checks. Architecture proposals, synthesis, and coverage live under `docs/`.

## Final verification outcome

The full automated suite passes 162/162; build, strict TypeScript, package declarations/exports, CLI/SQL smoke, and diagnostics probes pass. Original source hashes and the initial dirty patch remain unchanged. The real Effect runtime launched Sonnet 5 and submitted the brief in isolated state. The provider refused the checksum task with a `[cyber]` safeguard before execution. The lead recorded actual refusal evidence, rejected that failed result, and verified settlement; successful worker completion remains NOT VERIFIED. Accordingly, the whole-project completion predicate is INCONCLUSIVE rather than falsely declared passed. No provider safeguard was bypassed. Anti-slop installation is separately accepted and its disclosed lint findings remain.
