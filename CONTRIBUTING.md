# Contributing

Use Node 22.13 or newer and install dependencies with `npm ci`. Run `npm run check`, `npm test`, `npm run build` and `npm run format:check` before opening a pull request. Describe the concrete behavior change and its validation. Keep tests deterministic; the standard suite must not start paid agent sessions or depend on a developer's Herdr configuration.

Keep generated bundles, local agent configuration, `.env` files, `.marionette` state, `.runtime` fixtures and credentials out of commits. Live validation scripts are opt-in and use explicitly named isolated sessions. Never point them at someone else's active session.

Changes enter `main` through pull requests. Release preparation and publication follow [RELEASING.md](RELEASING.md). Marionette is licensed under [MIT](LICENSE); bundled third-party licenses are preserved in `THIRD_PARTY_NOTICES.md`.
