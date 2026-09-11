import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const destination = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(process.argv[2] ?? '/Users/ankeethsuvarna/Documents/TheAILeverage/Code/marionette/.agents/skills');
const licensePath = resolve(sourceRoot, '../../.claude/pstack/LICENSE');
const skillNames = readdirSync(sourceRoot).filter((name) => existsSync(join(sourceRoot, name, 'SKILL.md'))).sort();
const digest = (text) => createHash('sha256').update(text).digest('hex');
const common = ['poteto-mode/SKILL.md'];
const packages = [
  { name: 'feature', entry: 'poteto-mode/playbooks/feature.md', steps: ['ground', 'design', 'implement', 'review', 'verify', 'handoff'] },
  { name: 'bug-fix', entry: 'poteto-mode/playbooks/bug-fix.md', steps: ['reproduce', 'diagnose', 'design', 'implement', 'review', 'verify', 'handoff'] },
  { name: 'refactoring', entry: 'poteto-mode/playbooks/refactoring.md', steps: ['pin-behavior', 'design', 'implement', 'review', 'verify', 'handoff'] },
  { name: 'architect', entry: 'architect/SKILL.md', steps: ['ground', 'design', 'implement', 'review', 'verify', 'handoff'] },
];
const contracts = {
  ground: 'Traced subsystem model and relevant constraints.',
  reproduce: 'Observed failing reproduction on the matching runtime.',
  diagnose: 'Runtime evidence confirming the causal mechanism.',
  'pin-behavior': 'Executable characterization or equivalence baseline.',
  design: 'Design artifact with alternatives, selected structure, and rationale.',
  implement: 'Scoped artifact with source state, changed paths, and digests.',
  review: 'Independent review verdict tied to the exact implementation artifact.',
  verify: 'Checks and runtime evidence against the reviewed artifact.',
  handoff: 'Resolved delivery with retained or integrated artifact evidence for the requested outcome.',
};
const methods = {
  ground: ['how'], reproduce: ['control-cli', 'control-ui'], diagnose: ['how', 'why'],
  'pin-behavior': ['how'], design: ['architect'], implement: ['arena'],
  review: ['code-review', 'interrogate'], verify: ['control-cli', 'control-ui'], handoff: [],
};
const evidence = {
  ground: ['subsystem-trace'],
  reproduce: ['failing-reproduction'],
  diagnose: ['root-cause'],
  'pin-behavior': ['behavior-baseline'],
  design: ['design-artifact'],
  implement: ['artifact-digest'],
  review: ['independent-review'],
  verify: ['verification'],
  handoff: ['handoff'],
};

function closure(entries) {
  const resources = {};
  const unresolved = new Map();
  const queue = [...entries];
  while (queue.length) {
    const path = queue.shift();
    if (resources[path]) continue;
    const absolute = resolve(sourceRoot, path);
    if (!absolute.startsWith(`${sourceRoot}/`) || !existsSync(absolute) || !statSync(absolute).isFile()) {
      unresolved.set(path, { reference: path, reason: 'Local resource unavailable.' });
      continue;
    }
    const text = readFileSync(absolute, 'utf8');
    resources[path] = { sourcePath: absolute, sourceDigest: digest(text), text };
    const refs = [...text.matchAll(/(?:\]\(|`)((?:\.\.\/|references\/|scripts\/|playbooks\/)[^\s`)#]+)(?:#[^\s`)]*)?[`)]/g)];
    for (const [, ref] of refs) {
      const adjacent = resolve(dirname(absolute), ref);
      const skillRelative = resolve(sourceRoot, path.split('/')[0], ref);
      const target = relative(sourceRoot, existsSync(adjacent) ? adjacent : existsSync(skillRelative) ? skillRelative : adjacent);
      queue.push(target);
    }
    for (const [, ref] of text.matchAll(/(?:from\s+|import\s*)['"](\.\.?\/[^'"]+)['"]/g)) {
      const adjacent = resolve(dirname(absolute), ref);
      const resolved = [adjacent, `${adjacent}.ts`, `${adjacent}.js`, adjacent.replace(/\.js$/, '.ts')].find((candidate) => existsSync(candidate));
      queue.push(relative(sourceRoot, resolved ?? adjacent));
    }
    for (const name of skillNames) {
      if (text.includes(`**${name}**`) || text.includes(`\`${name}\``) || text.includes(`/${name}\``)) queue.push(`${name}/SKILL.md`);
    }
    for (const [, name] of text.matchAll(/\*\*([a-z][a-z-]+)\*\* skill/g)) {
      if (!skillNames.includes(name)) unresolved.set(name, { reference: name, sourcePath: absolute, reason: 'Named skill unavailable in the captured source root.' });
    }
  }
  return { resources: Object.fromEntries(Object.entries(resources).sort(([a], [b]) => a.localeCompare(b))), unresolvedReferences: [...unresolved.values()].sort((a, b) => a.reference.localeCompare(b.reference)) };
}

for (const definition of packages) {
  const captured = closure([...common, definition.entry, ...new Set(Object.values(methods).flat().map((name) => `${name}/SKILL.md`))]);
  if (existsSync(licensePath)) {
    const text = readFileSync(licensePath, 'utf8');
    captured.resources['pstack/LICENSE'] = { sourcePath: licensePath, sourceDigest: digest(text), text };
  } else {
    captured.unresolvedReferences.push({ reference: licensePath, reason: 'Pstack license resource unavailable.' });
  }
  const steps = definition.steps.map((name) => ({
    name,
    resources: [...common, definition.entry, ...(methods[name] ?? []).map((method) => `${method}/SKILL.md`)],
    outputContract: contracts[name],
    permittedMethods: methods[name] ?? [],
    requiredEvidence: evidence[name],
    ...(name === 'review' ? { requiresDistinctRole: true } : {}),
    ...(name === 'design' ? { stopBoundary: 'design' } : {}),
  }));
  const transitions = steps.flatMap((step, index) => [
    ...(index < steps.length - 1 ? [{ from: step.name, kind: 'advance', to: steps[index + 1].name }] : []),
    { from: step.name, kind: 'repeat', to: step.name },
    { from: step.name, kind: 'await-decision' },
    { from: step.name, kind: 'block' },
    ...(step.permittedMethods.length ? [{ from: step.name, kind: 'route', routes: step.permittedMethods }] : []),
    { from: step.name, kind: 'finish' },
  ]);
  transitions.push({ from: 'review', kind: 'repeat', to: 'implement' });
  transitions.push({ from: 'verify', kind: 'repeat', to: 'implement' });
  transitions.push({ from: 'implement', kind: 'repeat', to: 'design' });
  const manifest = {
    name: definition.name,
    version: '1.0.0',
    source: { kind: 'local-snapshot', root: sourceRoot, entry: definition.entry, licenseStatus: 'unverified' },
    entryStep: steps[0].name,
    steps,
    transitions,
    limits: { maxAttempts: 20, maxRepeats: 5, parallelism: 4, deadlineMs: 3600000, innerLoopDeadlineMs: 600000 },
    stopBoundaries: ['design'],
    constraints: { independentReview: true, successRequires: 'handoff', inheritedStopBoundaries: true, inheritedExecutionAllowance: true },
    ...captured,
  };
  writeFileSync(join(destination, `${definition.name}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${definition.name}: ${Object.keys(captured.resources).length} resources, ${captured.unresolvedReferences.length} unresolved references`);
}
