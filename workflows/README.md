# Workflow package fixtures

The four JSON files capture feature, bug-fix, refactoring, and architect workflows from the local pstack skills. Each contains ordered steps, permitted transitions, output contracts, finite limits, a design stop boundary, and embedded resource text with SHA-256 digests.

Run `node workflows/import-local.mjs /path/to/.agents/skills` to regenerate them. The importer follows named local skills, explicit resource paths, and relative JavaScript or TypeScript imports. It records unresolved references. Dynamic references, external dependencies, and native model or tool availability require runtime checks. This snapshot does not declare complete skill support.

The captured pstack license is MIT, copyright 2026 Lauren Tan. The license text is included as `pstack/LICENSE`. Individual resources retain their original text and source paths. Their license fields remain omitted where the source does not identify an individual license.

Step contracts describe durable gates. The controlling agent interprets the preserved instructions within each step. The runner must enforce inherited stop boundaries, remaining limits, independent review, and successful handoff. A `finish` transition at an earlier step permits terminal failure; it does not waive the successful handoff requirement. Publication still requires the user's authority.
