# Releasing Marionette

The public repository is [theaileverage/marionette](https://github.com/theaileverage/marionette). Source changes go through pull requests into `main`. GitHub Actions runs formatting, metadata validation, type checks, tests, a production build and an installed-package smoke test on Linux and macOS with Node 22 and 24. These checks use protocol fixtures, not paid agent sessions.

## Prepare a version

From a clean checkout, create a branch and run:

```sh
git switch -c release/0.2.1
npm run release:prepare -- 0.2.1
```

The helper updates `package.json`, `package-lock.json`, `src/version.ts` and a dated changelog section. Replace the placeholder with concrete release notes. Do not change the setup protocol number unless the protocol changes. Update verification evidence when behavior changes, then run:

```sh
npm run format
npm run release:check
npm pack --pack-destination /private/tmp
```

Commit the release preparation and open a pull request. `Required CI` must pass before merging. A tag must point at a commit contained in `main`; it must exactly match the package, lockfile, runtime version and changelog. Stable versions go to npm `latest`; prereleases such as `0.3.0-beta.1` go to `next`.

## Publish the merged version

```sh
git switch main
git pull --ff-only
git tag -a v0.2.1 -m 'Release 0.2.1'
git push origin v0.2.1
```

The `Release` workflow rebuilds and verifies the package, publishes the tested tarball using npm OIDC, compares the registry integrity, then creates a GitHub release with the tarball and `SHA256SUMS`. It uses pinned official actions, read-only checkout credentials, a dedicated `npm` environment, and an explicitly scoped OIDC permission. No npm token is stored in GitHub.

If a run fails after npm publication, rerun the failed job. Existing package integrity must match before the workflow continues; it never overwrites an npm version or a differing GitHub asset. You can also dispatch on the existing tag:

```sh
gh workflow run release.yml --ref v0.2.1 -f tag=v0.2.1
```

Do not move or delete published tags. Fix a bad release with a new version. Registry publication is irreversible in the usual release workflow; removing a GitHub release does not remove its npm package.

## npm trusted publisher

The package's trusted publisher must match these exact values:

- Package: `@theaileverage/marionette`
- Repository: `theaileverage/marionette`
- Workflow: `release.yml`
- Environment: `npm`
- Permission: publish

A package maintainer configures this once through npm's authenticated trust flow:

```sh
npm exec --yes --package npm@11.19.1 -- npm trust github @theaileverage/marionette \
  --repo theaileverage/marionette --file release.yml --env npm --allow-publish --yes
```

npm may require fresh two-factor/browser authentication for this administrative operation. Subsequent CI publishing uses the GitHub OIDC identity. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and the [npm trust command](https://docs.npmjs.com/cli/v11/commands/npm-trust/). Protect the `npm` environment so only version tags deploy; repository administrators can manage any required reviewer policy.

## Initial 0.2.0 release

Version 0.2.0 was published to npm before this repository existed. `.github/release-baseline.json` pins its verified registry integrity. Only this exact version may reuse the original npm tarball for its initial GitHub release; the workflow never attempts to republish it. The repository adds licensing, metadata and CI/release tooling after that publication, so rebuilding the initial repository commit need not reproduce the old package byte for byte. Future releases are built and published from their Git tags.
