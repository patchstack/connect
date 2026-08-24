import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBunLockfile } from '../../src/parsers/bun.js';
import { walkNodeModules } from '../../src/parsers/node_modules.js';
import { scanLockfile } from '../../src/parsers/index.js';
import { disagreements, readDeclaredDependencyNames } from '../../src/parsers/consistency.js';
import { extractName } from '../../src/parsers/yarn.js';

/**
 * Which source the package inventory comes from, and whether it can be trusted.
 *
 * Two ways this produced a wrong answer rather than an error. An isolated install reported NO packages,
 * because its layout is a dot-directory plus symlinks and the walk skipped both — and an empty inventory
 * reads exactly like a project with nothing vulnerable in it. And a lockfile that named every dependency
 * was accepted whatever versions it reported, so a fossil could decide them; the version is what decides
 * whether a package is vulnerable, so that is wrong in both directions.
 */
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ps-parse-'));
  dirs.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, contents);
  }

  return dir;
}

/** A hoisted `node_modules` holding exactly these packages, as the installed tree. */
function installed(cwd: string, packages: Record<string, string>): void {
  for (const [name, version] of Object.entries(packages)) {
    const dir = join(cwd, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }));
  }
}

/** A `bun.lock` as Bun writes it: JSON with trailing commas. */
const BUN_LOCK = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "probe",
      "dependencies": {
        "lodash": "4.17.21",
      },
    },
  },
  "packages": {
    "lodash": ["lodash@4.17.21", "", {}, "sha512-abc=="],
    "@scope/pkg": ["@scope/pkg@1.2.3", "", {}, "sha512-def=="],
    "nested/dep": ["dep@2.0.0", "", {}, "sha512-ghi=="],
  }
}
`;

describe('reading bun.lock', () => {
  it('reads the packages, trailing commas and all', async () => {
    // `JSON.parse` rejects this file as written. Taking a JSON5 dependency for one file would be worse than
    // handling the one difference, and the difference is only the commas.
    const cwd = project({ 'bun.lock': BUN_LOCK });

    const entries = await parseBunLockfile(join(cwd, 'bun.lock'));

    expect(entries).toEqual(
      expect.arrayContaining([
        { name: 'lodash', version: '4.17.21', direct: true },
        { name: '@scope/pkg', version: '1.2.3' },
      ]),
    );
  });

  it('keeps a scoped name whole', async () => {
    const cwd = project({ 'bun.lock': BUN_LOCK });

    const entries = await parseBunLockfile(join(cwd, 'bun.lock'));

    expect(entries.find((entry) => entry.name === '@scope/pkg')?.version).toBe('1.2.3');
  });

  it('takes the name from the descriptor, not the key', async () => {
    // A workspace key can be a path. Naming a package after its position in the file would put something in
    // the inventory that no advisory can match.
    const cwd = project({ 'bun.lock': BUN_LOCK });

    const entries = await parseBunLockfile(join(cwd, 'bun.lock'));

    expect(entries.some((entry) => entry.name === 'dep' && entry.version === '2.0.0')).toBe(true);
    expect(entries.some((entry) => entry.name === 'nested/dep')).toBe(false);
  });

  it('skips an entry whose version is a protocol rather than a release', async () => {
    // `workspace:`, `file:` and git descriptors are installed and are not published releases. Reporting one
    // as a version would name something no advisory can ever match.
    const cwd = project({
      'bun.lock': `{
        "packages": {
          "app": ["app@workspace:.", "", {}, ""],
          "forked": ["forked@github:someone/forked#abc", "", {}, ""],
          "real": ["real@1.0.0", "", {}, "sha512-x=="],
        }
      }`,
    });

    const entries = await parseBunLockfile(join(cwd, 'bun.lock'));

    expect(entries).toEqual([{ name: 'real', version: '1.0.0' }]);
  });

  it('refuses a file it cannot read packages out of, rather than reporting none', async () => {
    // The failure that matters: an empty inventory is indistinguishable from a clean project, so a source
    // this parser cannot read has to raise instead of returning nothing.
    const cwd = project({ 'bun.lock': '{ "lockfileVersion": 1 }' });

    await expect(parseBunLockfile(join(cwd, 'bun.lock'))).rejects.toThrow(/no "packages" entries/);
  });
});

describe('walking an isolated install', () => {
  /** The layout `bun install --linker isolated` produces: a `.bun` store plus top-level symlinks into it. */
  function isolatedInstall(): string {
    const cwd = project({
      'package.json': JSON.stringify({ name: 'probe', dependencies: { lodash: '4.17.21' } }),
      'node_modules/.bun/lodash@4.17.21/node_modules/lodash/package.json': JSON.stringify({
        name: 'lodash',
        version: '4.17.21',
      }),
    });

    symlinkSync(
      join(cwd, 'node_modules/.bun/lodash@4.17.21/node_modules/lodash'),
      join(cwd, 'node_modules/lodash'),
      'dir',
    );

    return cwd;
  }

  it('finds the packages', async () => {
    // Previously nothing: the store is a dot-directory and the top level is a symlink, and both were
    // skipped — one to avoid caches, the other to avoid cycles.
    const entries = await walkNodeModules(isolatedInstall());

    expect(entries.some((entry) => entry.name === 'lodash' && entry.version === '4.17.21')).toBe(true);
  });

  it('counts a package reachable by two paths once', async () => {
    // The store copy and the symlink to it are the same package. Following symlinks without tracking real
    // paths reports it twice — and, on a link pointing back up the tree, does not terminate.
    const entries = await walkNodeModules(isolatedInstall());

    expect(entries.filter((entry) => entry.name === 'lodash')).toHaveLength(1);
  });

  it('terminates on a symlink cycle', async () => {
    const cwd = project({
      'package.json': JSON.stringify({ name: 'probe' }),
      'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', version: '1.0.0' }),
    });
    // A package whose nested node_modules points back at the root.
    symlinkSync(join(cwd, 'node_modules'), join(cwd, 'node_modules/pkg/node_modules'), 'dir');

    const entries = await walkNodeModules(cwd);

    expect(entries.filter((entry) => entry.name === 'pkg')).toHaveLength(1);
  });

  it('still skips a cache directory', async () => {
    // The control for descending into stores: `.cache` is not a store, and reading manifests out of one
    // would report packages the build does not load.
    const cwd = project({
      'package.json': JSON.stringify({ name: 'probe' }),
      'node_modules/real/package.json': JSON.stringify({ name: 'real', version: '1.0.0' }),
      'node_modules/.cache/stale/package.json': JSON.stringify({ name: 'stale', version: '9.9.9' }),
    });

    const entries = await walkNodeModules(cwd);

    expect(entries.some((entry) => entry.name === 'real')).toBe(true);
    expect(entries.some((entry) => entry.name === 'stale')).toBe(false);
  });
});

describe('choosing between sources that disagree', () => {
  it('names the packages two sources report differently', () => {
    const conflicts = disagreements(
      [{ name: 'a', version: '1.0.0' }, { name: 'b', version: '2.0.0' }],
      [{ name: 'a', version: '1.5.0' }, { name: 'b', version: '2.0.0' }],
    );

    expect(conflicts).toEqual([{ name: 'a', version: '1.0.0', otherVersion: '1.5.0' }]);
  });

  it('does not call a package missing from one source a disagreement', () => {
    // That is a difference in what got installed, which the staleness check answers. Treating it as a
    // version conflict would make every partial source look contradictory.
    expect(disagreements([{ name: 'a', version: '1.0.0' }], [{ name: 'b', version: '2.0.0' }])).toEqual([]);
  });

  it('falls back to the installed tree when two complete lockfiles disagree', async () => {
    // Both name every dependency, so a name check accepts whichever is read first — and they report
    // different versions. Neither can be preferred on the evidence here, so what the build actually loads
    // decides, and the disagreement is reported.
    const cwd = project({
      'package.json': JSON.stringify({ name: 'probe', dependencies: { lodash: '^4.0.0' } }),
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/lodash': { version: '4.17.15' } },
      }),
      'bun.lock': `{
        "workspaces": { "": { "name": "probe", "dependencies": { "lodash": "^4.0.0" } } },
        "packages": { "lodash": ["lodash@4.17.21", "", {}, "sha512-x=="] }
      }`,
      'node_modules/lodash/package.json': JSON.stringify({ name: 'lodash', version: '4.17.21' }),
    });

    const manifest = await scanLockfile(cwd);

    expect(manifest.packages.find((entry) => entry.name === 'lodash')?.version).toBe('4.17.21');
    expect(manifest.warnings?.join(' ')).toMatch(/disagree about installed versions/);
  });

  it('says nothing when the sources agree', async () => {
    // The control. Without it the assertion above would also pass for a scanner that always warned and
    // always walked, which would make the lockfile parsers pointless.
    const cwd = project({
      'package.json': JSON.stringify({ name: 'probe', dependencies: { lodash: '^4.0.0' } }),
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/lodash': { version: '4.17.21' } },
      }),
      'bun.lock': `{
        "workspaces": { "": { "name": "probe", "dependencies": { "lodash": "^4.0.0" } } },
        "packages": { "lodash": ["lodash@4.17.21", "", {}, "sha512-x=="] }
      }`,
    });

    const manifest = await scanLockfile(cwd);

    expect(manifest.packages.find((entry) => entry.name === 'lodash')?.version).toBe('4.17.21');
    expect(manifest.warnings ?? []).toEqual([]);
  });
});

describe('what counts as a declared dependency', () => {
  it('includes optional dependencies', async () => {
    // They are installed when the platform supports them and they can be vulnerable, so a lockfile that
    // omits one is stale — and without this it read as complete.
    const cwd = project({
      'package.json': JSON.stringify({
        name: 'probe',
        dependencies: { a: '^1.0.0' },
        optionalDependencies: { b: '^2.0.0' },
      }),
    });

    expect((await readDeclaredDependencyNames(cwd)).sort()).toEqual(['a', 'b']);
  });

  it('still excludes a non-registry specifier', async () => {
    // The lockfile parsers skip those, so their absence says nothing about staleness.
    const cwd = project({
      'package.json': JSON.stringify({
        name: 'probe',
        optionalDependencies: { local: 'file:../local' },
      }),
    });

    expect(await readDeclaredDependencyNames(cwd)).toEqual([]);
  });
});

describe('reading a Yarn Berry descriptor', () => {
  it('names an ordinary package', () => {
    expect(extractName('axios@^1.6.0')).toBe('axios');
    expect(extractName('"@scope/pkg@^2.1.0"')).toBe('@scope/pkg');
    expect(extractName('"@scope/pkg@npm:2.1.0"')).toBe('@scope/pkg');
  });

  it('reports a workspace entry as no package at all', () => {
    // A local package in this repository is not something an advisory can be about, and the protocol puts
    // an `@` in the range — so splitting on the last one produced a name that is part range.
    expect(extractName('my-app@workspace:.')).toBeNull();
    expect(extractName('"pkg@workspace:packages/pkg"')).toBeNull();
  });

  it('reports a patched entry as no package', () => {
    // The range contains a whole nested descriptor, so the last `@` is inside it.
    expect(extractName('lodash@patch:lodash@npm%3A4.17.20#./.yarn/patches/lodash.patch')).toBeNull();
  });

  it('reports the other non-registry protocols as no package', () => {
    for (const spec of [
      'pkg@virtual:abc#npm:1.0.0',
      'pkg@portal:../pkg',
      'pkg@file:./vendor/pkg',
      'pkg@link:../pkg',
      'pkg@github:owner/repo',
      'pkg@https://example.test/pkg.tgz',
    ]) {
      expect(extractName(spec), spec).toBeNull();
    }
  });

  it('resolves an alias to the package that is installed', () => {
    // `alias@npm:real@1.2.3` installs `real`. That is what an advisory would be about; the alias is only
    // what the app imports it by.
    expect(extractName('my-lodash@npm:lodash@4.17.21')).toBe('lodash');
    expect(extractName('"my-scoped@npm:@scope/real@1.0.0"')).toBe('@scope/real');
  });

  it('keeps the name when npm: carries only a version', () => {
    // The control for the alias branch: `npm:1.2.3` is a plain version for this package, not a rename.
    expect(extractName('axios@npm:1.6.0')).toBe('axios');
  });
});

describe('a bun.lockb project whose npm lock disagrees', () => {
  it('reports the installed tree, not the lockfile it was overruled by', async () => {
    // `bun.lockb` is binary, so the only way to read that project is the installed tree — which means the
    // tree was already walked by the time a conflict is found. Remembering only that a walk had happened
    // made the conflict fall back to the very lockfile the tree contradicts, while the warning said
    // node_modules had been used.
    const dir = project({
      'package.json': JSON.stringify({ name: 'fixture', dependencies: { lodash: '^4.17.21' } }),
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/lodash': { version: '4.17.15' } },
      }),
      'bun.lockb': 'binary-placeholder',
    });
    installed(dir, { lodash: '4.17.21' });

    const manifest = await scanLockfile(dir);

    expect(manifest.packages.find((p) => p.name === 'lodash')?.version).toBe('4.17.21');
    expect(manifest.warnings?.join(' ')).toContain('4.17.15');
    expect(manifest.warnings?.join(' ')).toContain('node_modules/');
  });

  it('still reports the lockfile when the two agree', async () => {
    // The control. Without it the fix would be satisfied by always preferring node_modules, which is a
    // slower scan and a different answer on a project that is simply consistent.
    const dir = project({
      'package.json': JSON.stringify({ name: 'fixture', dependencies: { lodash: '^4.17.21' } }),
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/lodash': { version: '4.17.21' } },
      }),
      'bun.lockb': 'binary-placeholder',
    });
    installed(dir, { lodash: '4.17.21' });

    const manifest = await scanLockfile(dir);

    expect(manifest.packages.find((p) => p.name === 'lodash')?.version).toBe('4.17.21');
    expect(manifest.warnings).toBeUndefined();
  });
});
