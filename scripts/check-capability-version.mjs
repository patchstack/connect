#!/usr/bin/env node
// Fails when the capability vocabulary changed without a matching version bump.
//
// The version is what makes vendoring safe: a consumer records which version it copied, and decides
// whether it must re-read the contract. That only works if the number actually moves — and nothing so far
// made it. Adding a member, regenerating the manifest and leaving the version alone passed every existing
// check, which is the same silent-drift failure the manifest was introduced to remove, one level up.
//
// Classification:
//   breaking  a member removed or renamed, a field removed, or a scalar changed → MAJOR
//             (a consumer pinned to the old list keeps emitting a value that can no longer match)
//   additive  a member or field added                                          → MINOR or MAJOR
//   none      no vocabulary change                                             → no requirement
//
// Usage:  node scripts/check-capability-version.mjs [--base <ref>]     (default: origin/main)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = 'capabilities.json';
const argBase = process.argv.indexOf('--base');
const base = argBase !== -1 ? process.argv[argBase + 1] : process.env.BASE_REF || 'origin/main';

const head = JSON.parse(readFileSync(join(root, FILE), 'utf8'));

let before;
try {
  before = JSON.parse(execFileSync('git', ['show', `${base}:${FILE}`], { cwd: root, encoding: 'utf8' }));
} catch {
  // Absent at the base: this commit introduces the contract, so there is nothing to bump from.
  console.log(`${FILE} does not exist at ${base} — contract is new, no bump required.`);
  process.exit(0);
}

const semver = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? '');
  if (!m) throw new Error(`version ${JSON.stringify(v)} is not semver`);
  return { major: +m[1], minor: +m[2], patch: +m[3] };
};

const vocabularies = (doc) =>
  Object.entries(doc).filter(([k, v]) => k !== 'version' && k !== '$comment');

const added = [];
const removed = [];

const beforeMap = new Map(vocabularies(before));
const headMap = new Map(vocabularies(head));

for (const [key, value] of headMap) {
  if (!beforeMap.has(key)) {
    added.push(`field ${key}`);
    continue;
  }
  const was = beforeMap.get(key);
  if (Array.isArray(value) && Array.isArray(was)) {
    for (const m of value) if (!was.includes(m)) added.push(`${key}.${m}`);
    for (const m of was) if (!value.includes(m)) removed.push(`${key}.${m}`);
  } else if (value !== was) {
    // A scalar change (e.g. which tier may auto-promote) changes the MEANING of the contract for every
    // consumer, so it is breaking even though nothing was removed from a list.
    removed.push(`${key}: ${JSON.stringify(was)} → ${JSON.stringify(value)}`);
  }
}
for (const key of beforeMap.keys()) if (!headMap.has(key)) removed.push(`field ${key}`);

const from = semver(before.version);
const to = semver(head.version);
const bump = to.major > from.major ? 'major' : to.minor > from.minor ? 'minor' : to.patch > from.patch ? 'patch' : 'none';

const describe = () => {
  const parts = [];
  if (added.length) parts.push(`added: ${added.join(', ')}`);
  if (removed.length) parts.push(`removed/changed: ${removed.join(', ')}`);
  return parts.join(' | ');
};

const fail = (msg) => {
  console.error(`\n${FILE}: ${msg}`);
  console.error(`  base ${base} = ${before.version}, head = ${head.version}`);
  console.error(`  ${describe()}`);
  console.error(`\n  Bump CAPABILITY_VERSION in src/map/capabilities.ts, then \`npm run capabilities\`.`);
  process.exit(1);
};

if (removed.length > 0) {
  if (to.major <= from.major) {
    fail('the vocabulary lost or redefined a member, which is BREAKING — a consumer pinned to the '
      + 'old list keeps emitting a value that can no longer match. A major bump is required.');
  }
  console.log(`${FILE}: breaking change with a major bump (${before.version} → ${head.version}). ${describe()}`);
} else if (added.length > 0) {
  if (bump === 'none' || bump === 'patch') {
    fail('the vocabulary gained a member, so consumers that vendored the old copy are now behind. '
      + 'A minor bump (or major) is required.');
  }
  console.log(`${FILE}: additive change with a ${bump} bump (${before.version} → ${head.version}). ${describe()}`);
} else {
  console.log(`${FILE}: no vocabulary change (version ${head.version}).`);
}
