// Preloaded into the verification child by `protect --check --runtime`, before the app's own entry.
//
// It answers what the parent cannot see for itself: which HTTP listeners does starting this app produce,
// on what address, and did this app attempt to start another process. It also contains the run: a
// probeable listener is moved to loopback, an unsupported listener is stopped from binding, and another
// process is refused before launch. The child exists only because the verifier started it, so a server
// or process it leaves behind would be the verifier's doing.
//
// The scope of that containment is one process. Every attempt to start another process is refused. A
// child can replace its environment, create a process group in its launch options, or daemonize after it
// starts; the parent cannot establish from the call that its reporter and group kill will still reach
// the resulting process. The runtime check already has to decline when another process is involved, so
// it does not start one it cannot safely leave behind.
//
// A worker THREAD does load this file, and its listeners are moved to loopback like any other, but a
// worker has no `process.send`, so its reports cannot leave it. Containment holds and observation does
// not — which would make a pass drawn from the main thread's listeners a pass for part of an app. So
// worker creation is reported and the run declines. A worker given a replacement `env` does not load
// this file at all (a worker's `execArgv` does not carry a preload, so `NODE_OPTIONS` is the only route
// in), and is refused rather than allowed to bind outside the reporter.
//
// What is reported is bounded and names no content. An argument to one of these calls can be a whole
// shell command line, and a startup command commonly carries a token or a password; a verifier that
// copied one into its own diagnostics would put a secret in terminal or CI output that the app never
// printed itself. So a launch is described by its launcher and the basename of its executable, and a
// form whose argument is a command line is described by the fact that it is one.
//
// Reported over IPC rather than stdout: the app owns stdout, and a report that has to be parsed out of
// arbitrary application output is a report that breaks the first time an app prints something similar.
'use strict';

const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const childProcess = require('node:child_process');
const workerThreads = require('node:worker_threads');
const { basename } = require('node:path');

const LOOPBACK = '127.0.0.1';

/**
 * Set once the parent says it has stopped listening.
 *
 * After this point a report would not be read, so a listener is refused rather than bound: a listener
 * nobody is going to ask about must not exist, and the parent is about to end this process anyway.
 */
let frozen = false;

function report(message) {
  try {
    if (typeof process.send === 'function') process.send(message);
  } catch {
    // The channel is the parent's to keep open. If it is gone there is nothing to tell and nothing to do
    // about it, and this must not be what breaks the app it was preloaded into.
  }
}

/**
 * What transport a `listen()` call asks for, read from the ARGUMENTS.
 *
 * The call decides this, not the class of the server: an `http.Server` listening on a Unix path or a
 * file descriptor is not a TCP listener, and rewriting it to one would run a different program than the
 * app. So the arguments are classified first, and the class is consulted only for a TCP listen.
 *
 * @returns {{ kind: 'tcp' } | { kind: 'unsupported', why: string }}
 */
function transportOf(args) {
  const [first] = args;

  const validPort = (value) => {
    if (typeof value !== 'number' && typeof value !== 'string') return false;
    if (typeof value === 'string' && value.trim() === '') return false;
    const number = Number(value);

    return Number.isInteger(number) && number >= 0 && number <= 0xffff;
  };

  // Node's rule (`isPipeName` in `net`): a string is a path only when it is not a non-negative
  // number. `'3000'`, `' 3000'` and `'3e3'` are all TCP port 3000 — which is also what
  // `listen(process.env.PORT)` normally hands over.
  if (typeof first === 'string') {
    if (Number(first) < 0 || Number.isNaN(Number(first))) return { kind: 'unsupported', why: 'a Unix socket path' };

    return validPort(first) ? { kind: 'tcp' } : { kind: 'unsupported', why: 'an invalid TCP port' };
  }
  if (typeof first === 'number') return validPort(first) ? { kind: 'tcp' } : { kind: 'unsupported', why: 'an invalid TCP port' };

  if (first && typeof first === 'object') {
    // This is Node's precedence: a brought handle, then a usable fd, then a port, then a path. Reading
    // `path` first would refuse `{ path, port }` even though Node uses its port; reading `port` before a
    // handle would rewrite an options object whose connection Node takes from somewhere else.
    if (first._handle || first.handle) return { kind: 'unsupported', why: 'a handle' };
    if (typeof first.fd === 'number' && first.fd >= 0) return { kind: 'unsupported', why: 'a file descriptor' };

    const hasPort = 'port' in first;
    const port = (hasPort && (first.port === undefined || first.port === null)) ? 0 : first.port;
    if (typeof port === 'number' || typeof port === 'string') {
      return validPort(port) ? { kind: 'tcp' } : { kind: 'unsupported', why: 'an invalid TCP port' };
    }
    if (typeof first.path === 'string' && (Number(first.path) < 0 || Number.isNaN(Number(first.path)))) {
      return { kind: 'unsupported', why: 'a Unix socket path' };
    }

    return { kind: 'unsupported', why: 'invalid listen options' };
  }
  if (first === undefined || first === null || typeof first === 'function') return { kind: 'tcp' }; // `listen()` / `listen(null)` / `listen(cb)`

  return { kind: 'unsupported', why: `an argument of type ${typeof first}` };
}

/**
 * The scheme a server serves, or null when it is not one this can probe.
 *
 * HTTP/2 is not one: a cleartext `Http2Server` is a `net.Server` and not an `http.Server`, and a secure
 * one extends `tls.Server` rather than `https.Server`, so neither matches — which is the right answer,
 * because an HTTP/1 request is not how you ask an h2 server anything.
 */
function schemeOf(server) {
  if (server instanceof https.Server) return 'https';
  if (server instanceof http.Server) return 'http';

  return null;
}

/**
 * Rewrite a TCP listen to an ephemeral loopback port, preserving the overload.
 *
 * Two changes, both load-bearing. The PORT becomes ephemeral because the app's own port may already be
 * held by whatever the developer is running, and a verification that fails on EADDRINUSE says nothing
 * about wiring. The HOST becomes loopback because a verification must not put the app on an address
 * other machines can reach; the parent checks the address that was actually bound and refuses anything
 * else, so this rewrite is stated rather than trusted.
 */
function onLoopback(args) {
  const [first, ...rest] = args;

  if (first === undefined || typeof first === 'function') return [{ port: 0, host: LOOPBACK }, ...args];
  if (typeof first === 'number' || typeof first === 'string') {
    // `listen(port[, host][, backlog][, cb])`: the host, if any, is replaced; anything after it that is
    // not a host is kept.
    const tail = rest.filter((a) => typeof a !== 'string');

    return [{ port: 0, host: LOOPBACK }, ...tail];
  }

  return [{ ...first, port: 0, host: LOOPBACK }, ...rest];
}

const originalListen = net.Server.prototype.listen;
let pendingListens = 0;
let freezeAcknowledged = false;

/** A freeze is acknowledged only after every listen already admitted has either reported or failed. */
function acknowledgeFreeze() {
  if (!frozen || pendingListens !== 0 || freezeAcknowledged) return;
  freezeAcknowledged = true;
  report({ patchstackVerify: 'frozen' });
}

net.Server.prototype.listen = function patchstackVerifyListen(...args) {
  const transport = transportOf(args);
  const scheme = schemeOf(this);

  if (transport.kind === 'unsupported' || scheme === null || frozen) {
    const why = frozen
      ? 'opens after the verification stopped reading reports'
      : transport.kind === 'unsupported'
        ? `listens on ${transport.why}`
        : `is not an HTTP or HTTPS server (${this?.constructor?.name ?? 'unknown'})`;
    report({ patchstackVerify: 'unsupported-listener', why });

    // Not bound. The verification cannot speak for this listener, and leaving it to open a port while a
    // verifier holds the process would be the verifier opening it. The error is the app's to see, so it
    // arrives the way a refused bind would.
    const error = Object.assign(new Error(`Patchstack runtime verification does not support a server that ${why}`), {
      code: 'EPERM',
      syscall: 'listen',
    });
    setImmediate(() => this.emit('error', error));

    return this;
  }

  pendingListens++;
  const onListening = () => {
    const address = this.address();
    if (address && typeof address === 'object') {
      report({ patchstackVerify: 'listener', scheme, host: address.address, port: address.port });
    }
    pendingListens--;
    acknowledgeFreeze();
  };
  this.once('listening', onListening);

  let result;
  try {
    result = originalListen.apply(this, onLoopback(args));
  } catch (error) {
    this.removeListener('listening', onListening);
    pendingListens--;
    acknowledgeFreeze();
    throw error;
  }

  return result;
};

/** Bounded, so an unbounded argument cannot become an unbounded diagnostic. */
const WHAT_LIMIT = 80;

/** A launched program named by its executable alone — never by its arguments, which carry the secrets. */
function executableName(command) {
  if (typeof command !== 'string') return `a ${typeof command}`;
  const name = basename(command).replace(/\.exe$/i, '');

  return name === '' ? 'a program' : name.slice(0, WHAT_LIMIT);
}

const isNodeExecutable = (command) =>
  typeof command === 'string' && (command === process.execPath || basename(command).replace(/\.exe$/i, '') === 'node');

/**
 * Whether the call asked for a shell, which makes its command argument a command LINE.
 *
 * `exec` and `execSync` always do. Every other helper does it through `shell` in an options object, and
 * `exec` reaches `execFile` that way internally — so the option is looked for wherever it sits in the
 * argument list rather than at a fixed position. A command line is the argument most likely to carry a
 * credential and the one least possible to judge, so it is never described by its content.
 */
const shellRequested = (args) =>
  args.some((arg) => arg !== null && typeof arg === 'object' && !Array.isArray(arg) && Boolean(arg.shell));

/** Whether a replacement environment preserves the exact reporter options this process received. */
const carriesReporter = (env) => {
  try {
    return (
      env !== null &&
      typeof env === 'object' &&
      typeof process.env.NODE_OPTIONS === 'string' &&
      env.NODE_OPTIONS === process.env.NODE_OPTIONS
    );
  } catch {
    return false;
  }
};

/** Refused the way an impossible bind is: reported, and handed to the app as its own failed call. */
function refuse(what, why) {
  throw Object.assign(new Error(`Patchstack runtime verification does not start ${what} that ${why}`), { code: 'EPERM' });
}

/**
 * Report and refuse every process the app attempts to start.
 *
 * Starting another process is outside the check's one-process contract. The launch is reported and
 * refused before delegation. This is intentionally broader than inspecting `detached` and `env`: a
 * program that starts normally may create its own session after launch, beyond the process-group cleanup
 * the parent relies on.
 *
 * Two layers, because the exported helpers are not the only way in. They are wrapped for what they can
 * say — which helper was called, and whether the command is this runtime — and `ChildProcess.prototype
 * .spawn` is wrapped underneath them because every asynchronous launch goes through it however it was
 * reached: `new ChildProcess().spawn(…)` directly, `cluster.fork()`, or a helper captured as a value.
 * Because the exported wrapper refuses before it delegates, a helper produces one report. The low-level
 * wrapper covers calls that bypass the helpers entirely; the synchronous helpers do not pass through it.
 */
const PROCESS_REFUSAL = 'leaves the one-process scope of this runtime verification';

for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  if (typeof childProcess[name] !== 'function') continue;
  childProcess[name] = function patchstackVerifyLaunch(...args) {
    // `fork` always runs this runtime. For the rest the first argument is the command, unless a shell
    // was asked for, in which case it is a whole command line and cannot be judged.
    const shellForm = name === 'exec' || name === 'execSync' || shellRequested(args);
    const command = name === 'fork' ? process.execPath : args[0];
    report({
      patchstackVerify: 'process-created',
      via: name,
      what: shellForm ? 'a shell command line' : executableName(command),
      node: !shellForm && isNodeExecutable(command),
      escape: PROCESS_REFUSAL,
    });
    refuse('a process', PROCESS_REFUSAL);
  };
}

const ChildProcessClass = childProcess.ChildProcess;
if (typeof ChildProcessClass === 'function' && typeof ChildProcessClass.prototype.spawn === 'function') {
  ChildProcessClass.prototype.spawn = function patchstackVerifyChildSpawn(...args) {
    const options = args[0] && typeof args[0] === 'object' ? args[0] : {};
    report({
      patchstackVerify: 'process-created',
      via: 'ChildProcess.spawn',
      what: executableName(options.file),
      node: isNodeExecutable(options.file),
      escape: PROCESS_REFUSAL,
    });
    refuse('a process', PROCESS_REFUSAL);
  };
}

/**
 * Report every worker thread the app starts.
 *
 * Reported rather than screened, for the reason at the top of this file: a worker loads this and its
 * listeners are contained, but it has no channel back, so a listener it opens can be neither counted
 * nor asked. The name is the worker's file, or the fact that its source was given inline — the source
 * itself is the app's, and not this file's to copy anywhere.
 */
const OriginalWorker = workerThreads.Worker;
if (typeof OriginalWorker === 'function') {
  const workerName = (filename) => {
    try {
      if (typeof filename === 'string') return basename(filename).slice(0, WHAT_LIMIT) || 'a worker';
      if (filename && typeof filename.pathname === 'string') return basename(filename.pathname).slice(0, WHAT_LIMIT) || 'a worker';
    } catch {
      // A `filename` of some other shape is still a worker, and saying so is the whole report.
    }

    return 'a worker';
  };

  // Sharing the parent's environment is the default and is also stated explicitly with this symbol;
  // either way the reporter is carried in.
  const shared = workerThreads.SHARE_ENV;
  const inherits = (options) => options === null || typeof options !== 'object' || options.env === undefined || options.env === shared;

  workerThreads.Worker = class Worker extends OriginalWorker {
    constructor(filename, options) {
      const escape = inherits(options) || carriesReporter(options.env) ? null : 'replaces the environment that carries the listener reporter';
      report({
        patchstackVerify: 'worker-created',
        what: options && options.eval === true ? 'inline source' : workerName(filename),
        ...(escape === null ? {} : { escape }),
      });
      if (escape !== null) refuse('a worker thread', escape);
      super(filename, options);
    }
  };
}

/**
 * Answer the parent's freeze request, and stop letting anything new open.
 *
 * The acknowledgement is what makes the parent's final read safe. IPC is ordered, so by the time this
 * reply arrives every report sent before it has already been delivered — including one from a listener
 * that opened while the parent was still reading the last response. Nothing may bind after this point,
 * because nothing would be read.
 */
process.on('message', (message) => {
  if (message === null || typeof message !== 'object' || message.patchstackVerify !== 'freeze') return;
  frozen = true;
  acknowledgeFreeze();
});

// The channel is the parent's to hold open. Listening on it must not be what keeps an app alive that
// would otherwise have exited on its own.
if (process.channel && typeof process.channel.unref === 'function') process.channel.unref();

report({ patchstackVerify: 'ready', pid: process.pid });
