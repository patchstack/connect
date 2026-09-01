import { pulseFetch } from '../pulse-token.js';
import { clientIpFields } from './client-ip.js';
import { isSafeOrigin } from './safe-origin.js';

/**
 * Detection reporter: every rule that fired, whether or not it blocked.
 *
 * Separate from `firewall-log.js`, which posts ENFORCED blocks in the WordPress-compatible shape
 * (`fid`, `request_uri`, `ip`, `user_agent`). That path answers "what did we stop". This one answers a
 * question nothing else could: **what would this rule have stopped**, for a rule that carries
 * `enforcement: dry-run` and therefore blocks nothing.
 *
 * Without it, a rule that is quietly wrong and a rule that is protecting look identical from the
 * outside, because neither produces a block to report.
 *
 * ## The payload is deliberately small
 *
 * `rule_id`, route PATH, the parameters the rule reads, a timestamp, whether it was enforced, the phase,
 * the bundle identity, and the rule's own revision where the bundle carried one. That is enough to count
 * hits per rule, compare them against traffic, and decide whether a rule is wrong.
 *
 * It also carries the values of the parameters the matched rule NAMES, under a plan derived from that
 * rule — because counting that a rule fired is not enough to act on it. What may be captured is the
 * rule's own doing: a rule reading the whole request permits nothing, response values are never
 * captured, and raw request bytes need a reviewed opt-in on the rule. Every value is bounded in number
 * and length, and what a bound leaves out is counted, so a short list is never mistaken for a complete
 * one.
 *
 * The user agent is the one exception, and travels whether or not a rule names it: it is part of the
 * baseline, because a detection nobody can attribute is of little use.
 *
 * What it never carries: **the value of any OTHER parameter the matched rule does not name**, any
 * response value, or the query string's values. A channel that reports detections is a different thing from a
 * copy of an application's traffic, and the plan is what keeps the difference.
 *
 * The route is the request PATH; the query travels as parameter NAMES only, because `?token=…` is a
 * value and the rule that fired may never have named it.
 */

const DEFAULT_BASE_URL = 'https://api.patchstack.com/monitor/pulse';
const DEFAULT_FLUSH_MS = 5000;
const MAX_BATCH = 50;
/** Bounded so a detection storm costs memory it cannot grow out of. Oldest go first. */
const MAX_QUEUE = 500;

/**
 * Delivery bounds.
 *
 * A retry exists because the common failure is transient — a restart, a rate limit, a dropped
 * connection — and losing evidence to a five-second outage is avoidable. It is bounded because the
 * failure that is NOT transient must not turn into a loop: after `MAX_ATTEMPTS` the batch is dropped and
 * counted, which is visible, where an unbounded retry would be an app quietly spending itself on a
 * refusing endpoint.
 *
 * Only one send is ever in flight. That keeps memory bounded to the queue plus one batch, keeps the
 * retry sequence unambiguous, and means a slow endpoint applies back pressure to the queue rather than
 * to the number of open sockets.
 */
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 30_000;
/**
 * A refusal that will refuse again is terminal; these are the ones worth trying later.
 *
 * Any 5xx counts, not a chosen few. A server error is the endpoint saying the fault is its own, and
 * picking a subset would leave the rest abandoned on the first attempt while the documented contract
 * says a server error is retried — a difference nothing in the output would reveal.
 */
const RETRYABLE_EXPLICIT = new Set([408, 425, 429]);
export function worthRetrying(status) {
  if (status === null) return true; // Unreachable: nothing has said the endpoint is unwilling.

  return RETRYABLE_EXPLICIT.has(status) || (status >= 500 && status <= 599);
}

/**
 * How long one attempt may take before it is abandoned and retried.
 *
 * Only one send is in flight, so a request that never settles would hold that slot for the life of the
 * process: the queue would fill, every later event would be dropped for pressure, and the health
 * counters would show a single attempt that never failed. A hung connection has to look like a failure.
 */
const ATTEMPT_TIMEOUT_MS = 10_000;


/**
 * How long `stop()` will wait for the drain before resolving anyway.
 *
 * A shutdown that waits without a bound is a shutdown that can hang, and a host handling SIGTERM has its
 * own deadline. So the promise resolves either when nothing is outstanding or when this elapses — never
 * later. Waiting is the caller's option, not an obligation: ignoring the promise leaves the old
 * behaviour exactly as it was.
 */
const STOP_BUDGET_MS = 5_000;

/**
 * Size bounds, applied per event and per batch.
 *
 * Every field is an identifier rather than traffic, but an identifier can still be long: a route is
 * whatever the application routes, and a broad rule can read many parameters. A capped field carries
 * a `truncated` list naming what was shortened, so a reader can tell a shortened value from a complete
 * one instead of drawing conclusions from a route that looks like a different route.
 */
const MAX_ROUTE_CHARS = 256;
const MAX_PARAMETERS = 25;
const MAX_PARAMETER_CHARS = 64;
/**
 * Identifiers are capped too, and marked when capped.
 *
 * These come from the rule bundle rather than from traffic, so a long one is our own bug rather than an
 * attack — but an event has to be bounded by every field it carries, not by most of them. Marked rather
 * than silently shortened, because a shortened identifier no longer matches the rule it names and a
 * reader must not use it as a key believing it does.
 */
const MAX_IDENTIFIER_CHARS = 256;
/**
 * Bounds re-applied to captured evidence at the wire.
 *
 * Chosen so one worst-case event stays well inside `MAX_BODY_BYTES`: a batch always sends at least one
 * event, so an event that cannot fit could never be delivered at all.
 */
const MAX_CAPTURED_VALUES = 10;
const MAX_CAPTURED_VALUE_CHARS = 512;
/** Query-string parameter NAMES from the request line. Names, never values — see `queryKeysOf`. */
const MAX_QUERY_KEYS = 10;
const MAX_METHOD_CHARS = 16;
/**
 * The body bound, set where a full batch can actually reach it.
 *
 * A bound above anything the other caps allow is not a bound, it is a comment: the count and the field
 * caps together put a full batch of worst-case events over this, so the split is a path traffic reaches
 * rather than a branch nothing can enter. It is also a modest request body, which is the point — an
 * endpoint or proxy that refuses an oversized body would refuse every retry of it too.
 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * The query string's parameter names, without any of its values.
 *
 * A reviewer needs the shape of the URL that was requested, and the query is where a URL carries values.
 * Sending it verbatim would put the values of parameters the matched rule never named onto the wire —
 * exactly what the capture plan exists to prevent — so what travels is the path plus the NAMES of the
 * query parameters, which describe the request without disclosing what was in it.
 *
 * @returns {string[]}
 */
export function queryKeysOf(path) {
  if (typeof path !== 'string') return { keys: [], total: 0 };
  const start = path.indexOf('?');
  if (start === -1) return { keys: [], total: 0 };

  const seen = new Set();
  const keys = [];
  for (const pair of path.slice(start + 1).split('&')) {
    if (pair === '') continue;
    const name = pair.split('=')[0];
    if (name === '') continue;
    let decoded = name;
    try {
      decoded = decodeURIComponent(name);
    } catch {
      // A name that will not decode is reported as sent: it is still a name, and guessing is worse.
    }
    if (seen.has(decoded)) continue;
    seen.add(decoded);
    // Counted past the cap as well as under it, so a reader knows the list is short rather than complete.
    if (keys.length < MAX_QUERY_KEYS) keys.push(decoded);
  }

  return { keys, total: seen.size };
}

/**
 * Capture, bounded for the wire.
 *
 * The extractor bounds what it takes, but a parameter NAME comes from the rule and rules carry no length
 * limit — so a label alone can carry an event past the body bound, and a batch always sends at least one
 * event. This is the last gate before the wire, so it re-applies every bound rather than trusting whatever
 * produced the capture, and marks what it shortened.
 */
function boundCapture(capture) {
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) return null;

  const truncated = [];
  // Validated, not coerced. `String(x)` runs whatever `toString` an object carries, which turns a value
  // this channel refuses into reportable content — and the refusal is the whole point of the type rule.
  const plan = typeof capture.plan === 'string' ? capText(capture.plan, MAX_IDENTIFIER_CHARS) : null;
  if (plan === null) return null;
  if (plan.truncated) truncated.push('plan');

  const out = { plan: plan.value };
  let dropped = 0;

  if (Array.isArray(capture.values) && capture.values.length > 0) {
    const values = [];
    for (const entry of capture.values) {
      if (!entry || typeof entry !== 'object') {
        dropped += 1;
        continue;
      }
      const parameter = typeof entry.parameter === 'string' ? entry.parameter : null;
      const text = scalarText(entry.value);
      if (parameter === null || text === null) {
        dropped += 1;
        continue;
      }
      if (values.length >= MAX_CAPTURED_VALUES) {
        dropped += 1;
        continue;
      }

      const label = capText(parameter, MAX_PARAMETER_CHARS);
      const value = capText(text, MAX_CAPTURED_VALUE_CHARS);
      if (label.truncated && !truncated.includes('parameter')) truncated.push('parameter');
      if (value.truncated && !truncated.includes('value')) truncated.push('value');
      values.push({
        parameter: label.value,
        value: value.value,
        ...(entry.truncated === true || value.truncated ? { truncated: true } : {}),
      });
    }
    if (dropped > 0) truncated.push('values');
    if (values.length > 0) out.values = values;
  }

  if (capture.raw && typeof capture.raw === 'object' && typeof capture.raw.value === 'string') {
    const raw = capText(capture.raw.value, MAX_CAPTURED_VALUE_CHARS);
    out.raw = { value: raw.value, ...(capture.raw.truncated === true || raw.truncated ? { truncated: true } : {}) };
  }

  for (const key of ['omitted', 'unsupported', 'failed']) {
    const count = Number.isFinite(capture[key]) && capture[key] > 0 ? Math.floor(capture[key]) : 0;
    // What this gate drops is added to what the producer already left out. The documented promise is that
    // values excluded by a bound are counted, and a reader cannot otherwise tell eleven values from two
    // hundred.
    const total = key === 'omitted' ? count + dropped : count;
    if (total > 0) out[key] = total;
  }
  if (capture.unavailable === true) out.unavailable = true;
  if (truncated.length > 0) out.truncated = truncated;

  return out;
}

/** A value as text, or null when its type is not one this channel reports. */
function scalarText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);

  return null;
}

/** A per-reporter identity, so idempotency keys from two guards cannot collide. */
function makeInstanceId() {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (typeof uuid === 'string' && uuid !== '') return uuid;
  } catch {
    // A runtime without usable web crypto falls through to the counter below.
  }

  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
}

/** A field shortened to fit, and whether it had to be. */
function capText(value, limit) {
  const text = typeof value === 'string' ? value : '';

  return text.length > limit ? { value: text.slice(0, limit), truncated: true } : { value: text, truncated: false };
}

/**
 * How long to wait before attempting again.
 *
 * `Retry-After` is honoured when the endpoint sets one, because it is the endpoint saying what it can
 * take — but capped, so a header cannot park a batch indefinitely. Otherwise exponential from
 * `RETRY_BASE_MS` with jitter, so many guards retrying after one shared outage do not return in step.
 */
export function retryDelayMs(attempts, retryAfter, random = Math.random) {
  const advertised = parseRetryAfter(retryAfter);
  if (advertised !== null) return Math.min(advertised, RETRY_CAP_MS);

  const backoff = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_CAP_MS);

  // ±25%, then capped again: jitter applied to a capped value can exceed the cap, so the cap goes last.
  return Math.min(RETRY_CAP_MS, Math.round(backoff * (0.75 + random() * 0.5)));
}

function parseRetryAfter(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;

  return Math.max(0, at - Date.now());
}

const encoder = new TextEncoder();

/** The size of a string on the wire. `length` counts UTF-16 code units, which is not that. */
export function byteLength(text) {
  return encoder.encode(text).length;
}

/**
 * As many events as fit the byte bound, and the rest.
 *
 * The bound is on the REQUEST, so `wrap` builds the body that will actually be sent — envelope, drop
 * count and reporting state included — and it is measured in bytes rather than characters. Measuring the
 * events alone, or measuring `length`, both understate the request: one leaves out the envelope, the
 * other counts a multi-byte character as one. Either would let a body past the bound on the wire while
 * the check reported it as fitting.
 *
 * At least one event always goes, since a batch of none makes no progress and would meet the same bound
 * on every retry.
 */
export function splitToFit(events, maxBytes, wrap = (batch) => ({ detections: batch })) {
  const batch = events.slice();
  const rest = [];
  while (batch.length > 1 && byteLength(JSON.stringify(wrap(batch))) > maxBytes) {
    rest.unshift(batch.pop());
  }

  return [batch, rest];
}

/** A timer that cannot hold a process open: a pending retry must never be why a command does not exit. */
function unattended(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();

  return timer;
}

/**
 * The parameters a rule reads, from its own definition.
 *
 * NOT "the condition that matched": the engine reports a rule, not which of its conditions fired, and
 * threading that out would mean changing evaluation for the sake of a reporting field. A narrowly scoped
 * rule reads exactly one parameter, so the two answers coincide there; for a broad rule this is the set
 * it reads, which is what the field name says.
 *
 * @param {any} rule
 * @returns {string[]}
 */
export function ruleParameters(rule) {
  const out = new Set();
  const walk = (conditions) => {
    if (!Array.isArray(conditions)) return;
    for (const condition of conditions) {
      if (!condition || typeof condition !== 'object') continue;
      if (typeof condition.parameter === 'string' && condition.parameter !== 'rules') {
        out.add(condition.parameter);
      }
      if (Array.isArray(condition.rules)) walk(condition.rules);
    }
  };
  walk(rule?.rule_v2);

  return [...out];
}

/**
 * The rule's own revision, from the served rule.
 *
 * Read off the delivered rule rather than derived: whoever served it knows what document this is, and a
 * value computed here would be this client's opinion of it. Accepts a string or a number, because the two
 * kinds of rule that carry one number their revisions differently.
 *
 * @param {any} rule
 * @returns {string | null}
 */
export function revisionOf(rule) {
  const revision = rule?.source_revision;
  if (typeof revision === 'string' && revision !== '') return revision;
  if (typeof revision === 'number' && Number.isFinite(revision)) return String(revision);

  return null;
}

/**
 * The request path with the query string removed.
 *
 * A path is a route; a query string is data. `/api/preview?url=http://169.254.169.254/` names both the
 * endpoint and the attack payload, and only the first belongs in a counting channel.
 *
 * @param {unknown} path
 * @returns {string | null}
 */
export function routeOf(path) {
  if (typeof path !== 'string' || path === '') return null;
  const cut = path.search(/[?#]/);

  return cut === -1 ? path : path.slice(0, cut);
}

/**
 * @param {{
 *   siteUuid?: string,
 *   baseUrl?: string,
 *   pulseAuth?: unknown,
 *   rulesEtag?: string | null,
 *   fetchImpl?: typeof fetch,
 *   flushMs?: number,
 *   maxQueue?: number,
 * }} opts
 */
export function createDetectionReporter(opts) {
  const siteUuid = opts.siteUuid ?? process.env?.PATCHSTACK_SITE_UUID;
  if (!siteUuid) {
    // Nothing to report against. A no-op rather than a throw: reporting is never worth failing a boot.
    // It answers the whole interface, so a caller never has to know which kind it holds.
    return {
      record() {}, flush() {}, stop: () => Promise.resolve(), setRulesEtag() {}, announce() {}, dropped: () => 0,
      health: () => ({
        sent: 0, delivered: 0, failed: 0, dropped: 0, retried: 0, reauthorized: 0, lastDeliveredAt: null,
        capability: { announced: 0, acknowledged: 0, failed: 0, retried: 0, lastAcknowledgedAt: null },
      }),
    };
  }

  const configured = opts.baseUrl ?? process.env?.PATCHSTACK_PULSE_RULES_URL;
  const baseUrl = typeof configured === 'string' && isSafeOrigin(configured)
    ? configured.replace(/\/$/, '')
    : DEFAULT_BASE_URL;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const flushMs = Number.isFinite(opts.flushMs) && opts.flushMs > 0 ? opts.flushMs : DEFAULT_FLUSH_MS;
  const maxQueue = Number.isFinite(opts.maxQueue) && opts.maxQueue > 0 ? opts.maxQueue : MAX_QUEUE;

  // The bundle identity stamped onto each event. MUTABLE, because the guard's rules are: a refresh
  // hot-swaps the ruleset in place, and a reporter holding the boot-time value would attribute a hit
  // produced by the new bundle to the old one — sending a reviewer to a rule document that is not the
  // one that fired. Updated by the runtime only after an accepted swap (see `setRulesEtag`).
  let rulesEtag = opts.rulesEtag ?? null;

  // Delivery health. The capability declaration says a guard INTENDS to report; these say whether
  // anything arrived. Counts and one timestamp only — a clean app and a broken delivery path are
  // otherwise indistinguishable, and distinguishing them needs no request data at all.
  let sent = 0;
  let delivered = 0;
  let failed = 0;
  let droppedTotal = 0;
  /** @type {string | null} */
  let lastDeliveredAt = null;

  // Capability accounting, kept apart from the event counters above.
  //
  // The event counters are measured in EVENTS. A state announcement carries none, so letting it advance
  // `lastDeliveredAt` or `failed` produces readings that cannot describe any real delivery — `sent: 0`
  // with `failed: 1` — and makes a capability acknowledgement indistinguishable from a delivered
  // detection. They answer different questions and are counted separately.
  let capabilityAnnounced = 0;
  let capabilityAcknowledged = 0;
  let capabilityFailed = 0;
  /** @type {string | null} */
  let lastCapabilityAckAt = null;

  /** @type {Array<Record<string, unknown>>} */
  let queue = [];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let retryTimer = null;
  let stopped = false;
  let dropped = 0;
  let retried = 0;
  let capabilityRetried = 0;
  let flushRequested = false;
  let draining = false;
  /** @type {(() => void) | null} */
  let drainResolve = null;
  /** @type {Promise<void> | null} */
  let drainPromise = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let budgetTimer = null;
  /** Bumped when a drain is terminated, so a late response cannot move a counter after the fact. */
  let epoch = 0;
  let reauthorized = 0;

  // One send at a time, and one batch's worth of state while it runs.
  let sending = false;
  /**
   * @type {{
   *   key: string, events: Array<Record<string, unknown>>, dropped: number,
   *   state: string | null, attempts: number,
   * } | null}
   */
  let inFlight = null;

  /**
   * The newest reporting state not yet declared, and only the newest.
   *
   * States supersede rather than accumulate: what the platform needs is the state this guard is in now,
   * so a queue of them would deliver a history nobody asked for and end by declaring the same thing
   * anyway. A state arriving while a send runs replaces whatever was waiting, and travels with the next
   * send — attached to a batch of events when there is one, alone when there is not.
   *
   * @type {string | null}
   */
  let pendingState = null;
  const instanceId = makeInstanceId();
  let sequence = 0;

  /** Events up to the batch and byte bounds, leaving the rest queued. */
  /** The exact request body for a batch: what is measured is what is sent. */
  const bodyFor = (events, droppedWith, state) => ({
    detections: events,
    // The count of what never made it, sent WITH the batch rather than inferred from a gap: a consumer
    // computing a false-positive rate needs to know its denominator is short, and silence about that
    // would make a truncated sample look like a complete one.
    dropped: droppedWith,
    ...(state !== null ? { reporting_state: state } : {}),
  });

  const takeBatch = (droppedWith, state) => {
    const [batch, rest] = splitToFit(queue.splice(0, MAX_BATCH), MAX_BODY_BYTES, (events) =>
      bodyFor(events, droppedWith, state),
    );
    if (rest.length > 0) queue.unshift(...rest);

    return batch;
  };

  /**
   * The credential exchange's own bound: this reporter's, not the application's.
   *
   * It matches an attempt, because the exchange is a separate request that an attempt's abort signal does
   * not reach — bounded any longer, a token call would hold the single send slot past the point the
   * attempt was meant to end. It must also BE a number: the exchange builds its timeout from this value,
   * and an absent one makes that construction throw, which the exchange reports as "no token" and every
   * site-addressed endpoint then refuses.
   *
   * Deliberately not a knob. Nothing in the public options feeds a value here, so reading one would be a
   * setting a caller cannot set — always undefined, always falling through to a default.
   */
  const authConfig = { pulseAuth: opts.pulseAuth, endpoint: baseUrl, timeoutMs: ATTEMPT_TIMEOUT_MS };
  const detectionsUrl = `${baseUrl}/detections/${encodeURIComponent(siteUuid)}`;

  const post = async (body, key, signal, transport) =>
    // Through the shared Pulse path, which attaches the token and — on a 401 — discards it and retries
    // once with a fresh one. A cached token can stop being valid before it expires, and the server's
    // refusal is authoritative over our own clock; the batch's own headers, this key included, are
    // carried through both sends, so the redelivery is still recognisable as the same batch.
    pulseFetch(
      authConfig,
      detectionsUrl,
      {
        method: 'POST',
        ...(signal ? { signal } : {}),
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': '@patchstack/connect',
          // The same key on every attempt of one batch: an acknowledgement can be lost after the server
          // has already taken the batch, and a redelivery has to be identifiable as the same one.
          'Idempotency-Key': key,
        },
        body: JSON.stringify(body),
      },
      transport,
    );

  /** Give up on the batch in flight, counting what it carried. */
  const abandon = () => {
    if (!inFlight) return;
    failed += inFlight.events.length;
    if (inFlight.state !== null) capabilityFailed += 1;
    inFlight = null;
  };

  const settle = () => {
    if (!inFlight) return;
    if (inFlight.events.length > 0) {
      delivered += inFlight.events.length;
      lastDeliveredAt = new Date().toISOString();
    }
    if (inFlight.state !== null) {
      capabilityAcknowledged += 1;
      lastCapabilityAckAt = new Date().toISOString();
    }
    inFlight = null;
  };

  /**
   * One attempt at the batch in flight, then either done, retried, or given up on.
   *
   * Fail-open throughout: no path here rejects, throws into the caller, or blocks a request. A delivery
   * problem is counted and nothing more.
   */
  const attempt = async () => {
    if (!inFlight) return;
    const mine = epoch;
    sending = true;
    inFlight.attempts += 1;
    if (inFlight.attempts > 1) {
      // Counted against whatever the request carries. A state-only request carries no events, so letting
      // it advance the event counter would report retries of deliveries that never happened — the same
      // conflation the delivered/acknowledged split exists to prevent. A request carrying both counts on
      // both, because both were retried.
      if (inFlight.events.length > 0) retried += 1;
      if (inFlight.state !== null) capabilityRetried += 1;
    }

    const body = bodyFor(inFlight.events, inFlight.dropped, inFlight.state);

    let status = null;
    let retryAfter = null;
    // A hung request must look like a failure rather than holding the only send slot forever.
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    inFlight.controller = controller;
    const timeout = controller
      ? unattended(setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS))
      : null;
    // Owned by the batch, so termination can cancel it. A transport that ignores an abort would otherwise
    // leave this scheduled past the shutdown that already reported itself finished.
    inFlight.timeout = timeout;
    // The credential path may send the same batch twice: once with a token the server refuses, once with
    // a reissued one. That is a redelivery of this batch, so it is counted rather than invisible.
    let sends = 0;
    const counted = (url, init) => {
      if (String(url) === detectionsUrl) {
        sends += 1;
        // Counted as the second send is made, and only while this attempt still owns the numbers. After
        // `terminate()` the health has been reported as final, and a refresh completing later must not
        // move it.
        if (sends > 1 && mine === epoch) reauthorized += 1;
      }

      return fetchImpl(url, init);
    };
    try {
      const res = await post(body, inFlight.key, controller?.signal, counted);
      if (mine !== epoch) return; // the drain was terminated while this was open
      if (res && res.ok) {
        settle();
        if (timeout) clearTimeout(timeout);
        finish();

        return;
      }
      status = typeof res?.status === 'number' ? res.status : 0;
      retryAfter = res?.headers?.get?.('retry-after') ?? null;
    } catch {
      // Unreachable, timed out, or aborted: worth another attempt, since nothing says the endpoint is
      // unwilling. An abort from `stop()` is not retried, because `stopped` closes that path below.
      status = null;
    } finally {
      if (timeout) clearTimeout(timeout);
      // Only if it is still THIS attempt's. On the acknowledged path `settle()` and `finish()` run inside
      // the block above, so by the time this executes `inFlight` can already be the NEXT batch — and
      // clearing its controller would leave that batch with nothing to abort it by.
      if (inFlight && inFlight.controller === controller) {
        inFlight.controller = null;
        inFlight.timeout = null;
      }
    }

    if (mine !== epoch) return;

    const retryable = worthRetrying(status);
    // Not after `stop()`: the guard is going away, and a timer that outlives it would keep a process
    // alive to deliver a report nobody is waiting for.
    if (retryable && inFlight.attempts < MAX_ATTEMPTS && !stopped) {
      const delay = retryDelayMs(inFlight.attempts, retryAfter);
      sending = false;
      retryTimer = unattended(
        setTimeout(() => {
          retryTimer = null;
          void attempt();
        }, delay),
      );

      return;
    }

    abandon();
    finish();
  };

  /** Whatever accumulated while that send ran. */
  const finish = () => {
    sending = false;
    kick();
  };

  const arm = () => {
    if (!timer) {
      timer = unattended(
        setTimeout(() => {
          timer = null;
          flushRequested = true;
          kick();
        }, flushMs),
      );
    }
  };

  /**
   * Whether there is reason to send NOW, as opposed to reason to send eventually.
   *
   * Without this the buffer would empty every time a send completed, because whatever accumulated during
   * one request would immediately become the next — and the flush interval, which exists so a busy app
   * makes one request instead of fifty, would apply only to the first batch of a guard's life.
   */
  // While draining there is no "eventually": everything left goes now, or is accounted for.
  const due = () => draining || pendingState !== null || queue.length >= MAX_BATCH || flushRequested;

  /** Start a send if one is due and nothing is already in flight; otherwise wait for the interval. */
  const kick = () => {
    if (sending || inFlight) return;
    if (typeof fetchImpl !== 'function') {
      // Nothing can be sent, so a drain makes no progress and the queue is accounted for here.
      if (draining) drained();

      return;
    }
    // After `stop()` the only sends are the drain's own. `record` and `announce` also refuse once stopped,
    // so this is the second of two independent refusals rather than the only one — deliberately, because
    // the property it protects is that a torn-down guard opens no connections and arms no timers.
    if (stopped && !draining) return;
    if (queue.length === 0 && pendingState === null) {
      flushRequested = false;
      if (draining) drained();

      return;
    }
    if (!due()) {
      arm();

      return;
    }
    flushRequested = false;

    const droppedWith = dropped;
    dropped = 0;
    droppedTotal += droppedWith;

    const state = pendingState;
    pendingState = null;

    const events = takeBatch(droppedWith, state);
    sent += events.length;
    // Counted where the declaration is committed to a request, so coalesced states count once — the
    // number describes declarations this guard undertook to make, not calls received. A state still
    // waiting when a shutdown ends counts here too, against a matching failure.
    if (state !== null) capabilityAnnounced += 1;

    sequence += 1;
    inFlight = { key: `${instanceId}-${sequence}`, events, dropped: droppedWith, state, attempts: 0 };
    void attempt();
  };

  /**
   * End the drain now, because the shutdown budget is spent.
   *
   * Resolving alone would have been the promise claiming a completion that had not happened: the request
   * would still be open, the queue unaccounted, and later batches free to follow. So the attempt is
   * abandoned and counted, the queue is accounted for, and `epoch` moves — which is what stops a response
   * that lands afterwards from moving any counter, since by then the numbers have already been reported
   * as final.
   */
  const terminate = () => {
    epoch += 1;
    if (inFlight) {
      inFlight.controller?.abort();
      if (inFlight.timeout) clearTimeout(inFlight.timeout);
      failed += inFlight.events.length;
      if (inFlight.state !== null) capabilityFailed += 1;
      inFlight = null;
    }
    // A state that was waiting for a request it will now never get. Counted, because "the platform was
    // not told my final state" is exactly what a reader of these numbers is trying to find out.
    if (pendingState !== null) {
      pendingState = null;
      capabilityAnnounced += 1;
      capabilityFailed += 1;
    }
    sending = false;
    drained();
  };

  /** Nothing left to send: whatever never left is counted rather than forgotten, and the wait ends. */
  const drained = () => {
    draining = false;
    if (queue.length > 0) {
      droppedTotal += queue.length;
      queue = [];
    }
    if (budgetTimer) {
      clearTimeout(budgetTimer);
      budgetTimer = null;
    }
    const resolve = drainResolve;
    drainResolve = null;
    if (resolve) resolve();
  };

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    flushRequested = true;
    kick();
  };

  return {
    /**
     * @param {{
     *   rule?: { id?: string, rule_v2?: unknown },
     *   phase?: string,
     *   mode?: string,
     *   path?: string,
     * }} detection
     */
    record(detection) {
      if (stopped) return;
      const ruleId = detection?.rule?.id;
      if (ruleId === undefined || ruleId === null || ruleId === '') return;

      if (queue.length >= maxQueue) {
        queue.shift();
        dropped++;
      }

      // Capped, with a note of what was capped. Every field is an identifier rather than traffic, but a
      // route is whatever the application routes and a broad rule can read many parameters — and a reader
      // who cannot tell a shortened route from a complete one will read it as a different route.
      // `null` survives: there being no route is not the same as the route being empty, and a cap that
      // turned one into the other would invent a known path where none was established.
      const query = queryKeysOf(detection.path);
      const method = typeof detection.method === 'string' ? capText(detection.method, MAX_METHOD_CHARS) : null;
      const userAgent =
        typeof detection.userAgent === 'string' && detection.userAgent !== ''
          ? capText(detection.userAgent, MAX_IDENTIFIER_CHARS)
          : null;
      const queryKeys = query.keys.map((name) => capText(name, MAX_PARAMETER_CHARS));
      // Computed once: calling the gate twice would let a getter or a proxy answer differently between
      // the check and the send.
      const capture = boundCapture(detection.capture);
      const rawRoute = routeOf(detection.path);
      const route = typeof rawRoute === 'string' ? capText(rawRoute, MAX_ROUTE_CHARS) : { value: rawRoute, truncated: false };
      const allParameters = ruleParameters(detection.rule);
      const parameters = allParameters.slice(0, MAX_PARAMETERS).map((name) => capText(name, MAX_PARAMETER_CHARS));
      const truncated = [];
      if (route.truncated) truncated.push('route');
      if (method?.truncated) truncated.push('method');
      if (userAgent?.truncated) truncated.push('user_agent');
      if (query.total > queryKeys.length || queryKeys.some((entry) => entry.truncated)) {
        truncated.push('query_keys');
      }
      if (allParameters.length > MAX_PARAMETERS || parameters.some((entry) => entry.truncated)) {
        truncated.push('parameters');
      }

      const id = capText(String(ruleId), MAX_IDENTIFIER_CHARS);
      const revision = capText(revisionOf(detection.rule) ?? '', MAX_IDENTIFIER_CHARS);
      const etag = capText(rulesEtag ?? '', MAX_IDENTIFIER_CHARS);
      for (const [name, field] of [
        ['rule_id', id],
        ['rule_revision', revision],
        ['rules_etag', etag],
      ]) {
        if (field.truncated) truncated.push(name);
      }

      queue.push({
        rule_id: id.value,
        route: route.value,
        parameters: parameters.map((entry) => entry.value),
        // Present only when something was shortened, so its absence is not a claim of its own.
        ...(truncated.length > 0 ? { truncated } : {}),
        // Only when parameters were actually left out. Reporting a total because some OTHER field was
        // shortened states that parameters were omitted when none were.
        ...(truncated.includes('parameters') ? { parameters_total: allParameters.length } : {}),
        method: method === null ? null : method.value,
        // The rest of the URL, as names only. `route` is the path; together they say what was requested
        // without saying what was in it.
        query_keys: queryKeys.map((entry) => entry.value),
        // Present only when the list is short, so its absence is not a claim of its own.
        ...(query.total > queryKeys.length ? { query_keys_total: query.total } : {}),
        // Who asked. Capped, since it is client-supplied text and this is an event with a size bound.
        user_agent: userAgent === null ? null : userAgent.value,
        phase: detection.phase ?? null,
        // The state this detection was handled under, which is the whole point: `false` is a rule that
        // saw traffic it would have stopped.
        enforced: detection.mode === 'block',
        rules_etag: rulesEtag === null ? null : etag.value,
        // The revision of THIS rule, as the bundle delivered it. The bundle identity above answers "which
        // bundle", which changes whenever anything in it changes — so it cannot say whether the counts for
        // one rule describe the document that rule has now. Passed through untouched, and null when the
        // bundle carried none.
        rule_revision: revisionOf(detection.rule) === null ? null : revision.value,
        // What the rule was permitted to show, and what it showed. Present only when a plan was derived,
        // which is to say only for a phase that has a reading to derive from.
        ...(capture ? { capture } : {}),
        // The client address and where it came from. `client_ip` is omitted entirely when there is none,
        // so a present-but-empty field cannot read as a failed lookup of a real address; the provenance is
        // always present, because "this could not be established" is the part a reader needs.
        ...clientIpFields({ ip: detection.ip ?? null, source: detection.clientIpSource ?? 'unavailable' }),
        detected_at: new Date().toISOString(),
      });

      // `kick` decides whether this is due now or waits for the interval, so the batch bound and the
      // interval cannot disagree about when a full queue goes out.
      kick();
    },
    flush,
    /**
     * Tell the platform which reporting state this guard settled on.
     *
     * The state also travels on the rules fetch, but that request is made BEFORE the fetch decides
     * whether the rules are the platform's — so a site booting with an empty cache declares that it holds
     * no managed rules, then receives them. Without this, the corrected state would wait for the next
     * refresh, and a guard with refreshing switched off has none.
     *
     * Goes through the same transport as events, so it inherits the retry, the idempotency key and the
     * single-flight bound. Only the newest state is kept: calling this twice before a send declares the
     * second, because what the platform needs is the state now, not how it got there. A declaration that
     * exhausts its retries is dropped rather than held — the state travels on every rules fetch too, so
     * the next one corrects it.
     *
     * @param {string} state
     */
    announce(state) {
      if (stopped || typeof fetchImpl !== 'function' || typeof state !== 'string') return;
      pendingState = state;
      // Sent on a microtask, so declarations made in the same turn coalesce into one: by the time this
      // runs, `pendingState` holds the last of them. Sending on the call would commit the first state
      // before the second could supersede it, and the platform would be told a state this guard had
      // already left. A second microtask finds nothing pending and does nothing.
      queueMicrotask(() => {
        if (!stopped) kick();
      });
    },
    /**
     * Stop reporting, leaving nothing stranded and nothing scheduled.
     *
     * Three things can be outstanding, and each needs an answer:
     *
     * - a batch waiting on a retry timer — it holds the only send slot, so clearing the timer alone would
     *   leave it neither delivered nor counted. It gets one final attempt, with no retry behind it.
     * - a request in flight — it is aborted, and its completion drains what is left rather than starting
     *   open-ended work.
     * - events still queued — drained a batch at a time, each attempted once.
     *
     * Whatever remains unsent when the drain runs out is counted as dropped, so every recorded event ends
     * up delivered, refused or dropped, and none simply disappears.
     *
     * The drain is asynchronous, so this returns a promise that settles when nothing is outstanding —
     * which a host shutting down can await instead of racing the last batch against process exit. It is
     * best-effort and bounded: a runtime that terminates the process regardless, or a drain slower than
     * `STOP_BUDGET_MS`, still ends the wait. Ignoring the promise behaves exactly as before.
     */
    stop() {
      if (stopped) return drainPromise ?? Promise.resolve();
      stopped = true;
      drainPromise = new Promise((resolve) => {
        drainResolve = resolve;
      });
      budgetTimer = unattended(setTimeout(() => {
        budgetTimer = null;
        terminate();
      }, STOP_BUDGET_MS));
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      draining = true;

      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
        void attempt();

        return drainPromise;
      }
      if (sending) {
        // Its completion continues the drain. Aborting turns a hung request into a failure now rather
        // than a slot held until the process exits.
        inFlight?.controller?.abort();

        return drainPromise;
      }
      flushRequested = true;
      kick();

      return drainPromise;
    },
    /**
     * Point later events at the bundle now running. Called after an ACCEPTED swap only — a rejected
     * or failed refresh keeps the previous rules, so it must keep the previous identity too.
     *
     * Already-queued events are not rewritten: the stamp is taken when an event is recorded, which is
     * the only moment the two are known to agree.
     *
     * @param {string | null | undefined} next
     */
    setRulesEtag(next) {
      rulesEtag = next ?? null;
    },
    dropped: () => dropped,
    /**
     * Delivery health, counted in events: attempted, acknowledged, refused or unreachable, and dropped
     * for queue pressure — plus when a batch was last acknowledged. No request data of any kind.
     */
    health: () => ({
      sent,
      delivered,
      failed,
      dropped: droppedTotal + dropped,
      // Attempts beyond the first, counted in ATTEMPTS rather than events: a path that only ever
      // succeeds on a second try is working, and is worth telling apart from one that never retries.
      retried,
      // Redeliveries the credential path made after a refused token, which are not backoff retries and
      // would otherwise appear nowhere: a rotated or revoked credential is worth seeing as itself.
      reauthorized,
      lastDeliveredAt,
      // Separate, because a capability announcement delivers no events. Reading zero here alongside a
      // non-zero `delivered` is a normal state, and so is the reverse.
      capability: {
        announced: capabilityAnnounced,
        acknowledged: capabilityAcknowledged,
        failed: capabilityFailed,
        retried: capabilityRetried,
        lastAcknowledgedAt: lastCapabilityAckAt,
      },
    }),
  };
}
