# Releasing Marionette

The current target is `1.0.0-alpha.3`. Alpha publication uses the `alpha` npm dist-tag. A stable release requires separate live acceptance of the remaining execution contracts.

Prepare a version with `npm run release:prepare -- VERSION`. Review the version and changelog changes, update `bun.lock`, and update the reviewed source manifest if source changed. Run the same checks as CI:

```sh
bun install --frozen-lockfile
npm run check
npm test
npm run boundaries:check
npm run package:smoke
npm run format:check
npm run release:check
npm pack
node scripts/release.mjs smoke /absolute/path/to/package.tgz
```

`prepack` builds the distribution and checks the source boundary before every pack. The tarball smoke installs the actual artifact into a temporary project and checks its CLI and export subpaths. CI runs on Linux and macOS with Node.js 26.8.1 and fetches the pinned test oracle from full Git history. The tag-triggered release workflow verifies ancestry, source, and the tarball, then publishes alpha packages through npm trusted publishing.

Publication is a separate authorized action. Before publishing, confirm the intended commit is on main, the version tag names that commit, and the release artifact passed smoke. Preserve existing runtime state and active sessions when installing the Effect rewrite; a legacy `.marionette-v1/project.json` binding is reused under `.marionette/project.json` without changing its project ID.
