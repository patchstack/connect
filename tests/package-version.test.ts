import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('reports `unknown` rather than failing when the manifest carries no version', () => {
    // The fallback, actually exercised. Asserting that the NORMAL invocation is not `unknown` would say
    // nothing about the fallback at all — it would pass whether the fallback worked, threw, or printed an
    // empty line.
    //
    // So the CLI is run somewhere its manifest lookup resolves to a real file with no `version` in it:
    // `<tmp>/sub/cli.mjs` reads `<tmp>/package.json`. The `.mjs` extension matters — a bare `.js` outside
    // a `"type": "module"` package is parsed as CommonJS and would fail on the bundle's own syntax, which
    // is a different failure wearing the same exit code.
    const cli = url('../dist/cli.js');
    if (!existsSync(cli)) return;

    const dir = mkdtempSync(join(tmpdir(), 'ps-version-'));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'not-connect', type: 'module' }));
    copyFileSync(cli, join(dir, 'sub', 'cli.mjs'));

    const run = spawnSync(process.execPath, [join(dir, 'sub', 'cli.mjs'), '--version'], { encoding: 'utf8' });
    rmSync(dir, { recursive: true, force: true });

    // Exit 0 as well as the right text: a diagnostic string is never worth failing a command over, and a
    // non-zero exit here would break `--version` in exactly the situation someone runs it — when something
    // about the installation is already wrong.
    expect({ status: run.status, stdout: run.stdout.trim() }).toEqual({ status: 0, stdout: 'unknown' });
  });

  it('reports `unknown` rather than failing when there is no manifest at all', () => {
    // The other half, and the one that reaches the `catch`. The test above finds a real manifest that
    // simply has no `version`, which is handled by a type check and never throws — so on its own it leaves
    // the catch block untested, and a fallback that rethrew or printed an empty line would pass it.
    //
    // Here NO `package.json` is written beside the copy. The lookup is a relative specifier, which
    // resolves exactly one path and does not walk up the tree, so it cannot find a real manifest from an
    // ancestor directory: it throws, which is the path being covered.
    const cli = url('../dist/cli.js');
    if (!existsSync(cli)) return;

    const dir = mkdtempSync(join(tmpdir(), 'ps-version-'));
    mkdirSync(join(dir, 'sub'));
    copyFileSync(cli, join(dir, 'sub', 'cli.mjs'));

    const run = spawnSync(process.execPath, [join(dir, 'sub', 'cli.mjs'), '--version'], { encoding: 'utf8' });
    rmSync(dir, { recursive: true, force: true });

    expect({ status: run.status, stdout: run.stdout.trim() }).toEqual({ status: 0, stdout: 'unknown' });
  });
});
