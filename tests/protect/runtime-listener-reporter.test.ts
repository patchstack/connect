// The listener reporter, on its own, in a real child process.
//
// It is the half of the runtime check that changes the application: it decides which listeners may bind
// and where, and it is the only thing standing between a verification run and a server opened on a
// public interface. So its boundary is pinned here rather than through the harness — a run driven from
// the parent kills the child as soon as it hears a refusal, which leaves no time to observe whether the
// refusal held. Here the child outlives the answer and says what happened.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Every case here starts a real process, so every case declares a timeout that fits the run it performs.
// The default five seconds is shorter than the runs below allow, and a test vitest abandons mid-run is
// not just a failure: the awaited promise is dropped, its cleanup never happens, and the app it started
// is left on the machine. Long enough for a loaded CI runner, and each run bounds itself anyway.
const SLOW = { timeout: 60_000 };

import { preloadPath } from '../../src/protect/install/runtime/probe.js';


const preload = preloadPath();

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

interface Note {
  patchstackVerify?: string;
  scheme?: string;
  host?: string;
  port?: number;
  why?: string;
  via?: string;
  what?: string;
  node?: boolean;
  escape?: string;
  pid?: number;
}

/** Run one script under the reporter and collect what it reported and what it printed. */
async function under(script: string, alongside: Record<string, string> = {}): Promise<{ notes: Note[]; out: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'ps-reporter-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'case.cjs'), script);
  for (const [name, body] of Object.entries(alongside)) writeFileSync(join(dir, name), body);

  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--require', preload!, join(dir, 'case.cjs')], {
      cwd: dir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      // The reporter in `NODE_OPTIONS` as well as on the command line, which is how the harness
      // launches an app. The reporter reads that variable to decide whether a worker the app starts
      // would still load it, so a case run without it would not be running the real thing.
      env: { ...process.env, NODE_OPTIONS: `--require "${preload!}"` },
    });
    const notes: Note[] = [];
    let out = '';
    child.on('message', (note) => notes.push(note as Note));
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => (out += chunk));
    child.stderr?.on('data', (chunk: string) => (out += chunk));
    // Each case prints its verdict and exits; the timer is only so a hung case cannot hang the suite.
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, 6_000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve({ notes, out, dir });
    });
  });
}

/** The shape every unsupported case uses: bind, then report what became of the server. */
const REFUSAL_CASE = (create: string, listen: string) => `'use strict';
const server = ${create};
let listening = false;
server.on('listening', () => { listening = true; });
server.on('error', (err) => { console.log('error ' + err.code); });
${listen};
// Long enough for a bind to have completed if the refusal had let it.
setTimeout(() => { console.log('listening=' + listening); process.exit(0); }, 400);
`;

const firstOf = (notes: Note[], kind: string) => notes.find((n) => n.patchstackVerify === kind);

describe('the reporter is present', SLOW, () => {
  it('is where the harness looks for it', () => {
    expect(preload).not.toBeNull();
  });
});

describe('a listener it cannot probe', SLOW, () => {
  const cases: Array<[string, string, string, RegExp]> = [
    ['a raw TCP server', "require('node:net').createServer()", 'server.listen(0)', /is not an HTTP or HTTPS server \(Server\)/],
    ['an HTTP/2 server', "require('node:http2').createServer()", 'server.listen(0)', /not an HTTP or HTTPS server \(Http2Server\)/],
    [
      'a secure HTTP/2 server',
      "require('node:http2').createSecureServer()",
      'server.listen(0)',
      /not an HTTP or HTTPS server \(Http2SecureServer\)/,
    ],
    ['an HTTP server on a Unix path', "require('node:http').createServer()", "server.listen('./app.sock')", /listens on a Unix socket path/],
    ['an HTTP server on a negative string path', "require('node:http').createServer()", "server.listen('-1')", /listens on a Unix socket path/],
    [
      'an HTTP server on a Unix path given as an option',
      "require('node:http').createServer()",
      "server.listen({ path: './app.sock' })",
      /listens on a Unix socket path/,
    ],
    ['an HTTP server on a file descriptor', "require('node:http').createServer()", 'server.listen({ fd: 3 })', /listens on a file descriptor/],
    ['an HTTP server handed a handle', "require('node:http').createServer()", 'server.listen({ handle: {} })', /listens on a handle/],
    ['an HTTP server given invalid options', "require('node:http').createServer()", 'server.listen({})', /invalid listen options/],
    ['an HTTP server given an empty string port', "require('node:http').createServer()", "server.listen('')", /invalid TCP port/],
    ['an HTTP server given an out-of-range port', "require('node:http').createServer()", 'server.listen(65536)', /invalid TCP port/],
  ];

  it.each(cases)('refuses %s, and it never becomes listening', async (_label, create, listen, why) => {
    const { notes, out } = await under(REFUSAL_CASE(create, listen));
    expect(firstOf(notes, 'unsupported-listener')?.why).toMatch(why);
    // Reported AND refused: the app saw a refused bind, and nothing ever bound.
    expect(out).toContain('error EPERM');
    expect(out).toContain('listening=false');
    expect(firstOf(notes, 'listener')).toBeUndefined();
  });

  it('does not create the socket file it was asked for', async () => {
    const { out, dir } = await under(
      `${REFUSAL_CASE("require('node:http').createServer()", "server.listen('./app.sock')")}`.replace(
        "console.log('listening=' + listening)",
        "console.log('listening=' + listening); console.log('socket=' + require('node:fs').existsSync('./app.sock'))",
      ),
    );
    expect(out).toContain('socket=false');
    expect(dir).toBeTruthy();
  });
});

describe('a listener it can probe', SLOW, () => {
  // The app's own `listening` handler runs before the reporter's, so the exit waits a turn: a process
  // that calls `process.exit` from inside that handler cuts off its own report, which no server does but
  // a fixture easily can.
  const LISTENS = (listen: string) => `'use strict';
const server = require('node:http').createServer((req, res) => res.end('x'));
server.on('listening', () => {
  console.log('bound ' + JSON.stringify(server.address()));
  setTimeout(() => process.exit(0), 200);
});
${listen};
`;

  it.each([
    ['a bare listen', 'server.listen()'],
    ['a port', 'server.listen(3000)'],
    ['a port as a string', "server.listen('3000')"],
    ['a whitespace-padded port as a string', "server.listen(' 3000')"],
    ['a port in exponential notation as a string', "server.listen('3e3')"],
    ['a hexadecimal port as a string', "server.listen('0x10')"],
    ['a port read from the environment', "process.env.PORT = '3000'; server.listen(process.env.PORT)"],
    ['a null port', 'server.listen(null)'],
    ['options whose port takes precedence over a path', "server.listen({ port: 3000, path: './ignored.sock' })"],
    ['options whose unusable fd leaves the port in force', 'server.listen({ fd: -1, port: 3000 })'],
    ['a port and a public host', "server.listen(3000, '0.0.0.0')"],
    ['options naming a public host', "server.listen({ port: 3000, host: '0.0.0.0' })"],
  ])('moves %s onto an ephemeral loopback port', async (_label, listen) => {
    const { notes, out } = await under(LISTENS(listen));
    const listener = firstOf(notes, 'listener');
    expect(listener).toMatchObject({ scheme: 'http', host: '127.0.0.1' });
    expect(listener!.port).not.toBe(3000);
    expect(listener!.port).toBeGreaterThan(0);
    // What the app itself sees, so the report cannot claim an address the app did not get.
    expect(out).toContain(`"address":"127.0.0.1"`);
  });

  it('reports an HTTPS server as https', async () => {
    const { notes } = await under(`'use strict';
const server = require('node:https').createServer();
server.on('listening', () => setTimeout(() => process.exit(0), 200));
server.listen(0);
`);
    expect(firstOf(notes, 'listener')).toMatchObject({ scheme: 'https', host: '127.0.0.1' });
  });
});

describe('a process the app attempts to start', SLOW, () => {
  it('is reported, recognised as this runtime, and refused before launch', async () => {
    const { notes, out } = await under(`'use strict';
try { require('node:child_process').spawnSync(process.execPath, ['-e', '0']); }
catch (err) { console.log('refused ' + err.code); }
`);
    expect(firstOf(notes, 'process-created')).toMatchObject({ via: 'spawnSync', node: true });
    expect(out).toContain('refused EPERM');
  });

  it('is reported and refused when it is not this runtime', async () => {
    const { notes, out } = await under(`'use strict';
try { require('node:child_process').spawnSync('/bin/sh', ['-c', 'exit 0']); }
catch (err) { console.log('refused ' + err.code); }
`);
    // Named by its executable alone. The arguments are the app's, and one of them is commonly a secret.
    expect(firstOf(notes, 'process-created')).toMatchObject({ via: 'spawnSync', what: 'sh', node: false });
    expect(out).toContain('refused EPERM');
  });

  it('describes a shell launch as a command line, which cannot be judged as Node', async () => {
    const { notes } = await under(`'use strict';
try { require('node:child_process').execSync('node -e 0'); } catch {}
`);
    // The command line happens to name node; a shell can run anything, so it is not credited as node.
    expect(firstOf(notes, 'process-created')).toMatchObject({ via: 'execSync', node: false });
  });

  it('does not copy the command line of a shell launch into the report', async () => {
    // A startup command routinely carries a token or a password. The report says a shell command line
    // was run and nothing about what was in it, so a verifier cannot put a secret into someone's
    // terminal or CI log that the app never printed itself.
    const { notes } = await under(`'use strict';
try { require('node:child_process').execSync('echo ps-secret-4f8a21 >/dev/null'); } catch {}
`);
    expect(firstOf(notes, 'process-created')).toMatchObject({ via: 'execSync', what: 'a shell command line' });
    expect(JSON.stringify(notes)).not.toContain('ps-secret-4f8a21');
  });

  it.each([
    ['spawn', "spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' })"],
    ['exec', "exec('exit 0')"],
    ['execFile', "execFile('/bin/echo', ['x'])"],
    ['fork', "fork(require('node:path').join(__dirname, 'noop.cjs'), { stdio: 'ignore' })"],
    ['spawnSync', "spawnSync('/bin/echo', ['x'])"],
    ['execSync', "execSync('exit 0')"],
  ])('reports one refusal for %s', async (_label, call) => {
    // The exported wrapper reports and refuses before delegation. The low-level wrapper exists for a
    // direct `ChildProcess.spawn` call, not as a second report for one helper invocation.
    const { notes } = await under(
      `'use strict';
const { spawn, exec, execFile, fork, spawnSync, execSync } = require('node:child_process');
try { ${call}; } catch {}
setTimeout(() => process.exit(0), 400);
`,
      { 'noop.cjs': "'use strict';\n" },
    );
    expect(notes.filter((note) => note.patchstackVerify === 'process-created')).toHaveLength(1);
  });

  it.each([
    ['spawn', "spawn('echo ps-secret-2ba90f', { shell: true })"],
    ['spawn with an args array', "spawn('echo', ['ps-secret-2ba90f'], { shell: true })"],
    ['execFile', "execFile('echo ps-secret-2ba90f', { shell: true })"],
  ])('describes %s asking for a shell as a command line, not by its contents', async (_label, call) => {
    // `shell: true` turns the command argument into a command line on any helper, not only `exec`.
    const { notes } = await under(`'use strict';
const { spawn, execFile } = require('node:child_process');
try { ${call}; } catch {}
setTimeout(() => process.exit(0), 400);
`);
    expect(firstOf(notes, 'process-created')).toMatchObject({ what: 'a shell command line', node: false });
    expect(JSON.stringify(notes)).not.toContain('ps-secret-2ba90f');
  });

  it('is reported and refused when it goes around the helpers entirely', async () => {
    // A direct call to the low-level launch method has the same refusal as an exported helper.
    const { notes, out } = await under(`'use strict';
const { ChildProcess } = require('node:child_process');
const child = new ChildProcess();
try { child.spawn({ file: '/bin/echo', args: ['echo', 'went-around'], stdio: 'inherit' }); }
catch (err) { console.log('refused ' + err.code); }
`);
    expect(out).toContain('refused EPERM');
    expect(out).not.toContain('went-around');
    expect(firstOf(notes, 'process-created')).toMatchObject({ via: 'ChildProcess.spawn', what: 'echo', node: false });
  });

  it('is reported and refused for a cluster worker, which reaches the launch path its own way', async () => {
    const { notes, out } = await under(`'use strict';
const cluster = require('node:cluster');
if (cluster.isPrimary) {
  try { cluster.fork(); } catch (err) { console.log('refused ' + err.code); }
} else {
  process.exit(0);
}
`);
    const created = firstOf(notes, 'process-created');
    expect(created?.node).toBe(true);
    expect(created?.via).toMatch(/^(?:fork|ChildProcess\.spawn)$/);
    expect(out).toContain('refused EPERM');
  });
});

describe('the one-process boundary', SLOW, () => {
  it('refuses a launch even when its options do not reveal how the child could escape later', async () => {
    // A program launched in the current group may daemonize after it starts. No launch is delegated,
    // because option inspection cannot make the end-of-run cleanup a process-tree guarantee.
    const { notes, out } = await under(`'use strict';
const { spawn } = require('node:child_process');
try {
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  console.log('launched');
} catch (err) {
  console.log('refused ' + err.code);
}
setTimeout(() => process.exit(0), 200);
`);
    expect(firstOf(notes, 'process-created')?.escape).toMatch(/one-process scope/);
    expect(out).toContain('refused EPERM');
    expect(out).not.toContain('launched');
  });

  it('also refuses a launch whose environment preserves the reporter', async () => {
    const { notes, out } = await under(`'use strict';
const { spawnSync } = require('node:child_process');
try { spawnSync(process.execPath, ['-e', 'console.log("child ran")'], { env: { ...process.env, EXTRA: '1' }, encoding: 'utf8' }); }
catch (err) { console.log('refused ' + err.code); }
`);
    expect(firstOf(notes, 'process-created')?.escape).toMatch(/one-process scope/);
    expect(out).toContain('refused EPERM');
    expect(out).not.toContain('child ran');
  });
});

describe('a worker thread the app starts', SLOW, () => {
  it('is reported, because a worker cannot report its own listeners', async () => {
    // The worker loads this file and its listeners are contained like any other. What it does not have
    // is `process.send`, so a listener it opens can be neither counted nor asked — which is why the
    // creation is reported and the run declines rather than passing on the main thread alone.
    const { notes } = await under(
      `'use strict';
const { Worker } = require('node:worker_threads');
const worker = new Worker(require('node:path').join(__dirname, 'inside.cjs'));
worker.on('exit', () => process.exit(0));
`,
      { 'inside.cjs': "'use strict';\n" },
    );
    expect(firstOf(notes, 'worker-created')).toMatchObject({ what: 'inside.cjs' });
  });

  it('names inline source as inline rather than quoting it', async () => {
    const { notes } = await under(`'use strict';
const { Worker } = require('node:worker_threads');
const worker = new Worker('/* ps-secret-9c2b7 */', { eval: true });
worker.on('exit', () => process.exit(0));
`);
    expect(firstOf(notes, 'worker-created')).toMatchObject({ what: 'inline source' });
    expect(JSON.stringify(notes)).not.toContain('ps-secret-9c2b7');
  });

  it.each([
    ['a replaced environment', "{ env: {} }"],
    ['a replaced environment and no execArgv', "{ execArgv: [], env: {} }"],
  ])('is refused when it has %s, which is the only route the reporter has in', async (_label, options) => {
    // A worker's `execArgv` does not carry a preload, so `NODE_OPTIONS` is the only way this file
    // reaches one. A worker without it patches nothing and binds exactly what it asks for.
    const { notes, out } = await under(`'use strict';
const { Worker } = require('node:worker_threads');
try {
  new Worker('0;', { eval: true, ...${options} });
  console.log('started');
} catch (err) {
  console.log('refused ' + err.code);
}
setTimeout(() => process.exit(0), 200);
`);
    expect(firstOf(notes, 'worker-created')?.escape).toMatch(/replaces the environment/);
    expect(out).toContain('refused EPERM');
    expect(out).not.toContain('started');
  });

  it.each([
    ['nothing set', ''],
    ['only execArgv dropped', ', execArgv: []'],
    ['the shared environment named explicitly', ', env: require("node:worker_threads").SHARE_ENV'],
    ['an environment that still carries the reporter', ', env: { NODE_OPTIONS: process.env.NODE_OPTIONS }'],
  ])('is allowed with %s, and is screened', async (_label, extra) => {
    const { out } = await under(`'use strict';
const { Worker } = require('node:worker_threads');
const w = new Worker("console.log('worker listen is ' + (require('node:net').Server.prototype.listen.name || '(anon)'));", { eval: true${extra} });
w.on('exit', () => process.exit(0));
`);
    expect(out).toContain('worker listen is patchstackVerifyListen');
  });

  it('refuses a replacement NODE_OPTIONS value that merely contains the reporter path', async () => {
    // Presence as a substring is not a preload. The exact propagated value must survive replacement.
    const { notes, out } = await under(`'use strict';
const { Worker } = require('node:worker_threads');
const misleading = process.env.NODE_OPTIONS.replace(/"$/, '.missing"');
try {
  new Worker('0;', { eval: true, env: { NODE_OPTIONS: misleading } });
  console.log('started');
} catch (err) {
  console.log('refused ' + err.code);
}
setTimeout(() => process.exit(0), 200);
`);
    expect(firstOf(notes, 'worker-created')?.escape).toMatch(/replaces the environment/);
    expect(out).toContain('refused EPERM');
    expect(out).not.toContain('started');
  });

  it('confirms a worker really does load the reporter without a way to report', async () => {
    // The premise of the case above, stated on its own: the containment is there and the channel is not.
    const { out } = await under(`'use strict';
const { Worker } = require('node:worker_threads');
const worker = new Worker("require('node:http').createServer().listen(3000, () => { console.log('worker send=' + typeof process.send); process.exit(0); });", { eval: true });
worker.on('exit', () => process.exit(0));
`);
    expect(out).toContain('worker send=undefined');
  });

  it('does not run a child-process call it observed', async () => {
    const { out } = await under(`'use strict';
try { require('node:child_process').spawnSync(process.execPath, ['-e', 'console.log("grandchild ran")'], { encoding: 'utf8' }); }
catch (err) { console.log('refused ' + err.code); }
`);
    expect(out).toContain('refused EPERM');
    expect(out).not.toContain('grandchild ran');
  });
});

describe('closing discovery', SLOW, () => {
  it('acknowledges freeze only after a listen already admitted has reported', async () => {
    const { notes } = await under(`'use strict';
const server = require('node:http').createServer((req, res) => res.end('x'));
const emit = server.emit;
server.emit = function (event, ...args) {
  if (event === 'listening') {
    setTimeout(() => emit.call(this, event, ...args), 150);
    return true;
  }
  return emit.call(this, event, ...args);
};
server.listen(0);
process.emit('message', { patchstackVerify: 'freeze' });
setTimeout(() => process.exit(0), 400);
`);
    const kinds = notes.map((note) => note.patchstackVerify);
    expect(kinds.indexOf('listener')).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('frozen')).toBeGreaterThan(kinds.indexOf('listener'));
  });
});

describe('what it says about itself', SLOW, () => {
  it('reports that it loaded, with the process it loaded into', async () => {
    const { notes, out } = await under(`'use strict';
console.log('pid=' + process.pid);
`);
    const ready = firstOf(notes, 'ready');
    expect(ready).toBeDefined();
    expect(out).toContain(`pid=${ready!.pid}`);
  });
});
