# Architecture selection criteria

The lead compares two structurally different candidates. Candidate A keeps a synchronous authoritative kernel with Effect services. Candidate B separates immutable decisions from a transactional command interpreter and native executors.

Each criterion scores from 0 through 3. A zero on authority or native uncertainty disqualifies a candidate.

| Criterion | Evidence required for 3 |
| --- | --- |
| Authority and transactions | A caller trace shows authentication, revision fences, idempotency, and durable writes inside the authoritative transaction. No external calls or suspension occur inside a transaction. |
| Native uncertainty | A trace covers failure or interruption before claim, after claim, during submission, and after submission. Every ambiguous case retains identity and reservations without replay. |
| Interface depth | A short public service interface owns a complete domain operation. Callers do not coordinate private journal steps. |
| Migration feasibility | Independently verifiable slices can coexist with the captured source. Tests distinguish shared code, compatibility boundaries, real ports, and unverified behavior. |
| Extension safety | A versioned descriptor is schema-validated and cannot mint authority. Selected dependencies and resources are pinned. |
| Operational compatibility | Existing CLI behavior, SQLite state semantics, and the dependency-free Herdr SDK have explicit preservation rules and tests. |

The model requested for architecture synthesis and final review is GPT-6 Astra with medium reasoning. Sol implementation workers own exclusive files. Only OpenAI model families are available through this session's subagent tools, so the requested independent review cannot provide the skill's cross-family diversity.
