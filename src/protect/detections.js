import { pulseAuthHeader } from '../pulse-token.js';
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
 * and the bundle identity. That is enough to count hits per rule, compare them against traffic, and
 * decide whether a rule is wrong.
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
    return { record() {}, flush() {}, stop() {}, dropped: () => 0 };
  }

  const configured = opts.baseUrl ?? process.env?.PATCHSTACK_PULSE_RULES_URL;
  const baseUrl = typeof configured === 'string' && isSafeOrigin(configured)
    ? configured.replace(/\/$/, '')
    : DEFAULT_BASE_URL;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const flushMs = Number.isFinite(opts.flushMs) && opts.flushMs > 0 ? opts.flushMs : DEFAULT_FLUSH_MS;
  const maxQueue = Number.isFinite(opts.maxQueue) && opts.maxQueue > 0 ? opts.maxQueue : MAX_QUEUE;

  /** @type {Array<Record<string, unknown>>} */
  let queue = [];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let stopped = false;
  let dropped = 0;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (queue.length === 0 || typeof fetchImpl !== 'function') return;

    const batch = queue.splice(0, MAX_BATCH);
    // The count of what never made it, sent WITH the batch rather than inferred from a gap: a consumer
    // computing a false-positive rate needs to know its denominator is short, and silence about that
    // would make a truncated sample look like a complete one.
    const droppedWith = dropped;
    dropped = 0;

    void (async () => {
      try {
        const res = await fetchImpl(`${baseUrl}/detections/${encodeURIComponent(siteUuid)}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': '@patchstack/connect',
            // Same credential path as the rules fetch, and unauthenticated when none resolves: the
            // server accepts the UUID, and reporting must never hinge on getting a token.
            ...(await pulseAuthHeader({ pulseAuth: opts.pulseAuth, endpoint: baseUrl }, fetchImpl)),
          },
          body: JSON.stringify({ detections: batch, dropped: droppedWith }),
        });
        // Fail-open and silent: a rejected or unreachable endpoint must not disturb the app, and must
        // not retry into a loop either. The next flush carries whatever arrives next.
        if (res && typeof res.then === 'function') res.catch(() => {});
      } catch {
        /* ignore */
      }
    })();
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

      queue.push({
        rule_id: ruleId,
        route: routeOf(detection.path),
        parameters: ruleParameters(detection.rule),
        phase: detection.phase ?? null,
        // The state this detection was handled under, which is the whole point: `false` is a rule that
        // saw traffic it would have stopped.
        enforced: detection.mode === 'block',
        rules_etag: opts.rulesEtag ?? null,
        detected_at: new Date().toISOString(),
      });

      if (queue.length >= MAX_BATCH) {
        flush();

        return;
      }
      if (!timer) timer = setTimeout(flush, flushMs);
    },
    flush,
    stop() {
      stopped = true;
      flush();
    },
    dropped: () => dropped,
  };
}
