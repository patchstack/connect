import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildWirePayload } from '../src/normalize.js';
import { computeManifestChecksum } from '../src/checksum.js';
import { scanLockfile } from '../src/parsers/index.js';
import { installLocation } from '../src/parsers/node_modules.js';
import type { Manifest } from '../src/types.js';

/**
 * Which INSTALLED INSTANCE does the app's import resolve to?
 *
 * The same package is routinely installed more than once at different versions — a workspace pinning an
 * old copy under `apps/api/node_modules`, a transitive dependency getting a nested install. The manifest
 * knew where each one lived; `buildWirePayload` projected every entry to `{name, version}` and the
 * locations were dropped at the wire boundary, unread by anything.
 *
 * So `lodash@4.17.11` and `lodash@4.17.21` arrived as two bare pairs. An advisory matching only the older
 * one cannot be resolved against the app's code: the consumer either warns on a copy nothing reaches, or
 * pins a rule to a route that runs the safe one — a rule that never fires while reporting as protection.
 *
 * Node resolves an import by walking up from the importing file, so the map's import sites and these
 * paths together answer the question. Neither half answers it alone, which is why the paths must survive.
 */
function manifest(packages: Manifest['packages']): Manifest {
  return { ecosystem: 'npm', packages };
}

describe('locations are off unless asked for', () => {
  // The package's standing promise is that `scan` sends names and versions and no paths of any kind.
  // Locations widen that, so they are an explicit upload choice rather than something an upgrade turns
  // on for every existing installation.
  const twoInstalls = () => manifest([
    { name: 'lodash', version: '4.17.21', path: 'node_modules/lodash' },
    { name: 'lodash', version: '4.17.11', path: 'apps/api/node_modules/lodash' },
  ]);

  it('sends no location by default, even when the scan found one', () => {
    const { payload } = buildWirePayload(twoInstalls());

    for (const pkg of payload.packages) expect(pkg.paths).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('node_modules');
  });

  it('does not claim completeness when locations were not requested', () => {
    // The distinction the flag must not blur: "no locations here" has to read as "not recorded", never as
    // "installed nowhere else". Claiming completeness over an empty set would license exactly that.
    expect(buildWirePayload(twoInstalls()).payload.installPathsComplete).toBe(false);
  });

  it('still reports every package and version by default', () => {
    // Gating the locations must not gate the vulnerability matching that already worked.
    const { payload } = buildWirePayload(twoInstalls());

    expect(payload.packages.map((p) => `${p.name}@${p.version}`))
      .toEqual(['lodash@4.17.11', 'lodash@4.17.21']);
  });

  it('leaves the checksum identical whether locations are asked for or not', () => {
    // Otherwise turning the flag on would read server-side as a changed build.
    const off = buildWirePayload(twoInstalls()).payload.packages;
    const on = buildWirePayload(twoInstalls(), { installPaths: true }).payload.packages;

    expect(computeManifestChecksum(off)).toBe(computeManifestChecksum(on));
  });
});

describe('install locations on the wire', () => {
  it('keeps a location for each distinct version of the same package', () => {
    const { payload } = buildWirePayload(manifest([
      { name: 'lodash', version: '4.17.21', path: 'node_modules/lodash', direct: true },
      { name: 'lodash', version: '4.17.11', path: 'apps/api/node_modules/lodash', direct: false },
    ]), { installPaths: true });

    expect(payload.packages).toEqual([
      { name: 'lodash', version: '4.17.11', paths: ['apps/api/node_modules/lodash'] },
      { name: 'lodash', version: '4.17.21', paths: ['node_modules/lodash'] },
    ]);
    expect(payload.installPathsComplete).toBe(true);
  });

  it('collects EVERY location of one version rather than keeping the first', () => {
    // The dedupe by name+version is deliberate and stays. But the entries it dropped were the only record
    // of the other locations, so dropping them lost exactly the information this change exists to carry:
    // one copy at the root and one pinned inside a workspace is the case that needs distinguishing.
    const { payload } = buildWirePayload(manifest([
      { name: 'ms', version: '2.1.3', path: 'node_modules/ms' },
      { name: 'ms', version: '2.1.3', path: 'node_modules/debug/node_modules/ms' },
      { name: 'ms', version: '2.1.3', path: 'apps/web/node_modules/ms' },
    ]), { installPaths: true });

    expect(payload.packages).toHaveLength(1);
    expect(payload.packages[0]!.paths).toEqual([
      'apps/web/node_modules/ms',
      'node_modules/debug/node_modules/ms',
      'node_modules/ms',
    ]);
  });

  it('sorts locations so a rebuild does not look like a changed app', () => {
    // Scan order follows a lockfile's key order or a filesystem walk. Unsorted, the same tree produces a
    // different payload on a different machine, and the server reads it as a change.
    const forward = buildWirePayload(manifest([
      { name: 'ms', version: '1.0.0', path: 'node_modules/a/node_modules/ms' },
      { name: 'ms', version: '1.0.0', path: 'node_modules/ms' },
    ]), { installPaths: true });
    const reverse = buildWirePayload(manifest([
      { name: 'ms', version: '1.0.0', path: 'node_modules/ms' },
      { name: 'ms', version: '1.0.0', path: 'node_modules/a/node_modules/ms' },
    ]), { installPaths: true });

    expect(JSON.stringify(forward.payload)).toBe(JSON.stringify(reverse.payload));
  });

  it('refuses to claim completeness when any entry had no location', () => {
    // A yarn.lock is flat: hoisting is decided at install time and the file does not record it. A missing
    // `paths` must read as "not recorded", never as "not installed there" — the second is an answer, and
    // this source cannot give one.
    const { payload } = buildWirePayload(manifest([
      { name: 'lodash', version: '4.17.21', path: 'node_modules/lodash' },
      { name: 'ms', version: '2.1.3' },
    ]), { installPaths: true });

    expect(payload.installPathsComplete).toBe(false);
    expect(payload.packages.find((p) => p.name === 'ms')?.paths).toBeUndefined();
    // The entry that DID have one still carries it: a partial answer is still worth more than none, as
    // long as the flag stops it being read as total.
    expect(payload.packages.find((p) => p.name === 'lodash')?.paths).toEqual(['node_modules/lodash']);
  });

  it('does not claim completeness for an empty package list', () => {
    // Vacuous truth is the wrong answer here: "every entry has a location" of nothing would report a
    // complete inventory of locations for a scan that found no packages at all.
    expect(buildWirePayload(manifest([]), { installPaths: true }).payload.installPathsComplete).toBe(false);
  });

  it('leaves the manifest checksum byte-identical', () => {
    // The fingerprint is compared against one computed server-side over `{name, version}` only. If added
    // fields changed it, every already-reported build would read as changed the moment this shipped.
    const withPaths = buildWirePayload(manifest([
      { name: 'lodash', version: '4.17.21', path: 'node_modules/lodash' },
      { name: 'ms', version: '2.1.3', path: 'node_modules/ms' },
    ]), { installPaths: true });
    const without = buildWirePayload(manifest([
      { name: 'lodash', version: '4.17.21' },
      { name: 'ms', version: '2.1.3' },
    ]), { installPaths: true });

    expect(computeManifestChecksum(withPaths.payload.packages))
      .toBe(computeManifestChecksum(without.payload.packages));
  });
});

describe('a location never names the machine', () => {
  // The same invariant that a sibling change got wrong: a path relativized against the wrong root escapes
  // to `../../home/runner/...`, and this payload is uploaded. Asserted over every source that can produce
  // one, because the failure is silent — an escaped path is still a string and every other assertion
  // about it passes. A v1 lockfile is absent here because it deliberately produces no location at all.
  const sources: Array<{ what: string; files: Record<string, string> }> = [
    {
      what: 'an npm v3 lockfile',
      files: {
        'package.json': JSON.stringify({ name: 'root', dependencies: { lodash: '^4.17.21' } }),
        'package-lock.json': JSON.stringify({
          name: 'root',
          lockfileVersion: 3,
          packages: { '': { name: 'root' }, 'node_modules/lodash': { version: '4.17.21' }, 'apps/api/node_modules/lodash': { version: '4.17.11' } },
        }),
      },
    },
    {
      what: 'the node_modules walk',
      files: {
        'package.json': JSON.stringify({ name: 'root', dependencies: { lodash: '^4.17.21' } }),
        'bun.lockb': 'binary-stub',
        'node_modules/lodash/package.json': JSON.stringify({ name: 'lodash', version: '4.17.21' }),
        'node_modules/debug/node_modules/ms/package.json': JSON.stringify({ name: 'ms', version: '2.1.2' }),
      },
    },
  ];

  for (const { what, files } of sources) {
    it(`stays repo-relative from ${what}`, async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'ps-abs-'));
      for (const [rel, body] of Object.entries(files)) {
        mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
        writeFileSync(path.join(dir, rel), body);
      }
      try {
        const { payload } = buildWirePayload(await scanLockfile(dir), { installPaths: true });
        const all = payload.packages.flatMap((pkg) => pkg.paths ?? []);

        expect(all.length).toBeGreaterThan(0);
        for (const location of all) {
          expect(path.isAbsolute(location)).toBe(false);
          expect(location.split('/')).not.toContain('..');
        }
        expect(JSON.stringify(payload)).not.toContain(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('a location is POSIX-style whatever platform produced it', () => {
  it('normalizes a Windows separator', () => {
    // Lockfile paths are POSIX-style on every platform, and the server compares against them. On Windows
    // the raw `path.relative` result would be `node_modules\\lodash` and match nothing — the correlation
    // would fail silently on exactly one platform. CI runs on ubuntu only and `path.sep` is already `/` on
    // every development machine here, so the platform module is passed in: otherwise no test can tell
    // whether this normalization is still happening.
    expect(installLocation('C:\\app', 'C:\\app\\apps\\api\\node_modules\\lodash', path.win32))
      .toBe('apps/api/node_modules/lodash');
  });

  it('leaves a POSIX path alone', () => {
    expect(installLocation('/app', '/app/node_modules/lodash', path.posix)).toBe('node_modules/lodash');
  });
});

describe('the sources that can supply a location', () => {
  function project(files: Record<string, string>) {
    const dir = mkdtempSync(path.join(tmpdir(), 'ps-inst-'));
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), body);
    }

    return dir;
  }

  it('reads them from an npm v3 lockfile, where the key IS the path', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['apps/*'], dependencies: { lodash: '^4.17.21' } }),
      'package-lock.json': JSON.stringify({
        name: 'root',
        lockfileVersion: 3,
        packages: {
          '': { name: 'root', dependencies: { lodash: '^4.17.21' } },
          'node_modules/lodash': { version: '4.17.21' },
          'apps/api/node_modules/lodash': { version: '4.17.11' },
        },
      }),
    });
    try {
      const { payload } = buildWirePayload(await scanLockfile(dir), { installPaths: true });
      const lodash = payload.packages.filter((p) => p.name === 'lodash');

      expect(lodash).toEqual([
        { name: 'lodash', version: '4.17.11', paths: ['apps/api/node_modules/lodash'] },
        { name: 'lodash', version: '4.17.21', paths: ['node_modules/lodash'] },
      ]);
      expect(payload.installPathsComplete).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to invent them from a v1 lockfile, whose nesting is the GRAPH and not the layout', async () => {
    // A v1 lockfile's nested `dependencies` map describes the dependency graph. npm hoists and dedupes,
    // so a package nested under `debug` there is usually installed at the top level and the nesting only
    // survives where a version conflict forced it. Reading the graph as the layout invents a path that is
    // wrong in the common case — and a confident wrong location binds an advisory to the wrong instance,
    // which is the very failure `paths` exists to prevent, reached from the other side.
    //
    // An earlier version of this change did exactly that, and claimed `installPathsComplete: true` over
    // it. No path at all is the honest answer; the walk is what can supply one for a v1 project.
    const dir = project({
      'package.json': JSON.stringify({ name: 'root', dependencies: { debug: '^4.0.0' } }),
      'package-lock.json': JSON.stringify({
        name: 'root',
        lockfileVersion: 1,
        dependencies: {
          debug: { version: '4.3.4', dependencies: { ms: { version: '2.1.2' } } },
          ms: { version: '2.1.3' },
        },
      }),
    });
    try {
      const { payload } = buildWirePayload(await scanLockfile(dir), { installPaths: true });

      expect(payload.installPathsComplete).toBe(false);
      for (const pkg of payload.packages) expect(pkg.paths).toBeUndefined();
      // The versions are still reported — dropping the location does not drop the package.
      expect(payload.packages.map((p) => `${p.name}@${p.version}`).sort())
        .toEqual(['debug@4.3.4', 'ms@2.1.2', 'ms@2.1.3']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
