import { build } from 'esbuild';
import { chmodSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const packages = new Set([
  'node_modules/react',
  'node_modules/react-dom',
  'node_modules/scheduler',
  'node_modules/lucide-react',
]);
for (const [name, entry] of [
  ['cli', 'src/cli.ts'],
  ['mcp', 'src/mcp.ts'],
  ['evaluate-swarm', 'scripts/evaluate-swarm.mjs'],
]) {
  const result = await build({
    entryPoints: [entry],
    outfile: `dist/${name}.js`,
    bundle: true,
    loader: { '.mustache': 'text', '.md': 'text' },
    platform: 'node',
    format: 'esm',
    target: 'esnext',
    external: ['bun:*'],
    legalComments: 'eof',
    metafile: true,
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    const marker = input.lastIndexOf('node_modules/');
    if (marker < 0) continue;
    const parts = input.slice(marker + 13).split('/');
    const count = parts[0].startsWith('@') ? 2 : 1;
    packages.add(input.slice(0, marker + 13) + parts.slice(0, count).join('/'));
  }
  chmodSync(`dist/${name}.js`, 0o755);
}
let notices =
  '# Third-party notices\n\nThese libraries are included in Marionette’s executable and dashboard bundles.\n';
for (const dir of [...packages].sort()) {
  const metadata = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'));
  notices += `\n## ${metadata.name} ${metadata.version}\n\nLicense: ${metadata.license ?? 'See notice below'}\n`;
  const licenses = readdirSync(dir).filter(
    (file) =>
      /^(licen[sc]e|copying|notice)([.-]|$)/i.test(file) && statSync(resolve(dir, file)).isFile(),
  );
  if (!licenses.length)
    throw new Error(`No license notice found for bundled dependency ${metadata.name}`);
  for (const file of licenses)
    notices += `\n\`\`\`text\n${readFileSync(resolve(dir, file), 'utf8').trim()}\n\`\`\`\n`;
}
notices +=
  '\n## Herdr 0.9.0 API schema\n\nThe SDK protocol types are generated from Herdr (https://github.com/herdrdev/herdr/tree/v0.9.0), licensed under Apache-2.0.\n\n```text\n' +
  readFileSync('vendor/herdr-0.9.0/LICENSE', 'utf8').trim() +
  '\n```\n';
writeFileSync('THIRD_PARTY_NOTICES.md', notices);
