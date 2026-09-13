# Releasing Marionette

The current target is `1.0.0-alpha.1`. Alpha publication must use the `alpha` npm dist-tag. A stable `1.0.0` requires the remaining execution contracts and live acceptance checks to pass.

Prepare a version with `npm run release:prepare -- VERSION`. Review the resulting version and changelog edits, then run:

```sh
bun install --frozen-lockfile
npm run check
npm test
npm run format:check
npm run release:check
npm pack
node scripts/release.mjs smoke /absolute/path/to/package.tgz
```

The smoke test installs the actual tarball into a temporary project. It exercises the installed CLI, SDK, SQL worker, bundled workflow loading, and TypeScript declarations. CI repeats these checks on Linux and macOS using Node.js 26.8.1.

Publication is a separate authorized action. The release workflow verifies tagged artifacts and does not publish automatically. Before publication, verify that the intended commit is on main, the version tag identifies that commit, the package has passed its smoke test, and the changelog describes the actual release.

Do not publish alpha builds under `latest`. Preserve existing runtime data and active sessions when trying the rewrite; v1 uses a separate project binding and state directory.
