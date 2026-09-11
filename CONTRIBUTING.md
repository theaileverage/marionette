# Contributing

Use Node.js 24.10.0 or newer. Install the pinned development dependencies with Bun 1.3.14 and `bun install --frozen-lockfile`.

Run `npm run check`, `npm test`, `npm run format:check`, and `npm run build` before submitting a change. The tests use temporary databases, Git repositories, and local Unix sockets. They must not depend on paid agent sessions or the developer's active Herdr workspace.

Keep the CLI and SDK on the shared operations in `src/v1`. Parse external input at the boundary. Preserve durable claims before native effects, and retain uncertain effects for reconciliation. Evidence acceptance must remain separate from execution settlement.

Numbered migrations live in `src/v1/migrations`. Add a migration instead of changing a previously applied migration. Checksum validation rejects changes to applied SQL.

Generated Herdr files come from `scripts/generate-herdr-sdk.mjs`. Workflow package resources are imported and pinned by `workflows/import-local.mjs`; retain their licensing and hashes.

Describe the concrete behavior change and its verification. A fixture test does not prove compatibility with a live native application.
