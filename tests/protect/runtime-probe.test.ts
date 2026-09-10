// The opt-in runtime check: start an app, ask each listener it opens, and report whether the request
// reached the scaffolded seam.
//
// Every case here is a real child process on a real loopback port, because the whole value of this check
// is that it observes a running app rather than reading its source. The controls matter more than the
// passes: an app that answers 200 without the sentinel, one that never listens, and one that cannot be
// loaded must all be distinguishable from a traversal.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Every case here starts a real process, so every case declares a timeout that fits the run it performs.
// The default five seconds is shorter than the runs below allow, and a test vitest abandons mid-run is
// not just a failure: the awaited promise is dropped, its cleanup never happens, and the app it started
// is left on the machine. Long enough for a loaded CI runner, and each run bounds itself anyway.
const SLOW = { timeout: 60_000 };

import { VERIFY_HEADER, sentinelAnswer } from '../../src/protect/verify-sentinel.js';
import {
  CHALLENGE_ENV,
  VERIFY_HEADER_NAME,
  expectedAnswerFor,
  preloadPath,
  probeRuntimeTraversal,
  propagatedNodeOptions,
  verdictOf,
} from '../../src/protect/install/runtime/probe.js';

const SENTINEL = pathToFileURL(fileURLToPath(new URL('../../src/protect/verify-sentinel.js', import.meta.url))).href;

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A project directory with the given files, cleaned up after each test. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ps-runtime-probe-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }

  return dir;
}

/** The request seam, as the templates write it: answer the sentinel before the app handler runs. */
const ESM_SEAM = `
import { createServer } from 'node:http';
import { sentinelAnswer, VERIFY_HEADER } from ${JSON.stringify(SENTINEL)};


createServer(async (req, res) => {
  const answered = await sentinelAnswer(req.headers[VERIFY_HEADER]);
  if (answered) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(answered); return; }
  res.writeHead(200); res.end('the app');
}).listen(3000);
`;

const CJS_SEAM = `
const { createServer } = require('node:http');

createServer((req, res) => {
  import(${JSON.stringify(SENTINEL)}).then(async ({ sentinelAnswer, VERIFY_HEADER }) => {
    const answered = await sentinelAnswer(req.headers[VERIFY_HEADER]);
    if (answered) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(answered); return; }
    res.writeHead(200); res.end('the app');
  });
}).listen(3000);
`;

/**
 * A throwaway self-signed certificate, generated per test rather than committed: a private key in a
 * public repository is a liability even when it only ever protects a loopback port for 30ms.
 *
 * `openssl` is a maintainer-toolchain requirement for this file. If it is missing the test fails, which
 * is the honest outcome — a skip here would quietly stop covering the HTTPS branch.
 */
function certificate(dir: string): { key: string; cert: string } {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });

  return { key: join(dir, 'key.pem'), cert: join(dir, 'cert.pem') };
}

/**
 * Whether a process — or, for a negative pid, a whole process GROUP — is gone.
 *
 * Polled rather than sampled once: a signalled process is reaped by whoever is its parent, and how long
 * that takes is not this test's business. The group form needs no cooperation from the app, which is
 * what makes it usable on a run that ends the moment the app does something: a group exists while any
 * member of it does, so `kill(-pid, 0)` failing is the whole claim that nothing was left behind.
 */
async function gone(pid: number, withinMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // no such process, or no such group
    }
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const run = (cwd: string, entry: string) =>
  probeRuntimeTraversal({ cwd, entry: join(cwd, entry), timeoutMs: 8_000, settleMs: 300 });

describe('the names the seam and the harness share', SLOW, () => {
  it('uses the header the seam reads', () => {
    expect(VERIFY_HEADER_NAME).toBe(VERIFY_HEADER);
  });

  it('derives the same answer as the seam, from two crypto implementations', async () => {
    const challenge = 'c'.repeat(64);
    process.env[CHALLENGE_ENV] = challenge;
    try {
      expect(await sentinelAnswer(challenge)).toBe(expectedAnswerFor(challenge));
    } finally {
      delete process.env[CHALLENGE_ENV];
    }
  });

  it('ships the listener reporter alongside the harness', () => {
    expect(preloadPath()).not.toBeNull();
  });
});

describe('an app whose seam answers', SLOW, () => {
  it('proves traversal for a CommonJS entry', async () => {
    const dir = project({ 'server.cjs': CJS_SEAM });
    const result = await run(dir, 'server.cjs');
    expect(result.outcome).toBe('proven');
    expect(result.listeners).toEqual([
      { scheme: 'http', host: '127.0.0.1', port: expect.any(Number), outcome: 'traversed', detail: undefined },
    ]);
  });

  it('proves traversal for a Node ESM entry', async () => {
    const dir = project({ 'server.mjs': ESM_SEAM });
    expect((await run(dir, 'server.mjs')).outcome).toBe('proven');
  });

  it('proves traversal for a bundled entry', async () => {
    // A single-file build with no package boundary of its own to speak of.
    const dir = project({ 'package.json': '{"type":"module"}', 'dist/bundle.js': ESM_SEAM });
    expect((await run(dir, 'dist/bundle.js')).outcome).toBe('proven');
  });

  it('proves traversal only when every listener answers', async () => {
    const dir = project({
      'both.mjs': `${ESM_SEAM}\n${ESM_SEAM.split('\n').slice(3).join('\n').replace('listen(3000)', 'listen(3001)')}`,
    });
    const result = await run(dir, 'both.mjs');
    expect(result.outcome).toBe('proven');
    expect(result.listeners).toHaveLength(2);
  });

  it('waits for an app that takes its time to boot', async () => {
    // The settling interval means "no new listener since the last one". If it started when the process
    // did, a framework that spends a second booting would be reported as opening no listener at all.
    const dir = project({ 'slow.mjs': `await new Promise((r) => setTimeout(r, 900));\n${ESM_SEAM}` });
    expect((await run(dir, 'slow.mjs')).outcome).toBe('proven');
  });

  it('leaves nothing behind on a pass', async () => {
    const dir = project({ 'server.mjs': ESM_SEAM });
    const result = await run(dir, 'server.mjs');
    expect(result.outcome).toBe('proven');
    expect(await gone(result.pid!)).toBe(true);
  });

});

describe('an HTTPS listener', SLOW, () => {
  it('proves traversal, over a certificate nothing in this process trusts', async () => {
    const dir = project({});
    const { key, cert } = certificate(dir);
    writeFileSync(
      join(dir, 'secure.mjs'),
      `import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { sentinelAnswer, VERIFY_HEADER } from ${JSON.stringify(SENTINEL)};

createServer({ key: readFileSync(${JSON.stringify(key)}), cert: readFileSync(${JSON.stringify(cert)}) }, async (req, res) => {
  const answered = await sentinelAnswer(req.headers[VERIFY_HEADER]);
  if (answered) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(answered); return; }
  res.writeHead(200); res.end('the app');
}).listen(3000);`,
    );
    const result = await run(dir, 'secure.mjs');
    expect(result.listeners).toEqual([
      { scheme: 'https', host: '127.0.0.1', port: expect.any(Number), outcome: 'traversed', detail: undefined },
    ]);
    expect(result.outcome).toBe('proven');
  });

  it('relaxes certificate checking for its own request only, not for the process', async () => {
    const dir = project({});
    const { key, cert } = certificate(dir);
    writeFileSync(
      join(dir, 'secure.mjs'),
      `import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { sentinelAnswer, VERIFY_HEADER } from ${JSON.stringify(SENTINEL)};

createServer({ key: readFileSync(${JSON.stringify(key)}), cert: readFileSync(${JSON.stringify(cert)}) }, async (req, res) => {
  res.writeHead(200); res.end((await sentinelAnswer(req.headers[VERIFY_HEADER])) ?? 'the app');
}).listen(3000);`,
    );
    expect((await run(dir, 'secure.mjs')).outcome).toBe('proven');
    // Nothing process-wide was switched off to get there.
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    // And an ordinary request from this process still refuses that certificate. Held open across the
    // run above would be circular, so this is a second server from the same throwaway certificate.
    const { createServer: createSecure } = await import('node:https');
    const { readFileSync } = await import('node:fs');
    const server = createSecure({ key: readFileSync(key), cert: readFileSync(cert) }, (_req, res) => res.end('x'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const { request } = await import('node:https');
    const failure = await new Promise<string>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/' }, () => resolve('accepted the certificate'));
      req.on('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
      req.end();
    });
    server.close();
    expect(failure).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/);
  });

  it('reports a TLS listener it cannot complete a handshake with as unavailable', async () => {
    // `https.createServer()` with no certificate listens happily and fails every handshake.
    const dir = project({ 'nocert.mjs': `import { createServer } from 'node:https';\ncreateServer((req, res) => res.end('x')).listen(3000);` });
    const result = await run(dir, 'nocert.mjs');
    expect(result.listeners).toEqual([
      { scheme: 'https', host: '127.0.0.1', port: expect.any(Number), outcome: 'unreachable', detail: expect.any(String) },
    ]);
    expect(result.outcome).toBe('unavailable');
  });
});

describe('the port the app asked for', SLOW, () => {
  it('does not have to be free, because the listener is moved to an ephemeral loopback port', async () => {
    // The blocker takes a port the kernel just handed out, and the app is written to ask for exactly
    // that one. Naming a fixed port here would make the test depend on what else is running.
    const { createServer } = await import('node:http');
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
    const taken = (blocker.address() as { port: number }).port;
    try {
      const dir = project({ 'server.mjs': ESM_SEAM.replace('listen(3000)', `listen(${taken})`) });
      const result = await run(dir, 'server.mjs');
      expect(result.outcome).toBe('proven');
      expect(result.listeners[0].port).not.toBe(taken);
    } finally {
      blocker.close();
    }
  });
});

describe('what must not read as proof', SLOW, () => {
  it('reports an app that answers 200 without the sentinel as not traversed', async () => {
    const dir = project({
      'bare.mjs': `import { createServer } from 'node:http';
createServer((req, res) => { res.writeHead(200); res.end('hello'); }).listen(3000);`,
    });
    const result = await run(dir, 'bare.mjs');
    expect(result.outcome).toBe('not-traversed');
    expect(result.listeners[0]).toMatchObject({ outcome: 'answered-without-sentinel' });
  });

  it('reports an app that echoes the challenge back as not traversed', async () => {
    const dir = project({
      'echo.mjs': `import { createServer } from 'node:http';
createServer((req, res) => { res.writeHead(200); res.end(req.headers[${JSON.stringify(VERIFY_HEADER)}] ?? ''); }).listen(3000);`,
    });
    expect((await run(dir, 'echo.mjs')).outcome).toBe('not-traversed');
  });

  it('reports a partly guarded app as not traversed, and names both listeners', async () => {
    // One server behind the seam, one not — the shape an app takes when a second server was added after
    // the guard was wired. A verdict drawn from the guarded one alone would be a pass for half an app.
    const dir = project({
      'partial.mjs': `${ESM_SEAM}
import { createServer as createSecond } from 'node:http';
createSecond((req, res) => { res.writeHead(200); res.end('the other server'); }).listen(3001);`,
    });
    const result = await run(dir, 'partial.mjs');
    expect(result.listeners).toHaveLength(2);
    expect(result.listeners.map((l) => l.host)).toEqual(['127.0.0.1', '127.0.0.1']);
    expect(result.listeners.map((l) => l.outcome).sort()).toEqual(['answered-without-sentinel', 'traversed']);
    expect(result.outcome).toBe('not-traversed');
  });

  it('reports an app answering a fixed digest as not traversed', async () => {
    // The answer is a digest of THIS run's challenge. A body that happens to be a valid-looking digest —
    // hard-coded, cached from an earlier run, copied from a doc — is not an answer to the question asked.
    const dir = project({
      'fixed.mjs': `import { createServer } from 'node:http';
createServer((req, res) => { res.writeHead(200); res.end('${'a'.repeat(64)}'); }).listen(3000);`,
    });
    expect((await run(dir, 'fixed.mjs')).outcome).toBe('not-traversed');
  });

  it('reports an entry that cannot be loaded as unavailable, not as a failure to traverse', async () => {
    const dir = project({ 'broken.mjs': 'import { nothing } from "node:this-does-not-exist";' });
    const result = await run(dir, 'broken.mjs');
    expect(result.outcome).toBe('unavailable');
    expect(result.reason).toMatch(/exited before it listened/);
  });

  it('says the app exited while it was being probed, rather than giving no reason at all', async () => {
    const dir = project({
      'flees.mjs': `import { createServer } from 'node:http';
const server = createServer((req, res) => res.end('x'));
// A beat, so the listener has certainly been reported before the exit is: the two arrive over
// different channels, and an exit in the same tick as the listen can be delivered first.
server.listen(3000, () => { setTimeout(() => { server.close(); process.exit(0); }, 150); });`,
    });
    // A settling window far wider than the app's own delay, so the exit is what ends this run and the
    // case under test is the one that runs — not a race between the two.
    const result = await probeRuntimeTraversal({ cwd: dir, entry: join(dir, 'flees.mjs'), timeoutMs: 8_000, settleMs: 2_000 });
    expect(result.outcome).toBe('unavailable');
    expect(result.reason).toMatch(/exited while it was being probed/);
  });

  it('reports a listener that never stops answering as not traversed', async () => {
    // Read to a budget and no further: an unverified application must not be able to grow this process,
    // and past that budget the answer cannot be the digest whatever else arrives.
    const dir = project({
      'endless.mjs': `import { createServer } from 'node:http';
createServer((req, res) => {
  res.writeHead(200);
  const pump = () => { if (res.write('x'.repeat(4096))) setImmediate(pump); else res.once('drain', pump); };
  pump();
}).listen(3000);`,
    });
    expect((await run(dir, 'endless.mjs')).outcome).toBe('not-traversed');
  });

  it('reports a directory it cannot start the app in as unavailable', async () => {
    const dir = project({ 'server.mjs': ESM_SEAM });
    const result = await probeRuntimeTraversal({
      cwd: join(dir, 'not-a-directory'),
      entry: join(dir, 'server.mjs'),
      timeoutMs: 4_000,
      settleMs: 300,
    });
    expect(result.outcome).toBe('unavailable');
    expect(result.reason).toMatch(/could not be started/);
  });

  it('reports an app that opens no listener as unavailable', async () => {
    const dir = project({ 'quiet.mjs': 'console.log("started, listening to nothing");' });
    const result = await run(dir, 'quiet.mjs');
    expect(result.outcome).toBe('unavailable');
    expect(result.reason).toMatch(/exited before it listened/);
  });

  it('reports an app that hangs without listening as unavailable', async () => {
    const dir = project({ 'hang.mjs': 'setInterval(() => {}, 1000);' });
    const result = await probeRuntimeTraversal({ cwd: dir, entry: join(dir, 'hang.mjs'), timeoutMs: 1_200, settleMs: 300 });
    expect(result.outcome).toBe('unavailable');
    expect(result.reason).toMatch(/no HTTP listener was observed/);
  });

  it('reports a transport it cannot probe as unavailable', async () => {
    const SOCKET_PATH = join(tmpdir(), `ps-probe-${process.pid}.sock`);
    const dir = project({
      'unix.mjs': `import { createServer } from 'node:http';
const server = createServer((req, res) => res.end('x'));
server.on('listening', () => { console.log('app saw LISTENING'); });
server.on('error', (err) => { console.log('app saw ' + err.code); });
server.listen(${JSON.stringify(SOCKET_PATH)});
// Kept alive deliberately: an app that exits after the refusal would end the run by exiting, which
// would hide whether the refusal itself ended it.
setInterval(() => {}, 1000);`,
    });
    // A settling window far longer than this should take: a refused listener ENDS discovery, so the run
    // finishes at once rather than waiting to see what else the app opens.
    const startedAt = Date.now();
    const result = await probeRuntimeTraversal({ cwd: dir, entry: join(dir, 'unix.mjs'), timeoutMs: 20_000, settleMs: 5_000 });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(result.outcome).toBe('unavailable');
    expect(result.reason).toMatch(/Unix socket/);
    expect(result.listeners).toEqual([]);
    // That the refusal HELD — the app never became listening, and no socket was created — is pinned in
    // the reporter's own tests, where the child outlives the answer. Here the child is stopped as soon
    // as the refusal is heard, which is the contract: discovery ends, and the app is not left starting.
    expect(await gone(result.pid!)).toBe(true);
    expect(existsSync(SOCKET_PATH)).toBe(false);
  });

  it('distinguishes a reporter that never loaded from an app that never listened', async () => {
    // The pair: with the real reporter, a listenerless app is reported as opening no listener (above).
    // With a reporter that says nothing, the same app is reported as a reporter that did not load —
    // a broken installation, not a finding about the app. No listener is opened either way, so the
    // answer does not depend on a port being free on the machine running this.
    const dir = project({ 'hang.mjs': 'setInterval(() => {}, 1000);', 'silent.cjs': '// loads, reports nothing' });
    const result = await probeRuntimeTraversal({
      cwd: dir,
      entry: join(dir, 'hang.mjs'),
      preload: join(dir, 'silent.cjs'),
      timeoutMs: 1_200,
      settleMs: 300,
    });
    expect(result.outcome).toBe('unavailable');
    expect(result.reason).toMatch(/reporter did not load/);
  });

  it('reports and refuses an app that attempts to start another process', async () => {
    const dir = project({
      'spawner.mjs': `import { spawnSync } from 'node:child_process';
spawnSync('/bin/sh', ['-c', 'exit 0']);
${ESM_SEAM}`,
    });
    // Same as a refused listener: discovery ends there, rather than settling out the interval.
    const startedAt = Date.now();
    const result = await probeRuntimeTraversal({ cwd: dir, entry: join(dir, 'spawner.mjs'), timeoutMs: 20_000, settleMs: 5_000 });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(result.outcome).toBe('unavailable');
    expect(result.reason).toMatch(/one-process/);
    expect(result.listeners).toEqual([]);
  });

  it('reports and refuses an app that attempts to start another Node process too', async () => {
    const dir = project({
      'worker.mjs': `import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
${ESM_SEAM}`,
    });
    const result = await run(dir, 'worker.mjs');
    expect(result.outcome).toBe('unavailable');
    expect(result.reason).toMatch(/one-process/);
  });

  it('reports an app that starts a worker thread as unavailable', async () => {
    // The worker loads the reporter and its listeners are moved to loopback, so containment holds. What
    // it has no way to do is report: a worker has no `process.send`. Answering from the main thread's
    // listener alone would be a pass for part of an app.
    const dir = project({
      'threaded.mjs': `import { Worker } from 'node:worker_threads';
new Worker("require('node:http').createServer((q, r) => r.end('unguarded')).listen(3100);", { eval: true });
${ESM_SEAM}`,
    });
    const result = await run(dir, 'threaded.mjs');
    expect(result.outcome).toBe('unavailable');
    expect(result.reason).toMatch(/worker thread/);
    expect(result.listeners).toEqual([]);
  });

  it('reports and refuses an app that goes around the child_process helpers', async () => {
    const dir = project({
      'lowlevel.mjs': `import { ChildProcess } from 'node:child_process';
const child = new ChildProcess();
child.spawn({ file: process.execPath, args: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], stdio: 'ignore' });
${ESM_SEAM}`,
    });
    const result = await run(dir, 'lowlevel.mjs');
    expect(result.outcome).toBe('unavailable');
    expect(result.reason).toMatch(/one-process/);
  });

  it('does not copy a startup command line into the reason it prints', async () => {
    // `exec` is handed a whole shell command line, and a startup command commonly carries a token. The
    // reason names the launcher and the fact that it was a command line, and nothing that was in it.
    const dir = project({
      'secretive.mjs': `import { execSync } from 'node:child_process';
execSync('echo ps-secret-71d0e4 >/dev/null');
${ESM_SEAM}`,
    });
    const result = await run(dir, 'secretive.mjs');
    expect(result.outcome).toBe('unavailable');
    expect(result.reason).toMatch(/shell command line/);
    expect(JSON.stringify(result)).not.toContain('ps-secret-71d0e4');
  });

  it('refuses to answer for a listener that opens after discovery has ended', async () => {
    // The first listener is guarded and slow to answer; the second opens while that request is still in
    // flight, which is after the set of listeners to probe was fixed. It cannot join that set, and
    // ignoring it would let an unguarded listener stand behind a pass on the guarded one.
    const dir = project({
      'late.mjs': `import { createServer } from 'node:http';
import { sentinelAnswer, VERIFY_HEADER } from ${JSON.stringify(SENTINEL)};

createServer(async (req, res) => {
  const answered = await sentinelAnswer(req.headers[VERIFY_HEADER]);
  await new Promise((r) => setTimeout(r, 1200));
  if (answered) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(answered); return; }
  res.writeHead(200); res.end('the app');
}).listen(3000);

setTimeout(() => { createServer((req, res) => res.end('unguarded')).listen(3001); }, 700);
`,
    });
    const result = await probeRuntimeTraversal({ cwd: dir, entry: join(dir, 'late.mjs'), timeoutMs: 15_000, settleMs: 300 });
    expect(result.outcome).toBe('unavailable');
    expect(result.reason).toMatch(/after discovery had ended/);
    expect(result.listeners).toEqual([]);
  });

  it('refuses to answer, and leaves nothing behind, when a launch would escape its cleanup', async () => {
    // The refusal applies before option details matter. This launch makes both escape routes explicit,
    // and must still never reach the child that would open the public listener.
    const dir = project({
      'escaping.mjs': `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
try {
  spawn(process.execPath, ['-e', "require('node:http').createServer().listen(0, '0.0.0.0'); setInterval(() => {}, 1000)"], {
    detached: true,
    env: { PATH: process.env.PATH },
    stdio: 'ignore',
  }).unref();
  writeFileSync(new URL('./escaped', import.meta.url), 'yes');
} catch {
  writeFileSync(new URL('./refused', import.meta.url), 'yes');
}
${ESM_SEAM}`,
    });
    const result = await run(dir, 'escaping.mjs');
    expect(result.outcome).toBe('unavailable');
    expect(result.reason).toMatch(/one-process/);
    expect(existsSync(join(dir, 'escaped')), 'the launch was allowed to happen').toBe(false);
    expect(existsSync(join(dir, 'refused'))).toBe(true);
  });

  it('refuses to answer for a worker that would not load the reporter', async () => {
    const dir = project({
      'unscreened.mjs': `import { Worker } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
try {
  new Worker("require('node:http').createServer().listen(0, '0.0.0.0');", { eval: true, env: {} });
  writeFileSync(new URL('./escaped', import.meta.url), 'yes');
} catch {
  writeFileSync(new URL('./refused', import.meta.url), 'yes');
}
${ESM_SEAM}`,
    });
    const result = await run(dir, 'unscreened.mjs');
    expect(result.outcome).toBe('unavailable');
    expect(result.reason).toMatch(/one-process scope/);
    expect(existsSync(join(dir, 'escaped')), 'the worker was allowed to start').toBe(false);
    expect(existsSync(join(dir, 'refused'))).toBe(true);
  });

  it('refuses to answer for a listener that opens as the last response finishes', async () => {
    // The boundary the settled-discovery check alone does not reach. The second listener's report is
    // already sent, but its IPC callback can sit behind the HTTP one, so the promise chain here would
    // read an empty set of late arrivals, form a pass, and kill the child with the message undelivered.
    // Repeated, because a pass here would be a pass with an unguarded listener nobody asked.
    const dir = project({
      'boundary.mjs': `import { createServer } from 'node:http';
import { sentinelAnswer, VERIFY_HEADER } from ${JSON.stringify(SENTINEL)};

createServer(async (req, res) => {
  const answered = await sentinelAnswer(req.headers[VERIFY_HEADER]);
  const late = createServer((q, r) => r.end('unguarded'));
  late.listen(3001, '127.0.0.1', () => {
    if (answered) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(answered); return; }
    res.writeHead(200); res.end('the app');
  });
}).listen(3000);
`,
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await probeRuntimeTraversal({ cwd: dir, entry: join(dir, 'boundary.mjs'), timeoutMs: 15_000, settleMs: 300 });
      expect(result.outcome, `attempt ${attempt}`).toBe('unavailable');
      expect(result.reason, `attempt ${attempt}`).toMatch(/after discovery had ended/);
    }
  });

  it('refuses to answer when the app never confirms it has stopped opening listeners', async () => {
    // The confirmation is what makes the final read trustworthy, so a reporter that loads and answers
    // listener reports but never acknowledges the freeze must not produce a pass.
    const dir = project({
      'server.cjs': CJS_SEAM,
      'mute.cjs': `'use strict';
const net = require('node:net');
const http = require('node:http');
const original = net.Server.prototype.listen;
// Reports listeners like the real one, and deliberately never answers the freeze request.
net.Server.prototype.listen = function (...args) {
  const result = original.call(this, 0, '127.0.0.1');
  this.once('listening', () => {
    const address = this.address();
    process.send({ patchstackVerify: 'listener', scheme: this instanceof http.Server ? 'http' : 'https', host: address.address, port: address.port });
  });

  return result;
};
process.send({ patchstackVerify: 'ready', pid: process.pid });
`,
    });
    const result = await probeRuntimeTraversal({
      cwd: dir,
      entry: join(dir, 'server.cjs'),
      preload: join(dir, 'mute.cjs'),
      timeoutMs: 12_000,
      settleMs: 300,
    });
    expect(result.outcome).toBe('unavailable');
    expect(result.reason).toMatch(/never confirmed/);
  });

  it('refuses to answer for a listener bound off loopback', async () => {
    // Nothing the reporter permits can reach here, so the app is started with the reporter suppressed
    // for the listen path: what is under test is the parent's refusal, not the rewrite.
    const dir = project({
      'public.cjs': `'use strict';
const net = require('node:net');
const http = require('node:http');
// A listen the reporter never saw, so it binds exactly as written.
const server = http.createServer((req, res) => res.end('public'));
net.Server.prototype.listen = require('node:net').Server.prototype.listen;
process.send({ patchstackVerify: 'ready', pid: process.pid });
server.listen(0, '0.0.0.0', () => {
  process.send({ patchstackVerify: 'listener', scheme: 'http', host: '0.0.0.0', port: server.address().port });
});
`,
      'noop.cjs': '// the reporter, replaced by nothing for this case',
    });
    const result = await probeRuntimeTraversal({
      cwd: dir,
      entry: join(dir, 'public.cjs'),
      preload: join(dir, 'noop.cjs'),
      timeoutMs: 6_000,
      settleMs: 300,
    });
    expect(result.outcome).toBe('unavailable');
    expect(result.reason).toMatch(/must not open/);
    expect(result.reason).toMatch(/0\.0\.0\.0/);
    expect(result.listeners).toEqual([]);
  });

  it('answers unavailable on Windows without launching anything', async () => {
    const dir = project({ 'server.mjs': ESM_SEAM });
    const result = await probeRuntimeTraversal({ cwd: dir, entry: join(dir, 'server.mjs'), platform: 'win32' });
    expect(result).toEqual({ outcome: 'unavailable', reason: expect.stringMatching(/Windows/), listeners: [], output: '' });
  });
});

describe('the aggregate verdict', SLOW, () => {
  const traversed = { scheme: 'http', host: '127.0.0.1', port: 1, outcome: 'traversed' } as const;

  it('treats nothing observed as unavailable rather than as a pass', () => {
    expect(verdictOf([])).toBe('unavailable');
  });

  it('lets one unanswered listener outrank the others', () => {
    expect(verdictOf([traversed, { ...traversed, port: 2, outcome: 'answered-without-sentinel' }])).toBe('not-traversed');
  });

  it('lets an unreachable listener outrank a failure', () => {
    expect(
      verdictOf([
        { ...traversed, port: 2, outcome: 'answered-without-sentinel' },
        { ...traversed, port: 3, outcome: 'unreachable' },
      ]),
    ).toBe('unavailable');
  });

  it('is proven only when every listener traversed', () => {
    expect(verdictOf([traversed, { ...traversed, port: 2 }])).toBe('proven');
  });
});

describe('the deadline', SLOW, () => {
  it('covers the probes too, not only discovery', async () => {
    // A listener that accepts the connection and answers nothing. With a per-phase timeout the run would
    // sit here for the probe's own five seconds after discovery had already finished.
    const dir = project({
      'silent.mjs': `import { createServer } from 'node:http';
createServer(() => { /* never answers */ }).listen(3000);`,
    });
    const startedAt = Date.now();
    const result = await probeRuntimeTraversal({ cwd: dir, entry: join(dir, 'silent.mjs'), timeoutMs: 2_000, settleMs: 300 });
    const elapsed = Date.now() - startedAt;
    expect(result.outcome).toBe('unavailable');
    // Generous, and still far below the 300ms of discovery plus a five-second probe.
    expect(elapsed).toBeLessThan(4_000);
  });

  it('is spent, not extended, by a deadline that has already passed', async () => {
    const dir = project({ 'server.mjs': ESM_SEAM });
    const startedAt = Date.now();
    const result = await probeRuntimeTraversal({ cwd: dir, entry: join(dir, 'server.mjs'), timeoutMs: 100, settleMs: 300 });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result.outcome).toBe('unavailable');
  });

  it('does not let settling run past it', async () => {
    // A settling interval longer than the whole run must not extend the run.
    const dir = project({ 'server.mjs': ESM_SEAM });
    const startedAt = Date.now();
    await probeRuntimeTraversal({ cwd: dir, entry: join(dir, 'server.mjs'), timeoutMs: 1_000, settleMs: 30_000 });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });
});

describe('the NODE_OPTIONS it carries into the app', SLOW, () => {
  const preload = '/opt/patchstack/report-listeners.cjs';

  it('carries the reporter when nothing was inherited', () => {
    expect(propagatedNodeOptions(preload, undefined)).toEqual({ kind: 'options', value: `--require "${preload}"` });
    expect(propagatedNodeOptions(preload, '  ')).toEqual({ kind: 'options', value: `--require "${preload}"` });
  });

  it('puts the reporter first, ahead of anything it inherited', () => {
    // Order in this value is order of execution, and Node parses the whole of it before the command
    // line. Anything ahead of the reporter runs before `net.Server.prototype.listen` is patched.
    expect(propagatedNodeOptions(preload, '--no-warnings')).toEqual({
      kind: 'options',
      value: `--require "${preload}" --no-warnings`,
    });
  });

  it('refuses an inherited value that runs code before the reporter', () => {
    for (const existing of ['--require ./boot.cjs', '--import ./boot.mjs', '--experimental-loader ./l.mjs', '--eval "0"', '--inspect']) {
      const result = propagatedNodeOptions(preload, existing);
      expect(result.kind, existing).toBe('unavailable');
      expect(result.kind === 'unavailable' && result.reason, existing).toMatch(/NODE_OPTIONS/);
    }
  });

  it('refuses an inherited value it does not recognise', () => {
    const result = propagatedNodeOptions(preload, '--some-future-flag=1');
    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason).toMatch(/does not recognise/);
  });

  it('refuses an inherited value it cannot split the way Node will', () => {
    const result = propagatedNodeOptions(preload, '--require "/opt/boot.cjs');
    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason).toMatch(/unbalanced double quote/);
  });

  it('refuses a reporter path this value cannot carry', () => {
    const result = propagatedNodeOptions('/opt/we"ird/report.cjs', undefined);
    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason).toMatch(/double quote/);
  });

  it('does not launch the app at all when the inherited value is refused', async () => {
    // Before the spawn, like the platform check: containment the run cannot guarantee is not something
    // to find out about once the application is already running.
    const dir = project({
      'marks.mjs': `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./started', import.meta.url), 'yes');
${ESM_SEAM}`,
    });
    const before = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--require ./boot.cjs';
    try {
      const result = await run(dir, 'marks.mjs');
      expect(result.outcome).toBe('unavailable');
      expect(result.reason).toMatch(/NODE_OPTIONS/);
      expect(result.pid, 'a process was started anyway').toBeUndefined();
      expect(existsSync(join(dir, 'started')), 'the app was started anyway').toBe(false);
    } finally {
      if (before === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = before;
    }
  });

  it('still proves traversal with a recognised value inherited', async () => {
    const dir = project({ 'server.mjs': ESM_SEAM });
    const before = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--no-warnings';
    try {
      expect((await run(dir, 'server.mjs')).outcome).toBe('proven');
    } finally {
      if (before === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = before;
    }
  });
});

describe('the signal handlers it installs while the app is running', SLOW, () => {
  const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;
  const counts = () => SIGNALS.map((signal) => process.listenerCount(signal)).concat(process.listenerCount('exit'));

  it('are in place while the app is running, not only at the end', async () => {
    // The window they exist for is the one where the app is already a detached process group. So they
    // have to be observable DURING the run, which is what this waits for.
    const before = counts();
    const dir = project({ 'server.mjs': ESM_SEAM });
    const running = probeRuntimeTraversal({ cwd: dir, entry: join(dir, 'server.mjs'), timeoutMs: 20_000, settleMs: 2_000 });
    const deadline = Date.now() + 10_000;
    while (counts().join() === before.join() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(counts(), 'no handler was installed while the app was running').not.toEqual(before);
    // Every one of them, so a missing signal cannot hide behind the others.
    expect(counts()).toEqual(before.map((n) => n + 1));

    await running;
    expect(counts()).toEqual(before);
  });

  it('do not deliver the signal a second time to a handler that was already there', async () => {
    // Removing our own handler restores the default disposition only when ours was the only one. With
    // another handler present there is no default to restore, and that handler has already been called
    // for this signal — so re-sending it would call it twice, which is not what installing one handler
    // asked for.
    const seen: string[] = [];
    const preexisting = () => seen.push('SIGINT');
    const base = process.listenerCount('SIGINT');
    process.on('SIGINT', preexisting);
    try {
      const dir = project({ 'server.mjs': ESM_SEAM });
      const running = probeRuntimeTraversal({ cwd: dir, entry: join(dir, 'server.mjs'), timeoutMs: 20_000, settleMs: 2_000 });
      const deadline = Date.now() + 10_000;
      while (process.listenerCount('SIGINT') < base + 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      expect(process.listenerCount('SIGINT'), 'the probe never installed its handler').toBeGreaterThanOrEqual(base + 2);

      process.kill(process.pid, 'SIGINT');
      await running;
      await new Promise((r) => setTimeout(r, 100));
      expect(seen).toEqual(['SIGINT']);
    } finally {
      process.removeListener('SIGINT', preexisting);
    }
  });

  /**
   * Run `body` with SIGINT's listener list emptied, and put it back afterwards.
   *
   * Both cases below need this process's own signal environment to be exactly what they set up. The
   * runner keeps a persistent SIGINT handler of its own, which would sit in every count and every
   * ordering assertion and make either case pass whatever the probe did.
   */
  const withNoSignalHandlers = async (body: () => Promise<void>): Promise<void> => {
    // `listeners()` unwraps a `once` listener. Restoring that function with `on` would silently change
    // the test runner's signal semantics, so preserve the raw wrappers instead.
    const saved = process.rawListeners('SIGINT');
    process.removeAllListeners('SIGINT');
    try {
      await body();
    } finally {
      process.removeAllListeners('SIGINT');
      for (const listener of saved) process.on('SIGINT', listener as (...args: unknown[]) => void);
    }
  };

  /** Wait until the probe's handler is attached alongside however many are expected beside it. */
  const untilInstalled = async (total: number): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (process.listenerCount('SIGINT') < total && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(process.listenerCount('SIGINT'), 'the probe never installed its handler').toBe(total);
  };

  it('run before a handler the caller already registered', async () => {
    // Prepending is what makes the count in the handler meaningful, so it is asserted on its own: the
    // caller's listener has to still be there, after ours, when ours runs.
    await withNoSignalHandlers(async () => {
      const sentinel = (): void => {};
      process.on('SIGINT', sentinel);
      const dir = project({ 'server.mjs': ESM_SEAM });
      const running = probeRuntimeTraversal({ cwd: dir, entry: join(dir, 'server.mjs'), timeoutMs: 20_000, settleMs: 2_000 });
      await untilInstalled(2);

      const listeners = process.listeners('SIGINT');
      expect(listeners[1], 'the probe did not prepend its handler').toBe(sentinel);
      expect(listeners[0]).not.toBe(sentinel);

      await running;
      expect(process.listeners('SIGINT')).toEqual([sentinel]);
    });
  });

  it('do not override a pre-existing handler registered with once', async () => {
    // A `once` handler removes itself as it runs. Running after one and then counting would read zero —
    // the same as nobody listening — and re-sending the signal then kills a process whose only handler
    // has already dealt with it.
    await withNoSignalHandlers(async () => {
      let handled = 0;
      process.once('SIGINT', () => {
        handled++;
      });
      const dir = project({ 'server.mjs': ESM_SEAM });
      const running = probeRuntimeTraversal({ cwd: dir, entry: join(dir, 'server.mjs'), timeoutMs: 20_000, settleMs: 2_000 });
      await untilInstalled(2);

      process.kill(process.pid, 'SIGINT');
      await running;
      await new Promise((r) => setTimeout(r, 100));
      // Called once, and this process is still here to say so.
      expect(handled).toBe(1);
    });
  });

  it('are removed again, so a session that runs the check twice accumulates none', async () => {
    const before = counts();
    const dir = project({ 'server.mjs': ESM_SEAM });
    await run(dir, 'server.mjs');
    await run(dir, 'server.mjs');
    expect(counts()).toEqual(before);
  });
});

describe('the child output it retains', SLOW, () => {
  it('keeps a bounded excerpt with the challenge and its answer removed', async () => {
    const dir = project({
      'noisy.mjs': `${ESM_SEAM}
console.log('starting with ' + process.env[${JSON.stringify(CHALLENGE_ENV)}]);
console.log('x'.repeat(20000));`,
    });
    const result = await run(dir, 'noisy.mjs');
    expect(result.outcome).toBe('proven');
    expect(result.output).toContain('starting with <challenge>');
    expect(result.output.length).toBeLessThanOrEqual(4_096);
  });

  it('removes a challenge that straddles the bound, rather than keeping half of it', async () => {
    // Padded so the challenge begins just under the limit and ends past it. Bounding the text before
    // redacting it leaves the first half of the value in output this promises not to carry.
    const dir = project({
      'straddling.mjs': `${ESM_SEAM}
console.log('y'.repeat(4060));
console.log('the challenge is ' + process.env[${JSON.stringify(CHALLENGE_ENV)}]);`,
    });
    const result = await run(dir, 'straddling.mjs');
    expect(result.outcome).toBe('proven');
    expect(result.output).toContain('the challenge is <challenge>');
    // The challenge is the only hex of that length anything here prints.
    expect(result.output).not.toMatch(/[0-9a-f]{16}/);
    expect(result.output.length).toBeLessThanOrEqual(4_096);
  });
});
