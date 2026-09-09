import { describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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

  /**
   * `--dry-run` is how someone finds out what a scan would send before sending it, so a field the preview
   * omits is a field nobody gets to object to. The request body is built once and used for both, and this
   * drives the real bin to prove the preview is that body — including the address and name, which are the
   * two fields a reader is most likely to want to check.
   */
  it('previews every field a real post would send', () => {
    const project = mkdtempSync(path.join(tmpdir(), 'ps-bin-dry-'));
    try {
      writeFileSync(
        path.join(project, 'package.json'),
        JSON.stringify({ name: 'example-app', version: '1.0.0' }),
      );
      copyFileSync(
        path.join(root, 'tests', 'fixtures', 'package-lock-v3.json'),
        path.join(project, 'package-lock.json'),
      );
      writeFileSync(path.join(project, 'index.html'), '<title>Recipe Box</title>');
      writeFileSync(
        path.join(project, '.patchstackrc.json'),
        JSON.stringify({
          siteUuid: '11111111-1111-4111-8111-111111111111',
          url: 'https://recipes.example.com',
        }),
      );

      const stdout = execFileSync('node', [bin, 'scan', '--dry-run'], {
        cwd: project,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
        encoding: 'utf8',
      });

      // Said in prose before the preview, so it is noticed here rather than in the dashboard.
      expect(stdout).toContain(`Reporting this app's address as https://recipes.example.com.`);
      expect(stdout).toContain(`Reporting this app's name as "Recipe Box".`);

      const preview = stdout.slice(stdout.indexOf('Payload preview:'));
      expect(preview).toContain('"url": "https://recipes.example.com"');
      expect(preview).toContain('"name": "Recipe Box"');
      expect(preview).toContain('"environment": "production"');
      expect(preview).toContain('"packages"');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  /**
   * A report the server refuses must not fail the build `scan` is hooked into, and must fail a direct run.
   *
   * Driven through the real bin against a local server that refuses everything, because the decision sits
   * between the network failure and the process exit code, and only the process can show both.
   */
  describe('a report the server refuses', () => {
    async function refusingServer(): Promise<{ endpoint: string; close: () => Promise<void> }> {
      const server = createServer((_req, res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"unauthorized"}');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;

      return {
        endpoint: `http://127.0.0.1:${port}/monitor/pulse/manifest`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      };
    }

    // An existing site with no credential anywhere: the state a deploy is in when the credential file
    // stayed behind on the developer's machine.
    function projectWithSite(): string {
      const dir = mkdtempSync(path.join(tmpdir(), 'ps-bin-hook-'));
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'example-app', version: '1.0.0', dependencies: { axios: '^1.6.0', lodash: '^4.17.21' } }),
      );
      copyFileSync(path.join(root, 'tests', 'fixtures', 'package-lock-v3.json'), path.join(dir, 'package-lock.json'));
      writeFileSync(path.join(dir, '.patchstackrc.json'), JSON.stringify({ siteUuid: '11111111-1111-4111-8111-111111111111' }));

      return dir;
    }

    // The environment is built from scratch rather than inherited: the parent may itself be running under
    // a package manager, and the lifecycle name it exported is the very thing under test. Asynchronous
    // because the refusing server lives on this thread's event loop, and a blocking spawn would starve it.
    async function runScan(
      cwd: string,
      endpoint: string,
      lifecycleEvent?: string,
    ): Promise<{ status: number; stderr: string }> {
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PATCHSTACK_ENDPOINT: endpoint,
        PATCHSTACK_TIMEOUT_MS: '5000',
      };
      if (lifecycleEvent !== undefined) env.npm_lifecycle_event = lifecycleEvent;

      try {
        const { stderr } = await promisify(execFile)('node', [bin, 'scan'], { cwd, env, encoding: 'utf8' });

        return { status: 0, stderr };
      } catch (err) {
        const failed = err as { code?: unknown; stderr?: unknown };

        return {
          status: typeof failed.code === 'number' ? failed.code : -1,
          stderr: typeof failed.stderr === 'string' ? failed.stderr : '',
        };
      }
    }

    it('exits 0 from a build hook and says what was not reported', async () => {
      const server = await refusingServer();
      const dir = projectWithSite();
      try {
        const result = await runScan(dir, server.endpoint, 'build');

        expect(result.status).toBe(0);
        expect(result.stderr).toContain('manifest not reported');
        expect(result.stderr).toContain('PATCHSTACK_API_KEY');
      } finally {
        await server.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('exits 1 for the same refusal when run directly', async () => {
      const server = await refusingServer();
      const dir = projectWithSite();
      try {
        const result = await runScan(dir, server.endpoint);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Error (UNAUTHORIZED)');
        expect(result.stderr).not.toContain('continuing the build');
      } finally {
        await server.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
