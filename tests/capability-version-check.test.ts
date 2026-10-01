import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function check(before: object, head: object) {
  const directory = mkdtempSync(join(tmpdir(), 'capability-version-'));
  directories.push(directory);
  mkdirSync(join(directory, 'scripts'));
  copyFileSync(join(root, 'scripts/check-capability-version.mjs'), join(directory, 'scripts/check-capability-version.mjs'));
  writeFileSync(join(directory, 'capabilities.json'), JSON.stringify(before));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, stdio: 'pipe' });
  git('init', '-q');
  git('add', 'capabilities.json');
  git('-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture');
  writeFileSync(join(directory, 'capabilities.json'), JSON.stringify(head));
  return spawnSync(process.execPath, ['scripts/check-capability-version.mjs', '--base', 'HEAD'], {
    cwd: directory, encoding: 'utf8',
  });
}

describe('capability version comparison', () => {
  const member = { package: 'example-client', methods: ['query'], context: { kind: 'sql' } };
  const base = { version: '1.3.0', packageSinkModels: [member], inputSources: ['query'] };

  it('accepts the unchanged real manifest parsed independently', () => {
    const text = readFileSync(join(root, 'capabilities.json'), 'utf8');
    const result = check(JSON.parse(text), JSON.parse(text));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('no vocabulary change');
  });

  it('ignores object key order and top-level vocabulary order', () => {
    const result = check(base, { ...base, packageSinkModels: [{ context: { kind: 'sql' }, methods: ['query'], package: 'example-client' }] });
    expect(result.status, result.stderr).toBe(0);
    expect(check({ ...base, inputSources: ['query', 'body'] }, { ...base, inputSources: ['body', 'query'] }).status).toBe(0);
  });

  it('requires a minor bump for added records', () => {
    const head = { ...base, packageSinkModels: [member, { ...member, package: 'another-client' }] };
    expect(check(base, head).status).toBe(1);
    expect(check(base, { ...head, version: '1.4.0' }).status).toBe(0);
  });

  it.each([
    [],
    [{ ...member, context: { kind: 'other' } }],
    [{ ...member, methods: [] }],
    [{ package: 'example-client', methods: ['query'] }],
  ])('requires a major bump for removed or redefined records: %j', (...members) => {
    const head = { ...base, packageSinkModels: members };
    const result = check(base, { ...head, version: '1.4.0' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('major bump');
    expect(result.stderr).not.toContain('[object Object]');
    expect(check(base, { ...head, version: '2.0.0' }).status).toBe(0);
  });

  it('still detects primitive removals and scalar changes', () => {
    expect(check(base, { ...base, inputSources: [] }).status).toBe(1);
    expect(check({ version: '1.0.0', mode: 'old' }, { version: '1.1.0', mode: 'new' }).status).toBe(1);
  });
});
