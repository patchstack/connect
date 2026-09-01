import { pulseAuthHeader } from '../pulse-token.js';
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
 * What it never carries: **the matched value, the request body, headers, or query-string values**. A
 * channel that counts detections is a different thing from a copy of an application's traffic, and once
 * values are collected every question about retention, access and jurisdiction arrives with them.
 * Anything value-level belongs behind its own explicit opt-in with its own controls, not as a side
 * effect of counting.
 *
 * The route is the request PATH with any query string dropped, because `?token=…` is a value.
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
/** A refusal that will refuse again is terminal; these are the ones worth trying later. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

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
 * The body bound, set where a full batch can actually reach it.
 *
 * A bound above anything the other caps allow is not a bound, it is a comment: the count and the field
 * caps together put a full batch of worst-case events over this, so the split is a path traffic reaches
 * rather than a branch nothing can enter. It is also a modest request body, which is the point — an
 * endpoint or proxy that refuses an oversized body would refuse every retry of it too.
 */
const MAX_BODY_BYTES = 64 * 1024;

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

/**
 * As many events as fit the byte bound, and the rest.
 *
 * A backstop, not the primary bound: with every field capped, a full batch cannot reach `MAX_BODY_BYTES`
 * today. It stays because the field caps and the batch count are separate numbers that can each change,
 * and an endpoint refusing an oversized body would refuse every retry of it too. At least one event
 * always goes, since a batch of none makes no progress.
 */
export function splitToFit(events, maxBytes) {
  const batch = events.slice();
  const rest = [];
  while (batch.length > 1 && JSON.stringify(batch).length > maxBytes) {
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
      record() {}, flush() {}, stop() {}, setRulesEtag() {}, announce() {}, dropped: () => 0,
      health: () => ({
        sent: 0, delivered: 0, failed: 0, dropped: 0, retried: 0, lastDeliveredAt: null,
        capability: { announced: 0, acknowledged: 0, failed: 0, lastAcknowledgedAt: null },
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
  let flushRequested = false;

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
  const takeBatch = () => {
    const [batch, rest] = splitToFit(queue.splice(0, MAX_BATCH), MAX_BODY_BYTES);
    if (rest.length > 0) queue.unshift(...rest);

    return batch;
  };

  const post = async (body, key) =>
    fetchImpl(`${baseUrl}/detections/${encodeURIComponent(siteUuid)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': '@patchstack/connect',
        // The same key on every attempt of one batch. A retry exists because an acknowledgement can be
        // lost after the server committed the batch, so without this a redelivery would be counted twice
        // and inflate exactly the numbers the reports are read for.
        'Idempotency-Key': key,
        // Same credential path as the rules fetch. The detections endpoint is site-addressed and requires
        // a verified, site-bound token, so a batch sent without one is refused — which is why the runtime
        // does not build a reporter when no credential resolves, rather than posting into a 401.
        ...(await pulseAuthHeader({ pulseAuth: opts.pulseAuth, endpoint: baseUrl }, fetchImpl)),
      },
      body: JSON.stringify(body),
    });

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
    sending = true;
    inFlight.attempts += 1;
    if (inFlight.attempts > 1) retried += 1;

    const body = {
      detections: inFlight.events,
      // The count of what never made it, sent WITH the batch rather than inferred from a gap: a consumer
      // computing a false-positive rate needs to know its denominator is short, and silence about that
      // would make a truncated sample look like a complete one.
      dropped: inFlight.dropped,
      ...(inFlight.state !== null ? { reporting_state: inFlight.state } : {}),
    };

    let status = null;
    let retryAfter = null;
    try {
      const res = await post(body, inFlight.key);
      if (res && res.ok) {
        settle();
        finish();

        return;
      }
      status = typeof res?.status === 'number' ? res.status : 0;
      retryAfter = res?.headers?.get?.('retry-after') ?? null;
    } catch {
      // Unreachable rather than refused: worth another attempt, since nothing says the endpoint is
      // unwilling.
      status = null;
    }

    const worthRetrying = status === null || RETRYABLE_STATUS.has(status);
    // Not after `stop()`: the guard is going away, and a timer that outlives it would keep a process
    // alive to deliver a report nobody is waiting for.
    if (worthRetrying && inFlight.attempts < MAX_ATTEMPTS && !stopped) {
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
  const due = () => pendingState !== null || queue.length >= MAX_BATCH || flushRequested;

  /** Start a send if one is due and nothing is already in flight; otherwise wait for the interval. */
  const kick = () => {
    if (sending || inFlight || typeof fetchImpl !== 'function') return;
    if (queue.length === 0 && pendingState === null) {
      flushRequested = false;

      return;
    }
    if (!due()) {
      arm();

      return;
    }
    flushRequested = false;

    const events = takeBatch();
    const droppedWith = dropped;
    dropped = 0;
    droppedTotal += droppedWith;
    sent += events.length;

    const state = pendingState;
    pendingState = null;
    // Counted where the declaration is actually attached to a request, so coalesced states count once —
    // the number describes declarations made, not calls received.
    if (state !== null) capabilityAnnounced += 1;

    sequence += 1;
    inFlight = { key: `${instanceId}-${sequence}`, events, dropped: droppedWith, state, attempts: 0 };
    void attempt();
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
      const route = capText(routeOf(detection.path), MAX_ROUTE_CHARS);
      const allParameters = ruleParameters(detection.rule);
      const parameters = allParameters.slice(0, MAX_PARAMETERS).map((name) => capText(name, MAX_PARAMETER_CHARS));
      const truncated = [];
      if (route.truncated) truncated.push('route');
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
        ...(truncated.length > 0
          ? { truncated, parameters_total: allParameters.length }
          : {}),
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
    stop() {
      stopped = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      // One last send for whatever is queued. No retry follows it: `stopped` closes that path, so a
      // failure here is counted and the guard goes away rather than keeping a timer alive behind it.
      flush();
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
      lastDeliveredAt,
      // Separate, because a capability announcement delivers no events. Reading zero here alongside a
      // non-zero `delivered` is a normal state, and so is the reverse.
      capability: {
        announced: capabilityAnnounced,
        acknowledged: capabilityAcknowledged,
        failed: capabilityFailed,
        lastAcknowledgedAt: lastCapabilityAckAt,
      },
    }),
  };
}
