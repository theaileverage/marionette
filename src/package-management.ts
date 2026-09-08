import { Effect, Result, Schema } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/unstable/http';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { boundaryError, sync } from './effect-runtime.js';
import { execEffect } from './process.js';
import { AppError } from './types.js';

export const PACKAGE_NAME = '@theaileverage/marionette';
export const latestVersionEffect = Effect.fn('Package.latest')(
  function* () {
    const response = yield* HttpClient.get(
      'https://registry.npmjs.org/@theaileverage%2Fmarionette/latest',
    );
    if (response.status !== 200)
      return yield* new AppError({
        code: 'registry_error',
        message: `npm registry returned HTTP ${response.status}`,
        status: 502,
      });
    const metadata = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        name: Schema.Literal(PACKAGE_NAME),
        version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/)),
      }),
    )(yield* response.json);
    return metadata.version;
  },
  (effect) =>
    effect.pipe(
      Effect.timeout(15000),
      Effect.provide(FetchHttpClient.layer),
      Effect.mapError(boundaryError('Package.latest')),
    ),
);
export const downloadPackageEffect = Effect.fn('Package.download')(function* (version: string) {
  const temp = yield* Effect.acquireRelease(
    sync('Package.temp', () => mkdtempSync(resolve(tmpdir(), 'marionette-update-'))),
    (temp) => Effect.sync(() => rmSync(temp, { recursive: true, force: true })),
  );
  yield* sync('Package.manifest', () =>
    writeFileSync(
      resolve(temp, 'package.json'),
      JSON.stringify({ private: true, dependencies: { [PACKAGE_NAME]: version } }),
      { mode: 0o600 },
    ),
  );
  yield* execEffect(
    process.execPath,
    [
      'install',
      '--cwd',
      temp,
      '--ignore-scripts',
      '--no-progress',
      '--cache-dir',
      resolve(temp, 'cache'),
    ],
    { timeout: 120000 },
  );
  return resolve(temp, 'node_modules', PACKAGE_NAME);
});
interface GlobalPackage {
  manager: 'bun' | 'npm';
  root: string;
  version: string;
}
export const globalPackagesEffect = Effect.fn('Package.globals')(function* () {
  const candidates: { manager: 'bun' | 'npm'; root: string }[] = [];
  const bun = yield* Effect.result(
    execEffect(process.execPath, ['pm', 'bin', '-g'], { timeout: 10000 }),
  );
  if (Result.isSuccess(bun))
    candidates.push({
      manager: 'bun',
      root: resolve(
        dirname(bun.success.stdout.trim()),
        'install/global/node_modules',
        PACKAGE_NAME,
      ),
    });
  const npm = yield* Effect.result(execEffect('npm', ['root', '-g'], { timeout: 10000 }));
  if (Result.isSuccess(npm))
    candidates.push({ manager: 'npm', root: resolve(npm.success.stdout.trim(), PACKAGE_NAME) });
  return yield* sync('Package.inspectGlobals', () => {
    const found: GlobalPackage[] = [];
    for (const candidate of candidates) {
      const manifest = resolve(candidate.root, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = Schema.decodeUnknownSync(
        Schema.Struct({ name: Schema.String, version: Schema.String }),
      )(JSON.parse(readFileSync(manifest, 'utf8')));
      if (pkg.name !== PACKAGE_NAME)
        throw new Error(
          `Unexpected package in ${candidate.root}; refusing package-manager changes.`,
        );
      const root = realpathSync(candidate.root);
      if (!found.some((p) => p.root === root))
        found.push({ ...candidate, root, version: pkg.version });
    }
    return found;
  });
});
export const changeGlobalPackageEffect = Effect.fn('Package.changeGlobal')(function* (
  pkg: GlobalPackage,
  version?: string,
) {
  const binary = pkg.manager === 'bun' ? process.execPath : 'npm';
  const args = version
    ? [
        pkg.manager === 'bun' ? 'add' : 'install',
        '--global',
        `${PACKAGE_NAME}@${version}`,
        '--ignore-scripts',
      ]
    : [
        pkg.manager === 'bun' ? 'remove' : 'uninstall',
        '--global',
        PACKAGE_NAME,
        '--ignore-scripts',
      ];
  yield* execEffect(binary, args, { timeout: 120000 });
  const remaining = yield* globalPackagesEffect();
  if (
    version
      ? !remaining.some((p) => p.manager === pkg.manager && p.version === version)
      : remaining.some((p) => p.root === pkg.root)
  )
    return yield* new AppError({
      code: 'global_package_verification',
      message: `${pkg.manager} did not ${version ? 'update' : 'remove'} its Marionette package as expected.`,
      status: 500,
    });
  return { manager: pkg.manager, version, removed: !version };
});
