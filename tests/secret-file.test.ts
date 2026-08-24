import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, statSync, chmodSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistApiKey, secretFileIgnored, SECRET_CONFIG_FILENAME } from '../src/config.js';

/**
 * Whether the credential file is really ignored, and whether we say so only when it is.
 *
 * The whole reason the credential moved out of the committed config is that a credential committed once is
 * in the history whether or not the file is removed afterwards. So the assurance printed after writing it
 * is load-bearing: if it can be wrong, somebody stops checking, which is exactly the outcome the split was
 * meant to prevent.
 */
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(join(dir, '.gitignore'), 0o644);
    } catch {
      /* no such file, or no POSIX modes here */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function project(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'ps-secret-'));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);

  return dir;
}

const KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6-991';

describe('writing the credential file', () => {
  it('creates the ignore entry and reports it', async () => {
    const cwd = project();

    const result = await persistApiKey(cwd, KEY);

    expect(result.ignored).toBe(true);
    expect(readFileSync(join(cwd, '.gitignore'), 'utf8')).toContain(SECRET_CONFIG_FILENAME);
  });

  it('reports failure when the ignore file cannot be written', async () => {
    // The reported case: the write error was swallowed and the caller said "added to .gitignore" anyway.
    const cwd = project({ '.gitignore': 'node_modules\n' });
    chmodSync(join(cwd, '.gitignore'), 0o444);

    const result = await persistApiKey(cwd, KEY);

    // The credential is still written — refusing to save it would be worse — but the claim is not made.
    expect(readFileSync(result.path, 'utf8')).toContain(KEY);
    expect(result.ignored).toBe(false);
    expect(result.reason).toMatch(/gitignore/i);
  });

  it('repairs an entry that a later line un-ignores', async () => {
    // Last match wins, as git resolves it. Reading the negated entry as coverage meant leaving the file
    // committable while saying it was ignored; seeing it for what it is means the entry gets appended
    // below the negation, where it takes effect.
    const cwd = project({
      '.gitignore': `node_modules\n${SECRET_CONFIG_FILENAME}\n!${SECRET_CONFIG_FILENAME}\n`,
    });

    const result = await persistApiKey(cwd, KEY);

    expect(result.ignored).toBe(true);
    const lines = readFileSync(join(cwd, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
    expect(lines.lastIndexOf(SECRET_CONFIG_FILENAME)).toBeGreaterThan(lines.lastIndexOf(`!${SECRET_CONFIG_FILENAME}`));
  });

  it('accepts an entry the project already had', async () => {
    // The control. Without it "verified" could be satisfied by never believing an existing entry, which
    // would append a duplicate to every project that had already done the right thing.
    const cwd = project({ '.gitignore': `node_modules\n/${SECRET_CONFIG_FILENAME}\n` });

    const result = await persistApiKey(cwd, KEY);

    expect(result.ignored).toBe(true);
    const lines = readFileSync(join(cwd, '.gitignore'), 'utf8').split('\n').filter((l) => l.trim() !== '');
    expect(lines.filter((l) => l.includes(SECRET_CONFIG_FILENAME))).toHaveLength(1);
  });

  it('is readable only by its owner', async () => {
    const cwd = project();

    const result = await persistApiKey(cwd, KEY);

    // Windows has no POSIX mode; asserted where there is one.
    if (process.platform !== 'win32') {
      expect(statSync(result.path).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps owner-only permissions when an older file is rotated', async () => {
    const cwd = project();
    await persistApiKey(cwd, KEY);
    if (process.platform === 'win32') return;
    chmodSync(join(cwd, SECRET_CONFIG_FILENAME), 0o644);

    const result = await persistApiKey(cwd, 'b1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6-992');

    expect(statSync(result.path).mode & 0o777).toBe(0o600);
  });
});

describe('checking the ignore state on its own', () => {
  it('says why there is no coverage', async () => {
    expect(await secretFileIgnored(project())).toEqual({
      ignored: false,
      reason: 'this project has no .gitignore',
    });
  });

  it('does not read a negated entry as coverage', async () => {
    // The state the repair above starts from, asked directly: an entry followed by a negation is not
    // coverage, and reporting it as coverage is what would leave the credential committable.
    const cwd = project({
      '.gitignore': `${SECRET_CONFIG_FILENAME}\n!${SECRET_CONFIG_FILENAME}\n`,
    });

    expect((await secretFileIgnored(cwd)).ignored).toBe(false);
  });

  it('agrees with the writer', async () => {
    const cwd = project();
    await persistApiKey(cwd, KEY);

    expect((await secretFileIgnored(cwd)).ignored).toBe(true);
  });
});
