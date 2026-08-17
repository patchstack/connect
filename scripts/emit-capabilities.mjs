#!/usr/bin/env node
// Writes `capabilities.json` from the TypeScript definition in src/map/capabilities.ts.
//
// The JSON is what the other layers vendor: the rule-authoring toolchain and the platform that binds a
// coordinate into a rule. Neither can import TypeScript, and hand-copying the lists is the drift this
// file exists to prevent — a member added here and missed there produces a value that can never match,
// with nothing to notice it.
//
// Not generated at build time on purpose: it is committed, so a change to the vocabulary shows up as a
// reviewable diff in the contract rather than appearing silently in dist. `tests/map/capabilities.test.ts`
// fails if the committed file drifts from the source.
//
// Deliberately NOT in package.json `files`: the consumers vendor this file from source, and the published
// package's contents are a reviewed surface of their own (see
// tests/pack-safety.test.ts). Vendoring is what makes the version field load-bearing — a consumer records
// which version it copied.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/map/capabilities.ts'), 'utf8');

// Parsed rather than imported so this script needs no build step and no TypeScript loader.
const arrayOf = (name) => {
  const m = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`, 's').exec(src);
  if (!m) throw new Error(`could not find ${name} in src/map/capabilities.ts`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
};
const stringOf = (name) => {
  const m = new RegExp(`export const ${name} = '([^']+)';`).exec(src);
  if (!m) throw new Error(`could not find ${name}`);
  return m[1];
};

const manifest = {
  $comment:
    'GENERATED from src/map/capabilities.ts by scripts/emit-capabilities.mjs — do not edit by hand. ' +
    'The single versioned definition of what the input-flow map can describe, vendored by the ' +
    'reachability recipe schema/validator and by the server that binds coordinates into rules.',
  version: stringOf('CAPABILITY_VERSION'),
  sinkKinds: arrayOf('SINK_KINDS'),
  argumentRoles: arrayOf('ARGUMENT_ROLES'),
  candidateFamilies: arrayOf('CANDIDATE_FAMILIES'),
  confidenceTiers: arrayOf('CONFIDENCE_TIERS'),
  provenConfidenceTiers: arrayOf('PROVEN_CONFIDENCE_TIERS'),
  autoPromotableConfidence: stringOf('AUTO_PROMOTABLE_CONFIDENCE'),
  attributions: arrayOf('ATTRIBUTIONS'),
  addressSpaces: arrayOf('ADDRESS_SPACES'),
  invocationKinds: arrayOf('INVOCATION_KINDS'),
  invocationResolutions: arrayOf('INVOCATION_RESOLUTIONS'),
};

const out = join(root, 'capabilities.json');
const text = JSON.stringify(manifest, null, 2) + '\n';
if (process.argv.includes('--check')) {
  const current = readFileSync(out, 'utf8');
  if (current !== text) {
    console.error('capabilities.json is stale — run `npm run capabilities` and commit the result.');
    process.exit(1);
  }
  console.log('capabilities.json is up to date.');
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out} (version ${manifest.version})`);
}
