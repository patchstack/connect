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
        sent: 0, delivered: 0, failed: 0, dropped: 0, lastDeliveredAt: null,
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
    droppedTotal += droppedWith;
    sent += batch.length;

    void (async () => {
      try {
        const res = await fetchImpl(`${baseUrl}/detections/${encodeURIComponent(siteUuid)}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': '@patchstack/connect',
            // Same credential path as the rules fetch. The detections endpoint is site-addressed and
            // requires a verified, site-bound token, so a batch sent without one is refused — which is
            // why the runtime does not build a reporter when no credential resolves, rather than
            // posting into a 401.
            ...(await pulseAuthHeader({ pulseAuth: opts.pulseAuth, endpoint: baseUrl }, fetchImpl)),
          },
          body: JSON.stringify({ detections: batch, dropped: droppedWith }),
        });
        // Fail-open and no retry: a rejected or unreachable endpoint must not disturb the app, and a
        // retry loop over a refusing endpoint is worse than the lost batch. The outcome is counted, so
        // that a delivery path which refuses everything is distinguishable from an app where no rule
        // fired — both are silence at the server otherwise.
        if (res && res.ok) {
          delivered += batch.length;
          lastDeliveredAt = new Date().toISOString();
        } else {
          failed += batch.length;
        }
      } catch {
        failed += batch.length;
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
        rules_etag: rulesEtag,
        // The revision of THIS rule, as the bundle delivered it. The bundle identity above answers "which
        // bundle", which changes whenever anything in it changes — so it cannot say whether the counts for
        // one rule describe the document that rule has now. Passed through untouched, and null when the
        // bundle carried none.
        rule_revision: revisionOf(detection.rule),
        detected_at: new Date().toISOString(),
      });

      if (queue.length >= MAX_BATCH) {
        flush();

        return;
      }
      if (!timer) timer = setTimeout(flush, flushMs);
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
     * Carries no events: an empty batch whose only content is the state. Fire-and-forget and fail-open for
     * the same reason as a flush — a report is never worth disturbing the app over — and counted as a
     * delivery attempt so a path that refuses everything stays visible.
     *
     * @param {string} state
     */
    announce(state) {
      if (stopped || typeof fetchImpl !== 'function' || typeof state !== 'string') return;
      capabilityAnnounced += 1;

      void (async () => {
        try {
          const res = await fetchImpl(`${baseUrl}/detections/${encodeURIComponent(siteUuid)}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'User-Agent': '@patchstack/connect',
              ...(await pulseAuthHeader({ pulseAuth: opts.pulseAuth, endpoint: baseUrl }, fetchImpl)),
            },
            body: JSON.stringify({ detections: [], dropped: 0, reporting_state: state }),
          });
          if (res && res.ok) {
            capabilityAcknowledged += 1;
            lastCapabilityAckAt = new Date().toISOString();
          } else {
            capabilityFailed += 1;
          }
        } catch {
          capabilityFailed += 1;
        }
      })();
    },
    stop() {
      stopped = true;
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
