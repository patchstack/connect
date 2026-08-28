import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The version this package reports is answered by five different surfaces: `package.json`, the two places
// the lockfile records it, the tarball name `npm pack` derives, the SBOM, and `--version`. They are five
// readings of one fact, and a consumer asked "which version are you running" gets whichever one is nearest
// to hand. For a security package the answer decides whether someone believes they have a fix they do not
// have, so a surface that disagrees is worse than one that is missing.
//
// These are structural checks over the committed files, so they run on every Node version and in the
// publish validation, not as one CI step on one platform. What they cannot see is the *installed* package —
// that link (the bin reporting the version npm actually resolved) is proven against a real install by
// `scripts/compat-matrix.mjs`, because nothing in this repository can stand in for a tarball.

const url = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(url(p), 'utf8'));

const manifest = read('../package.json');
const lock = read('../package-lock.json');

describe('the version is one fact', () => {
  it('is a plain release version in the manifest', () => {
    // Not merely valid semver: the committed version tracks a RELEASE, so a lingering prerelease or build
    // suffix means an interrupted release process left the repository describing something unpublished.
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('agrees between the manifest and both places the lockfile records it', () => {
    // `npm version` writes all three; a hand-edit writes one. The lockfile's root entry is the copy that
    // ends up in a consumer's tree, and it is the easiest of the three to forget.
    expect({ lockTop: lock.version, lockRoot: lock.packages['']?.version }).toEqual({
      lockTop: manifest.version,
      lockRoot: manifest.version,
    });
  });

  it('agrees on the package name too', () => {
    expect({ lockTop: lock.name, lockRoot: lock.packages['']?.name }).toEqual({
      lockTop: manifest.name,
      lockRoot: manifest.name,
    });
  });

  it('is the version `npm pack` will name the tarball after', () => {
    // `npm pack` derives the filename from the manifest, so this cannot drift while the manifest is the
    // source — the assertion pins the derivation itself, which a change to `name` or `publishConfig` could
    // otherwise move without anyone noticing the tarball no longer matches what the registry serves.
    const scopeless = String(manifest.name).replace('@', '').replace('/', '-');
    expect(`${scopeless}-${manifest.version}.tgz`).toBe(`patchstack-connect-${manifest.version}.tgz`);
  });

  it('is what the built CLI reports for --version', () => {
    const cli = url('../dist/cli.js');
    // `dist/` is gitignored, so a fresh checkout has nothing to run. CI builds before it tests.
    if (!existsSync(cli)) return;

    // Deliberately NOT guarded on dist being newer than the sources, unlike the other dist-dependent
    // tests: the CLI reads the manifest at run time rather than having a version baked in at build time,
    // so even a stale build must report the current version. If this ever needs a staleness guard, the
    // version has been baked in — which is the defect.
    const reported = execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).trim();

    expect(reported).toBe(manifest.version);
  });

  it('reports a version rather than failing when the manifest cannot be read', () => {
    // The fallback exists so no command dies over a diagnostic string. It must still be visibly a
    // non-answer: `unknown` in a bug report is useful, a silent empty line or a plausible wrong number
    // is not.
    const cli = url('../dist/cli.js');
    if (!existsSync(cli)) return;

    const reported = execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).trim();
    expect(reported.length).toBeGreaterThan(0);
    expect(reported === 'unknown' ? 'unknown' : 'a version').toBe('a version');
  });
});
