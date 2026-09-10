// Writing this build's identity into the guard's own rules file.
//
// The file belongs to the project, is committed, and holds the rule bundle the engine reads. So the
// cases that matter are the ones where this must NOT write: an unprotected project, somebody else's
// `rules.json`, a file that is no longer valid JSON, and more than one candidate. And the one where it
// must write something surprising — clearing a previous stamp when this build has no identity, because
// a left-behind value would let this build claim a build it is not.
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { hasRawBuildStamp, readBuildStamp } from '../src/build-id.js';
import { applyBuildStamp, findRulesFile } from '../src/build-stamp.js';
import { isPreBundleBuildHook } from '../src/build-hook.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

/** Built from character codes so this source file carries no control character of its own. */
const CRLF = String.fromCharCode(13) + String.fromCharCode(10);

const BUNDLE = {
  _comment: 'Starter fallback rules',
  firewall: [{ id: 'rm-npm-0001' }],
  whitelists: [],
  whitelist_keys: {},
};

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ps-stamp-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }

  return dir;
}

const bundleText = (extra: Record<string, unknown> = {}) => `${JSON.stringify({ ...BUNDLE, ...extra }, null, 2)}\n`;
const read = (dir: string, rel: string) => readFileSync(join(dir, rel), 'utf8');
const guardSource = (rulesName: string) =>
  `import { createProtection } from "@patchstack/connect/protect";\nimport rules from "./${rulesName}";\nvoid createProtection({ rules });\n`;
function protectedProject(rulesRel: string, body: string, extra: Record<string, string> = {}): string {
  const guardRel = join(dirname(rulesRel), 'guard.ts');

  return project({ ...extra, [rulesRel]: body, [guardRel]: guardSource(basename(rulesRel)) });
}

describe('finding the file to stamp', () => {
  it('finds the bundle a scaffolded guard imports, wherever it sits', () => {
    for (const rel of ['patchstack.rules.json', 'src/patchstack.rules.json', 'src/integrations/patchstack/rules.json']) {
      const dir = protectedProject(rel, bundleText());
      expect(findRulesFile(dir), rel).toEqual({ kind: 'one', path: join(dir, rel) });
    }
  });

  it.each([
    ['ES module import', 'import rules from "./rules.json";'],
    ['CommonJS require', 'const rules = require("./rules.json");'],
    ['runtime URL read', 'const url = new URL("./rules.json", import.meta.url);'],
  ])('recognises the shipped %s form', (_label, load) => {
    const dir = project({
      'rules.json': bundleText(),
      'guard.js': `import { createProtection } from "@patchstack/connect/protect";\n${load}\nvoid createProtection;\n`,
    });

    expect(findRulesFile(dir)).toEqual({ kind: 'one', path: join(dir, 'rules.json') });
  });

  it('does not treat names in comments as an installed guard', () => {
    const dir = project({
      'rules.json': bundleText(),
      'guard.ts': '// @patchstack/connect/protect\n// import rules from "./rules.json";\nexport const unrelated = true;\n',
    });

    expect(findRulesFile(dir)).toEqual({ kind: 'none' });
  });

  it('does not mistake somebody else’s rules.json for ours', () => {
    const dir = project({
      'rules.json': JSON.stringify({ firewall: [], whitelists: [], whitelist_keys: {}, owner: 'another policy engine' }),
    });
    expect(findRulesFile(dir)).toEqual({ kind: 'none' });
    expect(applyBuildStamp(dir, A).kind).toBe('skipped');
    expect(readBuildStamp(JSON.parse(read(dir, 'rules.json')))).toBeNull();
  });

  it('does not walk dependencies, build output or hidden directories', () => {
    const dir = project({
      'node_modules/some-pkg/patchstack.rules.json': bundleText(),
      'dist/patchstack.rules.json': bundleText(),
      '.cache/patchstack.rules.json': bundleText(),
    });
    expect(findRulesFile(dir)).toEqual({ kind: 'none' });
  });

  it('does not follow a symlinked directory out of the project', () => {
    // A file outside the project is never a build-hook write target, even when a path inside points at it.
    const outside = mkdtempSync(join(tmpdir(), 'ps-outside-'));
    dirs.push(outside);
    mkdirSync(join(outside, 'nested'), { recursive: true });
    writeFileSync(join(outside, 'nested', 'rules.json'), bundleText());

    const dir = project({ 'package.json': '{}' });
    symlinkSync(join(outside, 'nested'), join(dir, 'linked'));

    expect(findRulesFile(dir)).toEqual({ kind: 'none' });
    expect(applyBuildStamp(dir, A).kind).toBe('skipped');
    expect(readBuildStamp(JSON.parse(readFileSync(join(outside, 'nested', 'rules.json'), 'utf8')))).toBeNull();
  });

  it('does not follow a symlinked file, even one named like ours', () => {
    const outside = mkdtempSync(join(tmpdir(), 'ps-outside-'));
    dirs.push(outside);
    writeFileSync(join(outside, 'real.json'), bundleText());

    const dir = project({ 'package.json': '{}' });
    symlinkSync(join(outside, 'real.json'), join(dir, 'patchstack.rules.json'));

    expect(findRulesFile(dir)).toEqual({ kind: 'none' });
    expect(readBuildStamp(JSON.parse(readFileSync(join(outside, 'real.json'), 'utf8')))).toBeNull();
  });

  it('refuses to choose when there is more than one candidate', () => {
    // Stamping a guess is worse than stamping nothing: the wrong file is invisible, and the mismatch it
    // causes later has no visible cause.
    const dir = project({
      'patchstack.rules.json': bundleText(),
      'guard.ts': guardSource('patchstack.rules.json'),
      'src/patchstack.rules.json': bundleText(),
      'src/guard.ts': guardSource('patchstack.rules.json'),
    });
    const found = findRulesFile(dir);
    expect(found.kind).toBe('ambiguous');
    expect(found.kind === 'ambiguous' && found.paths).toHaveLength(2);
  });
});

describe('writing the stamp', () => {
  it('stamps a namespaced field and leaves everything else alone', () => {
    const dir = protectedProject('patchstack.rules.json', bundleText());
    expect(applyBuildStamp(dir, A)).toEqual({ kind: 'stamped', file: 'patchstack.rules.json', id: A });

    const after = JSON.parse(read(dir, 'patchstack.rules.json'));
    expect(readBuildStamp(after)).toBe(A);
    // The bundle, and the comment that was already beside it, are untouched.
    expect(after.firewall).toEqual(BUNDLE.firewall);
    expect(after._comment).toBe(BUNDLE._comment);
    expect(after.whitelist_keys).toEqual({});
  });

  it('carries over the indentation style and the trailing newline — and only those', () => {
    // The honest limit. The object is re-serialised, so indentation style and trailing-newline presence
    // survive and other formatting choices do not: CRLF endings and number spelling are normalised to
    // what `JSON.stringify` emits. Preserving a document byte-for-byte would mean patching the metadata
    // surgically instead of round-tripping it.
    const dir = protectedProject('patchstack.rules.json', bundleText());
    applyBuildStamp(dir, A);
    const text = read(dir, 'patchstack.rules.json');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "firewall"'); // two-space indent, as it was
  });

  it('normalises CRLF, which is the documented limit rather than a preserved property', () => {
    const dir = protectedProject('patchstack.rules.json', bundleText().replace(/\n/g, CRLF));
    applyBuildStamp(dir, A);
    expect(read(dir, 'patchstack.rules.json')).not.toContain(CRLF);
  });

  it('preserves tabs, and the absence of a trailing newline', () => {
    const dir = protectedProject('patchstack.rules.json', JSON.stringify(BUNDLE, null, '\t'));
    applyBuildStamp(dir, A);
    const text = read(dir, 'patchstack.rules.json');
    expect(text).toContain('\n\t"firewall"');
    expect(text.endsWith('\n')).toBe(false);
  });

  it('rewrites nothing when the identity has not changed', () => {
    // A committed file must not churn on every local build.
    const dir = protectedProject('patchstack.rules.json', bundleText());
    applyBuildStamp(dir, A);
    const first = read(dir, 'patchstack.rules.json');

    expect(applyBuildStamp(dir, A)).toEqual({ kind: 'unchanged', file: 'patchstack.rules.json' });
    expect(read(dir, 'patchstack.rules.json')).toBe(first);
  });

  it('replaces a previous identity with this build’s', () => {
    const dir = protectedProject('patchstack.rules.json', bundleText({ _patchstack: { build_id: A } }));
    expect(applyBuildStamp(dir, B)).toMatchObject({ kind: 'stamped', id: B });
    expect(readBuildStamp(JSON.parse(read(dir, 'patchstack.rules.json')))).toBe(B);
  });

  it('REMOVES a previous stamp when this build has no identity', () => {
    // A build without a new map must not retain an identity for coordinates it did not produce.
    const dir = protectedProject('patchstack.rules.json', bundleText({ _patchstack: { build_id: A } }));
    expect(applyBuildStamp(dir, null)).toEqual({ kind: 'cleared', file: 'patchstack.rules.json' });

    const after = JSON.parse(read(dir, 'patchstack.rules.json'));
    expect(readBuildStamp(after)).toBeNull();
    expect('_patchstack' in after, 'an empty namespace is removed rather than left behind').toBe(false);
    expect(after.firewall).toEqual(BUNDLE.firewall);
  });

  it('keeps other reserved fields when it clears the identity', () => {
    const dir = protectedProject(
      'patchstack.rules.json',
      bundleText({ _patchstack: { build_id: A, something_else: 1 } }),
    );
    applyBuildStamp(dir, null);
    const after = JSON.parse(read(dir, 'patchstack.rules.json'));
    expect(after._patchstack).toEqual({ something_else: 1 });
  });

  it('clears a malformed stamp, which reads as no identity but is still there', () => {
    // Clearing is based on raw presence: a malformed value is still a stale claim in the artifact.
    const dir = protectedProject('patchstack.rules.json', bundleText({ _patchstack: { build_id: 'deadbee' } }));
    expect(applyBuildStamp(dir, null)).toEqual({ kind: 'cleared', file: 'patchstack.rules.json' });

    const after = JSON.parse(read(dir, 'patchstack.rules.json'));
    expect(hasRawBuildStamp(after)).toBe(false);
    expect('_patchstack' in after).toBe(false);
  });

  it('replaces a malformed stamp with a real one', () => {
    const dir = protectedProject('patchstack.rules.json', bundleText({ _patchstack: { build_id: 'deadbee' } }));
    expect(applyBuildStamp(dir, A)).toMatchObject({ kind: 'stamped', id: A });
    expect(readBuildStamp(JSON.parse(read(dir, 'patchstack.rules.json')))).toBe(A);
  });

  it('leaves no temporary file behind', () => {
    // The write goes to a sibling and is renamed over the destination, so a failure part-way cannot
    // leave the project's committed bundle truncated. Nothing of that should survive a success.
    const dir = protectedProject('patchstack.rules.json', bundleText());
    applyBuildStamp(dir, A);
    expect(readdirSync(dir).filter((n) => n.includes('tmp'))).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(['guard.ts', 'patchstack.rules.json']);
  });

  it.skipIf(process.platform === 'win32')('preserves the file mode across the atomic replacement', () => {
    const dir = protectedProject('patchstack.rules.json', bundleText());
    const path = join(dir, 'patchstack.rules.json');
    chmodSync(path, 0o600);

    applyBuildStamp(dir, A);

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('reports unavailable and changes nothing when there is no identity and no stamp', () => {
    const dir = protectedProject('patchstack.rules.json', bundleText());
    const before = read(dir, 'patchstack.rules.json');
    expect(applyBuildStamp(dir, null)).toEqual({ kind: 'unchanged', file: 'patchstack.rules.json' });
    expect(read(dir, 'patchstack.rules.json')).toBe(before);
  });

  it('leaves a corrupt file exactly as it is', () => {
    // A corrupt guard bundle is reported and retained byte-for-byte; stamping must not replace policy.
    const broken = '{ "firewall": [ truncated';
    const dir = protectedProject('patchstack.rules.json', broken);
    const outcome = applyBuildStamp(dir, A);
    expect(outcome.kind).toBe('skipped');
    expect(outcome.kind === 'skipped' && outcome.reason).toMatch(/not valid JSON/);
    expect(read(dir, 'patchstack.rules.json')).toBe(broken);
  });

  it('creates nothing for a project with no guard', () => {
    const dir = project({ 'package.json': '{}' });
    const outcome = applyBuildStamp(dir, A);
    expect(outcome.kind).toBe('skipped');
    expect(outcome.kind === 'skipped' && outcome.reason).toMatch(/no guard rules file/);
    expect(findRulesFile(dir)).toEqual({ kind: 'none' });
  });

  it('writes nothing when more than one candidate exists', () => {
    const dir = project({
      'patchstack.rules.json': bundleText(),
      'guard.ts': guardSource('patchstack.rules.json'),
      'src/patchstack.rules.json': bundleText(),
      'src/guard.ts': guardSource('patchstack.rules.json'),
    });
    const outcome = applyBuildStamp(dir, A);
    expect(outcome.kind).toBe('skipped');
    expect(readBuildStamp(JSON.parse(read(dir, 'patchstack.rules.json')))).toBeNull();
    expect(readBuildStamp(JSON.parse(read(dir, 'src/patchstack.rules.json')))).toBeNull();
  });
});

describe('when a build may write to the project', () => {
  it('is a pre-bundle build lifecycle, and nothing else', () => {
    expect(isPreBundleBuildHook({ npm_lifecycle_event: 'prebuild' })).toBe(true);
    expect(
      isPreBundleBuildHook({
        npm_lifecycle_event: 'build',
        npm_lifecycle_script: 'patchstack-connect scan && vite build && patchstack-connect mark-build',
      }),
    ).toBe(true);
    expect(
      isPreBundleBuildHook({
        npm_lifecycle_event: 'build',
        npm_lifecycle_script: 'vite build && patchstack-connect scan',
      }),
    ).toBe(false);
    expect(isPreBundleBuildHook({ npm_lifecycle_event: 'build' })).toBe(false);
    // An install is not a build; `postbuild` is a build the bundler has already finished, so a value
    // written there could never reach the artifact; and a developer running `scan` by hand has not
    // asked for a committed file to change.
    for (const event of ['postinstall', 'preinstall', 'install', 'prepare', 'postbuild', 'npx', 'test', '']) {
      expect(isPreBundleBuildHook({ npm_lifecycle_event: event }), event).toBe(false);
    }
    expect(isPreBundleBuildHook({})).toBe(false);
  });
});
