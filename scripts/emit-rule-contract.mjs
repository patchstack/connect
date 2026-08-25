#!/usr/bin/env node
// Writes `rule-contract.json` from src/protect/rules/contract.js.
//
// The engine's rule vocabulary, published for the layers that produce or forward a rule document: the
// vPatch skill that authors one, Hub's importer, and the platform's ingress. None of them can import this
// package's source, and each of them was checking a different, weaker thing — so a rule naming a source the
// resolver cannot resolve passed every gate and screened nothing.
//
// Committed, like capabilities.json, so a vocabulary change is a reviewable diff rather than something that
// appears silently in dist. `tests/protect/rule-contract-artifact.test.ts` fails if it drifts from source.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ruleContract } from '../src/protect/rules/contract.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'rule-contract.json');

const document = {
  $comment: 'Generated from src/protect/rules/contract.js by scripts/emit-rule-contract.mjs. Do not edit.',
  ...ruleContract(),
};

const text = JSON.stringify(document, null, 2) + '\n';

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(out, 'utf8');
  } catch {
    console.error('rule-contract.json is missing — run `npm run rule-contract` and commit the result.');
    process.exit(1);
  }
  if (current !== text) {
    console.error('rule-contract.json is stale — run `npm run rule-contract` and commit the result.');
    process.exit(1);
  }
  console.log('rule-contract.json is up to date.');
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out} (contract version ${document.version})`);
}
