import { describe, expect, it } from 'vitest';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readBuildStamp } from '../src/build-id.js';

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

  it.each([
    ['protect','--check','--runtime-url'],
    ['setup','--runtime-url='],
    ['scan','--runtime-url','https://preview.example.test'],
    ['protect','--runtime-url','https://preview.example.test'],
    ['protect','--check','--runtime','--runtime-url','https://preview.example.test'],
    ['scan','--dev-sync'],
  ])('refuses invalid activation/development flag combinations before doing work: %s', (...args) => {
    const result=spawnSync(process.execPath,[bin,...args],{encoding:'utf8'});
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/--runtime-url|--dev-sync/);
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

  it('leaves a standalone HTML page unchanged and explains the widget-only path', () => {
    const project = mkdtempSync(path.join(tmpdir(), 'ps-bin-html-'));
    const html = '<!doctype html><html><body>Example</body></html>\n';
    try {
      writeFileSync(path.join(project, 'index.html'), html);
      const result = spawnSync(process.execPath, [bin, 'setup'], {
        cwd: project,
        encoding: 'utf8',
        env: { ...process.env, PATCHSTACK_ENDPOINT: 'http://127.0.0.1:1/monitor/pulse/manifest' },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('standalone HTML site');
      expect(result.stderr).toContain('widget-only instructions');
      expect(readdirSync(project)).toEqual(['index.html']);
      expect(readFileSync(path.join(project, 'index.html'), 'utf8')).toBe(html);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
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
      expect(stdout).toContain('Reporting app address: https://recipes.example.com');
      expect(stdout).toContain('Reporting app name: "Recipe Box"');

      const preview = stdout.slice(stdout.indexOf('Payload preview:'));
      expect(preview).toContain('"url": "https://recipes.example.com"');
      expect(preview).toContain('"name": "Recipe Box"');
      expect(stdout).toContain('Environment: local (this machine)');
      expect(preview).toContain('"environment": "local"');
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
        expect(result.stderr).toContain('could not send the package list');
        expect(result.stderr).toContain('PATCHSTACK_API_KEY');
      } finally {
        await server.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('clears a previous map identity before a prebuild continues', async () => {
      const server = await refusingServer();
      const dir = projectWithSite();
      const guardDir = path.join(dir, 'src', 'patchstack');
      mkdirSync(guardDir, { recursive: true });
      writeFileSync(
        path.join(guardDir, 'guard.ts'),
        'import { createProtection } from "@patchstack/connect/protect";\nimport rules from "./rules.json";\nvoid createProtection({ rules });\n',
      );
      writeFileSync(
        path.join(guardDir, 'rules.json'),
        JSON.stringify({
          _patchstack: { build_id: 'a'.repeat(64) },
          firewall: [],
          whitelists: [],
          whitelist_keys: {},
        }),
      );
      try {
        const result = await runScan(dir, server.endpoint, 'prebuild');
        const rules = JSON.parse(readFileSync(path.join(guardDir, 'rules.json'), 'utf8'));

        expect(result.status).toBe(0);
        expect(readBuildStamp(rules)).toBeNull();
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
        expect(result.stderr).toContain('(UNAUTHORIZED)');
        expect(result.stderr).not.toContain('continuing the build');
      } finally {
        await server.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  /** A direct scan ends on the same four-step checklist as `guide` and `setup`, filled in from this report. */
  describe('the progress checklist a scan ends on', () => {
    const SITE = '22222222-2222-4222-8222-222222222222';

    async function acceptingServer(
      claim?: Record<string, unknown>,
    ): Promise<{ endpoint: string; close: () => Promise<void> }> {
      const server = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ uuid: SITE, stored: true, manifest_id: 7, checksum: 'abc', ...(claim ? { claim } : {}) }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;

      return {
        endpoint: `http://127.0.0.1:${port}/monitor/pulse/manifest`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      };
    }

    function freshProject(): string {
      const dir = mkdtempSync(path.join(tmpdir(), 'ps-bin-progress-'));
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'example-app', version: '1.0.0', dependencies: { '@patchstack/connect': '^0.5.0', axios: '^1.6.0' } }),
      );
      copyFileSync(path.join(root, 'tests', 'fixtures', 'package-lock-v3.json'), path.join(dir, 'package-lock.json'));
      writeFileSync(path.join(dir, 'index.html'), '<html><body></body></html>');
      return dir;
    }

    async function scan(cwd: string, endpoint: string, extra: NodeJS.ProcessEnv = {}, args: string[] = []): Promise<string> {
      return run(cwd, endpoint, ['scan', ...args], extra);
    }

    async function run(cwd: string, endpoint: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<string> {
      const { stdout } = await promisify(execFile)('node', [bin, ...args], {
        cwd,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, PATCHSTACK_ENDPOINT: endpoint, ...extra },
        encoding: 'utf8',
      });
      return stdout;
    }

    it('marks the local sync done and names connecting as the one next step', async () => {
      const server = await acceptingServer();
      const dir = freshProject();
      try {
        const stdout = await scan(dir, server.endpoint);

        expect(stdout).toContain(' ✔ Install the Patchstack connector');
        expect(stdout).toContain(' ✘ Connect project to Patchstack account');
        expect(stdout).toContain(' ✔ Sync and monitor in local environment');
        expect(stdout).toContain(' ✘ Deploy project to protect live app');
        expect(stdout.match(/Next: /g)).toHaveLength(1);
        expect(stdout).toContain('Next: connect this project to your Patchstack account');
        expect(stdout).toContain(`/monitor/claim?site=${SITE}`);
        expect(stdout).toContain(' ✔ Added the Patchstack widget to index.html');
        expect(stdout).toContain('anyone who opens your app can connect it to their own account');
        expect(stdout).not.toMatch(/report a vulnerability/i);
      } finally {
        await server.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('reports a production scan without ticking the deploy the dashboard has not seen', async () => {
      const server = await acceptingServer();
      const dir = freshProject();
      try {
        const stdout = await scan(dir, server.endpoint, { PATCHSTACK_ENVIRONMENT: 'production' });

        expect(stdout).toContain(' ✔ Sync and monitor in production environment');
        expect(stdout).toContain(' ✘ Deploy project to protect live app');
        expect(stdout).toContain('Patchstack ticks this once it sees the live site.');
      } finally {
        await server.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('keeps scan reports and built HTML consistent as a project moves between deployment tiers', async () => {
      const bodies: Record<string, unknown>[] = [];
      const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk.toString(); });
        req.on('end', () => {
          // The ownership lookup a scan makes after a stored manifest; it carries no body.
          if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ state: 'claimable' }));
            return;
          }
          bodies.push(JSON.parse(raw) as Record<string, unknown>);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ uuid: SITE, stored: true, checksum: 'abc' }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      const endpoint = `http://127.0.0.1:${port}/monitor/pulse/manifest`;
      const dir = freshProject();
      mkdirSync(path.join(dir, 'dist'));
      const page = path.join(dir, 'dist', 'index.html');
      writeFileSync(page, '<html><head></head><body></body></html>');
      const cases: { env: NodeJS.ProcessEnv; tier: string; platform?: string }[] = [
        { env: {}, tier: 'local' },
        { env: { VERCEL_TARGET_ENV: 'production' }, tier: 'production', platform: 'vercel' },
        { env: { VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'staging' }, tier: 'sandbox', platform: 'vercel' },
        { env: { NETLIFY: 'true', CONTEXT: 'production' }, tier: 'production', platform: 'netlify' },
        { env: { NETLIFY: 'true', CONTEXT: 'production', NETLIFY_DEV: 'true' }, tier: 'local' },
        { env: { NETLIFY_PREVIEW_SERVER: 'true' }, tier: 'sandbox', platform: 'netlify' },
        { env: { PATCHSTACK_ENVIRONMENT: 'production' }, tier: 'production' },
        { env: { PATCHSTACK_ENVIRONMENT: 'sandbox' }, tier: 'sandbox' },
        { env: { VERCEL: '1', GITHUB_ACTIONS: 'true', GITHUB_REF_NAME: 'main' }, tier: 'local' },
      ];
      try {
        for (const { env, tier, platform } of cases) {
          bodies.length = 0;
          await scan(dir, endpoint, env);
          await run(dir, endpoint, ['mark-build'], env);
          expect(bodies).toHaveLength(2);
          expect(bodies[0].environment).toBe(tier);
          expect(bodies[1].environment).toBe(tier);
          expect(bodies[1].marker).toBe(tier === 'production' ? 'stamped' : 'withheld');
          expect(readFileSync(page, 'utf8').includes('__PATCHSTACK_PROD__')).toBe(tier === 'production');
          if (platform) expect(bodies[0].hosting).toMatchObject({ platform });
          expect(JSON.parse(readFileSync(path.join(dir, '.patchstackrc.json'), 'utf8'))).not.toHaveProperty('environment');
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);

    it('marks the site connected when the claim token connected it', async () => {
      const server = await acceptingServer({ state: 'claimed' });
      const dir = freshProject();
      try {
        const stdout = await scan(dir, server.endpoint, {}, ['--claim-token', 'tok-123']);

        expect(stdout).toContain(' ✔ Connect project to Patchstack account');
        expect(stdout).toContain('Next: deploy your project to protect the live app');
        expect(stdout).not.toContain('/monitor/claim?site=');
      } finally {
        await server.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('marks the site connected once Patchstack says it has an owner, and stops asking after that', async () => {
      const lookups: string[] = [];
      const server = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          if (req.method === 'GET') {
            lookups.push(req.url ?? '');
            res.end(JSON.stringify({ state: 'owned-by-other' }));
            return;
          }
          res.end(JSON.stringify({ uuid: SITE, stored: true, manifest_id: 7, checksum: 'abc' }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      const endpoint = `http://127.0.0.1:${port}/monitor/pulse/manifest`;
      const dir = freshProject();
      try {
        const first = await scan(dir, endpoint);

        expect(first).toContain(' ✔ Connect project to Patchstack account');
        expect(first).not.toContain('/monitor/claim?site=');
        expect(lookups).toEqual([`/monitor/claim/preview?site=${SITE}`]);
        const saved = JSON.parse(readFileSync(path.join(dir, '.patchstackrc.json'), 'utf8')) as Record<string, unknown>;
        expect(saved).toMatchObject({ siteUuid: SITE, claimed: true });
        expect(saved).not.toHaveProperty('claimUrl');

        const second = await scan(dir, endpoint);
        expect(second).toContain(' ✔ Connect project to Patchstack account');
        expect(lookups).toHaveLength(1);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
      }
    });

    /**
     * The default output is read by people who do not write code. The technical words are still there for
     * whoever needs them, behind --verbose.
     */
    describe('plain by default, technical with --verbose', () => {
      const BANNED = [
        /manifest/i,
        /checksum/i,
        /uuid/i,
        /endpoint/i,
        /lockfile/i,
        /provision/i,
        /\bguard\b/i,
        /adapter/i,
        /\bseam\b/i,
        /scaffold/i,
        /marker/i,
        /npm ecosystem/i,
        /environment_source/i,
        /Reporting app name/,
        /Environment: /,
        /patchstack protect:/,
        /Tell the user/,
        /jargon/i,
      ];

      function expectPlain(output: string): void {
        for (const word of BANNED) expect(output, String(word)).not.toMatch(word);
      }

      it('keeps scan, setup and guide free of technical words', async () => {
        const server = await acceptingServer();
        const dir = freshProject();
        try {
          const fresh = await run(dir, server.endpoint, ['guide']);
          expectPlain(fresh.slice(0, fresh.indexOf('———— Full reference guide')));
          expectPlain(await scan(dir, server.endpoint));
          const setup = await run(dir, server.endpoint, ['setup']);
          expect(setup).toContain('Patchstack setup');
          expect(setup).toContain('Done\n');
          expect(setup).not.toContain('1/3');
          expectPlain(setup);
          const guide = await run(dir, server.endpoint, ['guide']);
          expectPlain(guide.slice(0, guide.indexOf('———— Full reference guide')));
          expectPlain(await scan(dir, server.endpoint, { PATCHSTACK_ENVIRONMENT: 'production' }));
        } finally {
          await server.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it('brings the detail back with --verbose', async () => {
        const server = await acceptingServer();
        const dir = freshProject();
        try {
          const scanned = await scan(dir, server.endpoint, {}, ['--verbose']);
          expect(scanned).toContain('Environment: local');
          expect(scanned).toContain('Endpoint override:');
          expect(scanned).toContain(`Created site ${SITE}`);
          expect(scanned).toContain('Stored manifest #7 (checksum abc)');

          const setup = await run(dir, server.endpoint, ['setup', '--verbose']);
          expect(setup).toContain('patchstack protect:');
          expect(setup).toContain('Build hooks:');

          const guide = await run(dir, server.endpoint, ['guide', '--verbose']);
          expect(guide).toContain(`Site UUID: ${SITE}`);
          expect(guide).toContain('Endpoint override:');
        } finally {
          await server.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it('keeps a build-hook scan to two lines', async () => {
        const server = await acceptingServer();
        const dir = freshProject();
        try {
          const stdout = await scan(dir, server.endpoint, { npm_lifecycle_event: 'prebuild', npm_lifecycle_script: 'patchstack-connect scan' });
          const lines = stdout.trim().split('\n');

          expect(lines).toHaveLength(2);
          expect(lines[0]).toMatch(/^Patchstack: checked \d+ packages?/);
          expect(lines[1]).toMatch(/^Patchstack next step: connect this project to your Patchstack account\. Open /);
          expectPlain(stdout.replace(/Open \S+/, ''));
        } finally {
          await server.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it('says a network failure plainly, with the code for support', async () => {
        const dir = freshProject();
        try {
          const result = spawnSync(process.execPath, [bin, 'scan'], {
            cwd: dir,
            encoding: 'utf8',
            env: { PATH: process.env.PATH, HOME: process.env.HOME, PATCHSTACK_ENDPOINT: 'http://127.0.0.1:1/monitor/pulse/manifest' },
          });

          expect(result.status).toBe(1);
          expect(result.stderr.trim()).toBe(
            'Could not reach Patchstack. Check your internet connection and try again. (NETWORK_ERROR)',
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });
  });
});
