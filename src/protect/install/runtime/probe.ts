// `protect --check --runtime`: start the app, send one request per HTTP listener it opens, and report
// whether that request reached the scaffolded guard seam.
//
// Every other wiring check reads the app's source. This one is the only check that can say a request
// arrived — and it is opt-in for a reason, because answering it means running the application.
//
// What a proven result says, and the only wording for it: runtime traversal reached the scaffolded guard
// seam. Not that rules were delivered, not that the deployed app is wired, and not that ordinary traffic
// is blocked.
//
// ## What it answers for, exactly
//
// One process: the entry this started. Its listeners are moved to an ephemeral loopback port, one that
// cannot be probed is stopped from binding, and each one that binds is asked. An attempt to start another
// process is refused: a child can daemonize after launch, so its reachability cannot be established from
// launch options and a process-group kill alone.
//
// An app that attempts to start ANOTHER process gets `unavailable`, whatever that process is. A worker
// THREAD is also `unavailable`: it loads the reporter, but a worker has no `process.send`, so its listener
// reports cannot leave it.
//
// Discovery is a window, and it is frozen when it closes. The set of listeners the probes are drawn from
// is the set observed before that moment; anything the app reports afterwards — a second listener while
// the first is still being asked, a process started late — cannot join a set already being answered
// from, so it makes the run `unavailable` instead.
//
// Closing that window is a handshake, not a moment in this process's own timeline. A listener that opens
// as the last response finishes has already sent its report, and that report can still be in the pipe
// while the promise chain here runs to its answer — so the app is asked to stop, and its confirmation is
// what proves the pipe is empty, because IPC is ordered. A run that gets no confirmation says it could
// not tell rather than passing.
//
// The inherited `NODE_OPTIONS` is part of what this can answer for. Node parses it ahead of the command
// line, so a `--require` sitting in the environment would run before the reporter and could open a
// listener nothing screened; such a value makes the run `unavailable` before anything is launched.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { fileURLToPath } from 'node:url';

import { classifyNodeOptions } from '../node-flags.js';

/** Long enough that nothing in the app can guess it, short enough to sit in an environment variable. */
const CHALLENGE_BYTES = 32;

/**
 * The two names the seam and this harness have to agree on, restated here rather than imported: the
 * seam is edge-safe runtime JavaScript and this is the CLI's TypeScript. A test asserts they match.
 */
export const VERIFY_HEADER_NAME = 'x-patchstack-verify';
export const CHALLENGE_ENV = 'PATCHSTACK_VERIFY_CHALLENGE';

/** How long to wait for the app to open its listeners, restarted whenever a new one appears. */
const SETTLE_MS = 1_500;

/** The whole run: startup, settling, every request, and cleanup. Not a per-phase budget. */
const RUN_MS = 20_000;

/** The most any single request may take, still bounded by whatever is left of the run. */
const PROBE_MS = 5_000;

/**
 * How long to wait for the app to confirm it has stopped reporting.
 *
 * The confirmation is what makes the final read of what the app opened trustworthy, so a run that does
 * not get one does not pass — it reports that it could not tell. Still bounded by the run's deadline.
 */
const FREEZE_MS = 500;

/** Retained child output, per stream. Draining continues past this; only the kept portion is bounded. */
const OUTPUT_LIMIT = 4_096;

/**
 * Kept past the bound, then thrown away after redaction.
 *
 * The challenge and its answer are 64 characters each. Bounding the text first and redacting second
 * would leave the first half of a value that straddles the bound sitting in output this promises not to
 * carry, so the overlap is retained long enough to match against and dropped again afterwards.
 */
const REDACTION_OVERLAP = 256;

/**
 * How much of a listener's answer is read.
 *
 * The answer is a 64-character digest, so this is generous. It exists because the thing being read is an
 * unverified application: a listener that streams without end must not be able to grow this process.
 */
const ANSWER_LIMIT = 8_192;

/** The only address a verification may leave the app reachable on. */
const LOOPBACK = ['127.0.0.1', '::1'];

/**
 * Signals that mean this command is ending, and the app it started has to end with it.
 *
 * Ctrl-C, a `kill`, and a closed terminal. `SIGKILL` is not here because it cannot be: a parent killed
 * outright runs nothing, which is why the child is also bounded by the run's own deadline.
 */
const ENDING_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

export type ListenerOutcome = 'traversed' | 'answered-without-sentinel' | 'unreachable';

export interface ListenerResult {
  scheme: 'http' | 'https';
  /** The address actually bound, as the app process reported it. */
  host: string;
  port: number;
  outcome: ListenerOutcome;
  detail?: string;
}

export interface RuntimeProbeResult {
  /** `proven` only when every observed listener traversed; see `verdictOf`. */
  outcome: 'proven' | 'not-traversed' | 'unavailable';
  /** Why the run could not answer, when it could not. */
  reason?: string;
  /** One entry per HTTP(S) listener observed while starting up. */
  listeners: ListenerResult[];
  /** Bounded, and stripped of the challenge and its answer. Not otherwise sanitised. */
  output: string;
  /**
   * The process this started, when it started one.
   *
   * Reported because it is a fact about what the check DID, and the only way for a caller — or a test —
   * to confirm afterwards that nothing it launched survived it.
   */
  pid?: number;
}

export interface ProbeOptions {
  cwd: string;
  /** The entry to run. The caller decides it is directly loadable; this runs whatever it is given. */
  entry: string;
  /** Node flags the project's own start script carries, passed through unchanged. */
  nodeArgs?: string[];
  /** Arguments the start script passes to the app, passed through unchanged. */
  appArgs?: string[];
  /** The whole run's budget, cleanup included. */
  timeoutMs?: number;
  settleMs?: number;
  /** For tests: the platform to answer for, defaulting to this one. */
  platform?: string;
  /** For tests: the reporter to preload, defaulting to the one shipped beside this file. */
  preload?: string;
}

/**
 * The answer a seam derives from the challenge.
 *
 * Computed here with `node:crypto` because the seam's own copy runs in the edge-safe graph and uses web
 * crypto. Two implementations of one format, so a test asserts they agree — drift between them would
 * read as an app that never traversed.
 */
export function expectedAnswerFor(challenge: string): string {
  return createHash('sha256').update(`patchstack-verify:${challenge}`).digest('hex');
}

/** Where the preload lives, in a build and in this repository. */
export function preloadPath(): string | null {
  const candidates = [
    new URL('./protect/runtime/report-listeners.cjs', import.meta.url), // beside the built CLI
    new URL('./report-listeners.cjs', import.meta.url), // beside this file, in the repository
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) return path;
  }

  return null;
}

export type NodeOptionsPropagation = { kind: 'options'; value: string } | { kind: 'unavailable'; reason: string };

/**
 * `NODE_OPTIONS` carrying the reporter, so the entry loads it before inherited options and a worker
 * using the process environment loads it too.
 *
 * Three things have to hold, and where one does not the run declines rather than launching with weaker
 * containment than it claims.
 *
 * The reporter has to be nameable. The value is space-separated and double-quote-aware, which a path
 * with a space needs and a path with a double quote cannot survive.
 *
 * Anything already in the environment has to be a flag this recognises. Node parses `NODE_OPTIONS`
 * ahead of the command line, so an inherited `--require` or `--import` loads before the reporter does
 * and sees `net.Server.prototype.listen` as the app's own code would — the one window the start-script
 * reader refuses a preload in order to close.
 *
 * The reporter goes FIRST. Order within the value is order of execution, and a recognised flag that
 * follows the reporter cannot undo it.
 */
export function propagatedNodeOptions(preload: string, existing: string | undefined): NodeOptionsPropagation {
  if (preload.includes('"')) {
    return {
      kind: 'unavailable',
      reason: 'the path to the listener reporter contains a double quote, which NODE_OPTIONS cannot carry — so a worker thread could not inherit the listener containment',
    };
  }
  const ours = `--require "${preload}"`;
  if (existing === undefined || existing.trim() === '') return { kind: 'options', value: ours };

  const verdict = classifyNodeOptions(existing);

  return verdict.kind === 'refused' ? { kind: 'unavailable', reason: verdict.why } : { kind: 'options', value: `${ours} ${existing}` };
}

/** Bounded, and with the verification values removed. Nothing else about it is claimed. */
function keptOutput(chunks: string[], challenge: string, answer: string): string {
  const text = chunks.join('').split(challenge).join('<challenge>').split(answer).join('<answer>');

  return text.slice(0, OUTPUT_LIMIT);
}

/** Ask one listener, and say what came back. */
async function askListener(
  listener: { scheme: 'http' | 'https'; host: string; port: number },
  challenge: string,
  answer: string,
  budgetMs: number,
): Promise<ListenerResult> {
  if (budgetMs <= 0) {
    return { ...listener, outcome: 'unreachable', detail: 'the run ran out of time before it could be asked' };
  }
  const send = listener.scheme === 'https' ? httpsRequest : httpRequest;
  const options: Record<string, unknown> = {
    host: listener.host,
    port: listener.port,
    path: '/',
    method: 'GET',
    headers: { [VERIFY_HEADER_NAME]: challenge },
    timeout: budgetMs,
  };
  // Scoped to this request alone: a loopback listener the app just created has whatever certificate it
  // has, and a process-wide switch would change what the app and this CLI trust for everything else.
  if (listener.scheme === 'https') options.agent = new HttpsAgent({ rejectUnauthorized: false });

  return new Promise((resolve) => {
    const req = send(options as never, (res) => {
      const body: Buffer[] = [];
      let read = 0;
      res.on('data', (chunk: Buffer) => {
        read += chunk.length;
        if (read <= ANSWER_LIMIT) {
          body.push(chunk);
          return;
        }
        // Past the budget the answer cannot be the digest whatever else arrives, so stop reading.
        res.destroy();
      });
      const finish = () => {
        const text = Buffer.concat(body).toString('utf8').trim();
        resolve({
          ...listener,
          outcome: text === answer ? 'traversed' : 'answered-without-sentinel',
          detail: text === answer ? undefined : `answered with ${res.statusCode ?? '?'} and no sentinel`,
        });
      };
      res.on('end', finish);
      res.on('close', finish); // a body this stopped reading ends here rather than at `end`
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => resolve({ ...listener, outcome: 'unreachable', detail: (err as Error).message }));
    req.end();
  });
}

/**
 * The aggregate, in order: anything unavailable outranks a failure, and a failure outranks a pass.
 *
 * No listener observed is `unavailable`, not a pass: nothing observed is nothing proven.
 */
export function verdictOf(listeners: ListenerResult[]): 'proven' | 'not-traversed' | 'unavailable' {
  if (listeners.length === 0 || listeners.some((l) => l.outcome === 'unreachable')) return 'unavailable';
  if (listeners.some((l) => l.outcome === 'answered-without-sentinel')) return 'not-traversed';

  return 'proven';
}

/**
 * Kill the entry's process group, once, and stay killed.
 *
 * The entry is launched as the leader of a dedicated group, so the cleanup target does not depend on a
 * later read of the process tree. Idempotent because this is called from the normal path, from `finally`,
 * and from signal and exit handlers, which can happen in any order.
 */
function terminator(child: ChildProcess): () => void {
  let done = false;

  return () => {
    if (done) return;
    done = true;
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
  };
}

export async function probeRuntimeTraversal(options: ProbeOptions): Promise<RuntimeProbeResult> {
  const platform = options.platform ?? process.platform;
  const challenge = randomBytes(CHALLENGE_BYTES).toString('hex');
  const answer = expectedAnswerFor(challenge);
  const nothing = (reason: string): RuntimeProbeResult => ({ outcome: 'unavailable', reason, listeners: [], output: '' });

  // Before launching, not after: without a way to kill a process tree, a run that times out can leave
  // the application running — and a server left behind by a verification command is worse than an
  // unanswered question.
  if (platform === 'win32') return nothing('process-tree cleanup is not implemented on Windows');

  const preload = options.preload ?? preloadPath();
  if (preload === null) return nothing('the listener reporter is missing from this installation');

  const deadline = Date.now() + (options.timeoutMs ?? RUN_MS);
  const remaining = () => Math.max(0, deadline - Date.now());

  // Before launching, like the platform check: containment the run cannot guarantee is not something to
  // discover after the app is already running.
  const propagation = propagatedNodeOptions(preload, process.env.NODE_OPTIONS);
  if (propagation.kind === 'unavailable') return nothing(propagation.reason);

  let detachMessages = (): void => {};
  const child = spawn(process.execPath, [...(options.nodeArgs ?? []), '--require', preload, options.entry, ...(options.appArgs ?? [])], {
    cwd: options.cwd,
    detached: true, // its own process group, so cleanup has one stable target
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    // The app's own environment, plus the challenge and the propagated reporter. `NODE_ENV` is
    // deliberately left alone: choosing one here would change which code path the app takes, and the
    // point is to verify the app as it is.
    env: {
      ...process.env,
      [CHALLENGE_ENV]: challenge,
      // Replaced rather than added to: what may be inherited was decided above, and the reporter is
      // first in the value that goes out.
      NODE_OPTIONS: propagation.value,
    },
  });

  const terminate = terminator(child);
  // Installed now, immediately after the spawn: between here and the end of this function the child is a
  // detached process group that outlives an interrupted parent. Ctrl-C, a `kill`, a closed terminal, an
  // exception in this function and an ordinary return must all reach the same cleanup. They are removed
  // again once it has run, so a session that verifies twice accumulates nothing.
  const onSignal = (signal: NodeJS.Signals) => {
    terminate();
    detachHandlers();
    // Whether anyone else is listening, which decides whether re-sending is safe.
    //
    // Counting is only meaningful because this handler is PREPENDED below and so runs before any of
    // them: a handler the caller registered with `once` removes itself as it runs, and had it gone
    // first this count would read zero whether nobody was listening or somebody was and has already
    // dealt with the signal.
    //
    // With nobody else listening, removing ours restores the default disposition and re-sending ends
    // this process the way the signal would have if nothing here had listened for it. With another
    // listener present there is no default to restore and it owns what happens next, so re-sending
    // would either call it a second time or kill a process it meant to keep alive.
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  const onExit = () => terminate();
  const detachHandlers = () => {
    for (const signal of ENDING_SIGNALS) process.removeListener(signal, onSignal);
    process.removeListener('exit', onExit);
  };
  // Prepended, so cleanup happens before the caller's own handler runs and so the count above sees
  // every listener that is going to participate in this signal.
  for (const signal of ENDING_SIGNALS) process.prependListener(signal, onSignal);
  process.on('exit', onExit);

  try {
    const chunks: string[] = [];
    let kept = 0;
    const drain = (stream: NodeJS.ReadableStream | null) => {
      // Drained for the life of the child whether or not anything is kept: a full pipe stops the app
      // starting, which would read as a timeout this verifier caused.
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        if (kept < OUTPUT_LIMIT + REDACTION_OVERLAP) {
          chunks.push(chunk);
          kept += chunk.length;
        }
      });
    };
    drain(child.stdout);
    drain(child.stderr);

    const observed: Array<{ scheme: 'http' | 'https'; host: string; port: number }> = [];
    const unsupported: string[] = [];
    const created: string[] = [];
    const workers: string[] = [];
    const late: string[] = [];
    const escaped: string[] = [];
    let loaded = false;
    let startFailure: string | null = null;
    let exitHow: string | null = null;
    // Open while listeners may still join the set the probes are drawn from, and false the moment that
    // set is answered from. Nothing reported after it closes can be part of the answer.
    let discovering = true;
    let onFrozen: (() => void) | null = null;

    /**
     * Ask the app to stop reporting, and wait for it to say it has.
     *
     * Returns whether it confirmed. IPC is ordered, so the confirmation is proof that every report sent
     * before it has been delivered and handled here — which is the only thing that makes the final read
     * of `late` mean anything. Without it, a listener that opened as the last response finished is a
     * message still in the pipe when this forms a verdict.
     */
    const freeze = async (): Promise<boolean> => {
      if (!child.connected) return false;

      return new Promise<boolean>((resolve) => {
        const settle = (confirmed: boolean) => {
          clearTimeout(timer);
          onFrozen = null;
          child.removeListener('exit', onGone);
          resolve(confirmed);
        };
        const onGone = () => settle(false);
        const timer = setTimeout(() => settle(false), Math.min(FREEZE_MS, remaining()));
        onFrozen = () => settle(true);
        child.once('exit', onGone);
        try {
          child.send({ patchstackVerify: 'freeze' });
        } catch {
          settle(false); // the channel is gone, so nothing more can arrive over it either
        }
      });
    };

    await new Promise<void>((resolve) => {
      let settleTimer: NodeJS.Timeout | null = null;
      const done = () => {
        discovering = false;
        clearTimeout(runTimer);
        if (settleTimer) clearTimeout(settleTimer);
        resolve();
      };
      // Through `done` as well, so the overall deadline leaves no pending settling timer behind holding
      // the event loop open after the answer is already known.
      const runTimer = setTimeout(done, remaining());
      const settle = () => {
        if (settleTimer) clearTimeout(settleTimer);
        // Never past the run's deadline: settling is a way to finish EARLY, not an extension.
        settleTimer = setTimeout(done, Math.min(options.settleMs ?? SETTLE_MS, remaining()));
      };

      const onMessage = (message: unknown) => {
        const note = message as {
          patchstackVerify?: string;
          scheme?: string;
          host?: string;
          port?: number;
          why?: string;
          via?: string;
          what?: string;
          node?: boolean;
          escape?: string;
        };
        if (note?.patchstackVerify === 'frozen') {
          onFrozen?.();

          return;
        }
        if (note?.patchstackVerify === 'process-created' && typeof note.escape === 'string') escaped.push(`${note.what ?? 'a process'} ${note.escape}`);
        if (note?.patchstackVerify === 'worker-created' && typeof note.escape === 'string') escaped.push(`a worker thread that ${note.escape}`);
        if (!discovering) {
          // Discovery is closed and this arrived after it. Pushing it into the observed set would add to
          // an array the probes are already being run over, and dropping it would let something nobody
          // asked stand behind a pass. Recorded, and the run declines below.
          const kind = note?.patchstackVerify;
          if (kind === 'listener') late.push(`an ${note.scheme === 'https' ? 'HTTPS' : 'HTTP'} listener on port ${Number(note.port)}`);
          else if (kind === 'unsupported-listener') late.push(`a listener this cannot probe (${note.why ?? 'an unsupported transport'})`);
          else if (kind === 'process-created') late.push(`another process (${note.what ?? 'a process'} via ${note.via ?? 'child_process'})`);
          else if (kind === 'worker-created') late.push(`a worker thread (${note.what ?? 'a worker'})`);

          return;
        }
        if (note?.patchstackVerify === 'listener' && (note.scheme === 'http' || note.scheme === 'https')) {
          observed.push({ scheme: note.scheme, host: String(note.host), port: Number(note.port) });
          settle(); // a newly observed listener restarts the interval
        }
        if (note?.patchstackVerify === 'unsupported-listener') {
          // Discovery ends here. The run cannot speak for the whole app once a listener was refused, and
          // the app is stopped rather than left to carry on being started for an answer nobody will get.
          unsupported.push(note.why ?? 'an unsupported transport');
          done();
        }
        if (note?.patchstackVerify === 'process-created') {
          // Discovery ends here too. The reporter refuses process creation, because a launch cannot be
          // proven to remain inside the process group this run can clean up.
          created.push(
            `${note.what ?? 'a process'} (via ${note.via ?? 'child_process'})${note.node === true ? '' : ', which the listener reporter cannot reach'}`,
          );
          done();
        }
        if (note?.patchstackVerify === 'worker-created') {
          // Discovery ends here too, and for the containment reason rather than a reachability one: a
          // worker loads the reporter and its listeners are moved to loopback, but a worker has no
          // `process.send`, so a listener it opens can be neither counted nor asked.
          workers.push(note.what ?? 'a worker');
          done();
        }
        // `ready` starts nothing. It only distinguishes a reporter that never loaded from an app that
        // never listened — an app that takes seconds to boot must be bounded by the overall deadline,
        // not by an interval that started before it had opened anything.
        if (note?.patchstackVerify === 'ready') loaded = true;
      };
      child.on('message', onMessage);
      detachMessages = () => child.removeListener('message', onMessage);
      child.on('error', (err) => {
        startFailure = `the app could not be started (${err.message})`;
        done();
      });
      child.on('exit', (code, signal) => {
        // Only HOW it exited is recorded here. What that means — never listened, or listened and was gone
        // before it could be asked — depends on what had been observed by the end of the run, and the
        // exit can be delivered before the listener report that preceded it.
        exitHow = signal ?? `code ${code}`;
        done();
      });
    });

    // A listener on any other address is one this verification put on an interface it must not have. It
    // is not probed and it is not a finding about the guard: the run declines to answer.
    const offLoopback = observed.filter((l) => !LOOPBACK.includes(l.host));

    // Nothing is probed once any listener was refused, the app attempted another process or worker, or a
    // listener turned out to be off-loopback: each means the run cannot speak for the whole app, and
    // asking the rest would produce a partial pass that reads like a whole one.
    const contained = unsupported.length === 0 && created.length === 0 && workers.length === 0 && offLoopback.length === 0;
    const listeners = contained ? await Promise.all(observed.map((l) => askListener(l, challenge, answer, Math.min(PROBE_MS, remaining())))) : [];

    // Only now is what the app opened knowable. Everything below reads sets this can no longer change.
    const confirmed = await freeze();

    const output = keptOutput(chunks, challenge, answer);
    const pid = child.pid;
    const exitNote =
      startFailure ??
      (exitHow === null
        ? null
        : observed.length === 0
          ? `the app exited before it listened (${exitHow})`
          : `the app exited while it was being probed (${exitHow})`);

    if (escaped.length > 0) {
      return {
        outcome: 'unavailable',
        reason: `the app tried to start something outside this run's one-process scope, and it was refused: ${escaped.join('; ')}`,
        listeners: [],
        output,
        pid,
      };
    }
    if (unsupported.length > 0) {
      return { outcome: 'unavailable', reason: `a listener this cannot probe: ${unsupported.join('; ')}`, listeners: [], output, pid };
    }
    if (created.length > 0) {
      return {
        outcome: 'unavailable',
        reason: `the app attempted to start another process, so this run cannot answer for the whole app: ${created.join('; ')}`,
        listeners: [],
        output,
        pid,
      };
    }
    if (workers.length > 0) {
      return {
        outcome: 'unavailable',
        reason: `the app started a worker thread, whose listeners cannot report back to this run: ${workers.join('; ')}`,
        listeners: [],
        output,
        pid,
      };
    }
    if (offLoopback.length > 0) {
      return {
        outcome: 'unavailable',
        reason: `a listener bound an address this verification must not open: ${offLoopback.map((l) => l.host).join('; ')}`,
        listeners: [],
        output,
        pid,
      };
    }
    // Checked after the probes and after the app confirmed it had stopped, because these are the
    // refusals that can arrive DURING the probing.
    if (late.length > 0) {
      return {
        outcome: 'unavailable',
        reason: `the app was still opening things after discovery had ended, so this run cannot answer for the whole app: ${late.join('; ')}`,
        listeners: [],
        output,
        pid,
      };
    }
    if (observed.length === 0) {
      if (exitNote !== null) return { outcome: 'unavailable', reason: exitNote, listeners: [], output, pid };
      if (!loaded) {
        return { outcome: 'unavailable', reason: 'the listener reporter did not load in the app process', listeners: [], output, pid };
      }

      return { outcome: 'unavailable', reason: 'no HTTP listener was observed while starting up', listeners: [], output, pid };
    }

    // A pass is the one answer the confirmation is load-bearing for. Every other outcome rests on
    // something already observed, and an undelivered report could only ever have made it worse — but a
    // pass is a claim that nothing else was open, which is exactly what an undrained channel cannot
    // support.
    //
    // Two things count as settling the question instead. The reporter never loading is its own finding
    // above. And an app that has EXITED cannot still be holding a listener nobody asked about, which is
    // the whole thing the confirmation establishes — an exit ends the question rather than leaving it
    // open, so it is not treated as a missing answer.
    const unconfirmed = !confirmed && loaded && exitHow === null;
    const outcome = unconfirmed && verdictOf(listeners) === 'proven' ? 'unavailable' : verdictOf(listeners);

    // An unavailable verdict always says why. "Could not be established" with no cause is a line people
    // learn to scroll past, and the exit code it produces is the one that most needs reading.
    const reason =
      outcome === 'unavailable'
        ? (exitNote ??
          (unconfirmed
            ? 'the app never confirmed it had stopped opening listeners, so one it opened last cannot be ruled out'
            : (listeners.find((l) => l.outcome === 'unreachable')?.detail ?? 'a listener could not be reached')))
        : undefined;

    return { outcome, reason, listeners, output, pid };
  } finally {
    terminate();
    detachHandlers();
    detachMessages();
  }
}
