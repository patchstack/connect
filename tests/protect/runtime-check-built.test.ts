// `protect --check --runtime` driven the way a consumer drives it: the BUILT CLI, in a project whose
// guard came from the built scaffolder and whose seam is the built `@patchstack/connect/protect`.
//
// The source tests cover the probe, the launch contract and the seam. None of them can see the questions
// this answers: is the listener reporter where the built CLI looks for it, does the scaffolded guard's
// seam answer through the published module, and does the command exit with the code its documentation
// claims. A rename or a missed copy step leaves every source test green and this check is what fails.
//
// The middle case is the reason the whole feature exists. Its app imports the guard, calls it, and passes
// the structural check — while the server that actually listens has no guard on it. `--check` says wired;
// only a request can say otherwise.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Every case here starts a real process, so every case declares a timeout that fits the run it performs.
// The default five seconds is shorter than the runs below allow, and a test vitest abandons mid-run is
// not just a failure: the awaited promise is dropped, its cleanup never happens, and the app it started
// is left on the machine. Long enough for a loaded CI runner, and each run bounds itself anyway.
const SLOW = { timeout: 60_000 };


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliPath = path.join(root, 'dist', 'cli.js');

// `dist/` is gitignored and built on publish, so a plain checkout has nothing to drive. In CI the
// opposite holds: the post-build step sets `PS_REQUIRE_RUNTIME_CHECK` and a skip there would read exactly
// like a pass — which is the same defect this feature exists to remove.
const built = existsSync(cliPath);
const required = process.env.PS_REQUIRE_RUNTIME_CHECK === '1';

if (required && !built) {
  throw new Error(
    `PS_REQUIRE_RUNTIME_CHECK=1 but ${cliPath} does not exist — this check runs after the build. ` +
      'Refusing to skip, because a skipped verification check reads exactly like a passing one.',
  );
}

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A project with the built package linked in, scaffolded by the built CLI. */
function scaffolded(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ps-runtime-built-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, 'node_modules', '@patchstack'), { recursive: true });
  // The repository itself: `dist/protect.js` is what the scaffolded guard imports, and what a consumer
  // would have installed.
  symlinkSync(root, path.join(dir, 'node_modules', '@patchstack', 'connect'), 'dir');
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
  execFileSync(process.execPath, [cliPath, 'protect'], { cwd: dir, stdio: 'ignore' });

  return dir;
}

const check = (cwd: string, ...flags: string[]) => {
  const result = spawnSync(process.execPath, [cliPath, 'protect', '--check', ...flags], { cwd, encoding: 'utf8' });

  return { code: result.status, out: `${result.stdout}${result.stderr}` };
};

const manifest = JSON.stringify({ name: 'app', private: true, type: 'module', scripts: { start: 'node server.js' } });

/** A wired app that records the fact it was loaded, so "did this command run it" is answerable. */
const STARTS_AND_MARKS = `import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { patchstackMiddleware } from './patchstack/guard.js';

writeFileSync(new URL('./started', import.meta.url), 'the app ran');
createServer((req, res) => {
  patchstackMiddleware(req, res, () => { res.writeHead(200); res.end('app'); });
}).listen(3000);`;

describe.skipIf(!built)('the built CLI', SLOW, () => {
  it('proves traversal for an app whose serving path holds the guard', () => {
    const dir = scaffolded({
      'package.json': manifest,
      'server.js': `import { createServer } from 'node:http';
import { patchstackMiddleware } from './patchstack/guard.js';

createServer((req, res) => {
  patchstackMiddleware(req, res, () => { res.writeHead(200); res.end('app'); });
}).listen(3000);`,
    });
    expect(check(dir).code).toBe(0); // structurally wired

    const runtime = check(dir, '--runtime');
    expect(runtime.out).toContain('runtime traversal reached the scaffolded guard seam');
    expect(runtime.out).toContain('entry: server.js (from the "start" script)');
    expect(runtime.code).toBe(0);
  });

  it('catches an app that passes the structural check and never routes a request through the guard', () => {
    const dir = scaffolded({
      'package.json': manifest,
      'server.js': `import { createServer } from 'node:http';
import { patchstackMiddleware } from './patchstack/guard.js';

// Imported, called, and on a server that never listens.
const guarded = createServer((req, res) => {
  patchstackMiddleware(req, res, () => { res.writeHead(200); res.end('guarded'); });
});

// The server that actually serves traffic, wired by nobody.
createServer((req, res) => { res.writeHead(200); res.end('unguarded'); }).listen(3000);`,
    });
    expect(check(dir).code).toBe(0); // the source says wired, and it is not

    const runtime = check(dir, '--runtime');
    expect(runtime.out).toContain('the listener answered and the guard seam did not');
    expect(runtime.code).toBe(1);
  });

  it('reports an entry it must not start as neither passed nor failed', () => {
    const dir = scaffolded({
      'package.json': JSON.stringify({ name: 'app', private: true, type: 'module', scripts: { start: 'tsx server.ts' } }),
      'server.ts': `import { createServer } from 'node:http';
import { patchstackMiddleware } from './patchstack/guard.js';

createServer((req: unknown, res: unknown) => {
  patchstackMiddleware(req, res, () => {});
}).listen(3000);`,
    });
    const runtime = check(dir, '--runtime');
    expect(runtime.out).toContain('runtime traversal could not be established');
    expect(runtime.out).toContain('This is not a failure.');
    expect(runtime.code).toBe(2);
  });

  it('does not start an app whose guard is not wired at all', () => {
    // The structural verdict comes first: there is nothing to learn from starting an app that has no
    // guard on any path, and starting one to say so would run the app for no reason.
    const dir = scaffolded({
      'package.json': manifest,
      'server.js': `import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

writeFileSync(new URL('./started', import.meta.url), 'the app ran');
createServer((req, res) => { res.writeHead(200); res.end('unguarded'); }).listen(3000);`,
    });
    const structural = check(dir);
    expect(structural.code).toBe(1);

    const runtime = check(dir, '--runtime');
    expect(runtime.code).toBe(1);
    expect(runtime.out).not.toContain('runtime traversal');
    expect(existsSync(path.join(dir, 'started'))).toBe(false);
  });

  it('does not leave the app running when the command is interrupted', async () => {
    // The app is a detached process-group leader, so a Ctrl-C that ends the CLI mid-run must explicitly
    // end that group rather than leave the app running on the machine.
    const dir = scaffolded({
      'package.json': manifest,
      'server.js': `import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { patchstackMiddleware } from './patchstack/guard.js';

const server = createServer((req, res) => {
  patchstackMiddleware(req, res, () => { res.writeHead(200); res.end('app'); });
});
server.listen(3000, () => {
  // Its own process group id: the CLI put it in one, and it is what must be gone afterwards.
  writeFileSync(new URL('./started', import.meta.url), String(process.pid));
});`,
    });

    const cli = spawn(process.execPath, [cliPath, 'protect', '--check', '--runtime'], { cwd: dir, stdio: 'ignore' });
    const pidFile = path.join(dir, 'started');
    const deadline = Date.now() + 20_000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(existsSync(pidFile), 'the app never started, so nothing was interrupted').toBe(true);
    const appPid = Number(readFileSync(pidFile, 'utf8'));

    cli.kill('SIGINT');
    await new Promise<void>((resolve) => cli.on('exit', () => resolve()));

    // Both the app and its group, polled: whoever reaps it decides when the pid disappears.
    const gone = async (pid: number) => {
      const until = Date.now() + 5_000;
      for (;;) {
        try {
          process.kill(pid, 0);
        } catch {
          return true;
        }
        if (Date.now() > until) return false;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    expect(await gone(appPid)).toBe(true);
    expect(await gone(-appPid)).toBe(true);
  });

  it('refuses --runtime without --check rather than scaffolding quietly', () => {
    const dir = scaffolded({ 'package.json': manifest, 'server.js': '' });
    const result = spawnSync(process.execPath, [cliPath, 'protect', '--runtime'], { cwd: dir, encoding: 'utf8' });
    expect(`${result.stdout}${result.stderr}`).toContain('--runtime only applies to --check');
    expect(result.status).toBe(1);
  });

  it('does not start the app for any other command', () => {
    // Same marker as above. `setup` and `guide` may fail here for want of a credential, and that is not
    // what is being asserted: whatever they do, they must not have run the application to do it.
    const dir = scaffolded({ 'package.json': manifest, 'server.js': STARTS_AND_MARKS });
    for (const command of ['setup', 'guide']) {
      // A dead endpoint: `setup` posts a manifest, and this test is about what the command runs
      // locally, not about reaching Patchstack. It fails fast, which is fine — the assertion is that
      // whatever it did, it did not start the application.
      spawnSync(process.execPath, [cliPath, command, '--endpoint', 'http://127.0.0.1:1'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(existsSync(path.join(dir, 'started')), `\`${command}\` started the application`).toBe(false);
    }
  });

  it('does not start the app for a default check', () => {
    // The app writes a file the moment it is loaded. A default `--check` that ever runs it would leave
    // that file behind, and this is the assertion that the opt-in stays opt-in.
    const dir = scaffolded({ 'package.json': manifest, 'server.js': STARTS_AND_MARKS });
    expect(check(dir).code).toBe(0);
    expect(existsSync(path.join(dir, 'started'))).toBe(false);

    // And the same app under `--runtime` does start, so the assertion above is about the flag and not
    // about an app that never runs at all.
    expect(check(dir, '--runtime').code).toBe(0);
    expect(existsSync(path.join(dir, 'started'))).toBe(true);
  });
});
