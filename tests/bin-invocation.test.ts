import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The published `bin` has to actually run, invoked the way npm invokes it.
 *
 * npm installs a bin as a SYMLINK into `node_modules/.bin`, so `process.argv[1]` is the link while
 * `import.meta.url` is the real file. Anything in the entry point that compares the two — an
 * is-this-the-program guard, for instance — is satisfied when run directly and not when installed, and
 * the failure is silent: no output, exit 0. A build that typechecks and answers `node dist/cli.js` can
 * still ship a binary that does nothing.
 *
 * So this drives `dist/cli.js` through a symlink and requires meaningful output, not just a zero exit.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'dist', 'cli.js');

// `dist/` is gitignored and built on publish, so a plain checkout has nothing to drive and skipping is
// the honest answer there. In CI it is the opposite: the run that is SUPPOSED to cover the shipped bin
// must not quietly cover nothing, and `npm test` runs before `npm run build`, so a step that forgot to
// build would skip and look green. `PS_REQUIRE_BIN_CHECK` is set by the post-build CI step and turns the
// skip into a failure.
const built = existsSync(bin);
const required = process.env.PS_REQUIRE_BIN_CHECK === '1';

if (required && !built) {
  throw new Error(
    `PS_REQUIRE_BIN_CHECK=1 but ${bin} does not exist — this check is supposed to run after the build. ` +
      'Refusing to skip, because a skipped bin check reads exactly like a passing one.',
  );
}

describe.skipIf(!built)('the packaged bin, invoked as npm invokes it', () => {
  function runThroughSymlink(args: string[]): { stdout: string; status: number } {
    const dir = mkdtempSync(path.join(tmpdir(), 'ps-bin-'));
    try {
      const link = path.join(dir, 'patchstack-connect');
      symlinkSync(bin, link);
      const stdout = execFileSync('node', [link, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { stdout, status: 0 };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('prints its help through a symlinked path', () => {
    const { stdout } = runThroughSymlink(['--help']);

    // Exit 0 alone would pass for a binary that ran nothing at all, which is the failure this exists for.
    expect(stdout.length).toBeGreaterThan(200);
    expect(stdout).toContain('@patchstack/connect');
    expect(stdout).toContain('Usage:');
  });

  it('runs a real command through a symlinked path', () => {
    // `--help` could conceivably be handled before whatever gates the rest, so exercise a command that
    // does work and emits a document.
    const project = mkdtempSync(path.join(tmpdir(), 'ps-bin-proj-'));
    try {
      const { stdout } = runThroughSymlink(['map', '--dir', project]);
      const map = JSON.parse(stdout);
      expect(map.version).toBe(3);
      expect(Array.isArray(map.endpoints)).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('names the same bin this test drives', () => {
    // If the bin path moves, the check above would silently stop covering the shipped entry point.
    const pkg = JSON.parse(execFileSync('node', ['-p', 'JSON.stringify(require("./package.json").bin)'], {
      cwd: root,
      encoding: 'utf8',
    }));
    expect(pkg['patchstack-connect']).toBe('./dist/cli.js');
  });
});
