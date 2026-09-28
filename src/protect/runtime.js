// @patchstack/protect — "Protect = respond".
//
// One entry point that composes the node-waf engine + adapters with:
//   - a rule source: an explicit bundle, or fetched from the Patchstack API (token),
//     with a disk cache so the engine keeps working on last-known-good if the API is down
//   - execution modes: 'dry-run' (detect + log, never block — the safe onramp) and 'block' (enforce).
//     This API's default is 'dry-run'. NOTE the scaffolded guard (`patchstack-connect protect`)
//     deliberately passes mode: 'block' and only drops to dry-run when PATCHSTACK_MODE=dry-run — so an
//     installed guard ENFORCES by default even though this constructor's default doesn't. Precedence:
//     PATCHSTACK_MODE env > API `enforcement` > options.mode > dry-run.
//   - fail-open everywhere: a rule/engine error never blocks (or crashes) a request. Where the guard
//     fails open *without* inspecting AND KNOWS IT (body caps, live streams, binary bodies, a resolver
//     the fetch pre-screen could not use) it is counted and reported — see `protection.coverage()` /
//     the `onSkip` option. It is not a measure of everything unscreened: an outbound call can miss the
//     address check without this guard being able to tell, so zero is not a claim that nothing was.
//
// Runtime guards: .express(), .node(), .fetch(handler) / .fetchGuard() — same policy,
// every runtime an AI builder deploys to.
// Vendored node-waf engine (this package is self-contained — no @patchstack/node-waf dep).
import { resolveClientIp } from './client-ip.js';
import { RuleEngine } from './engine/index.js';
import { matchValue, walkLeaves, safeRegExp, jwtClaimSpans } from './engine/engine.js';
import { requestField } from './engine/normalizer.js';
import { captureValues, createPlanCache, permitsAnything } from './capture-plan.js';
import { PulseRuleClient } from './engine/pulse-client.js';
import { fromFetchRequest } from './engine/fetch.js';
import { fromNodeRequest, readBodyPrefix } from './engine/node.js';
import { appendOwn, setOwn } from './engine/own.js';
import { installEgressGuard } from './egress.js';
import { DEFAULT_RESPONSE_RULES, DEFAULT_EGRESS_RULES } from './defaults.js';
import { renderBlockPage } from './block-page.js';
// Rule lifecycle (source / tiered store / refresh) lives in ./rules/ — this file stays focused on
// composing the engine + guards and running the three screening phases.
import { makeStore } from './rules/store.js';
import { resolveRules } from './rules/source.js';
import { startRefresh, startRecovery, makeRefreshHandler, serialise } from './rules/refresh.js';
import { createDetectionReporter } from './detections.js';
import { reportingState } from './reporting-state.js';
import { hardensWithoutBody, readsOnlyResponseHeaders } from './response-hardening.js';
import { notify } from './notify.js';
import { SOURCE_REQUEST } from './supabase-guard.js';
import { createFirewallLogReporter, resolveApiBase, telemetryEnabled } from './firewall-log.js';

// Supabase-tunnel guard for AI-builder apps (Lovable / TanStack Start + Supabase).
export { createSupabaseGuard, GUARD_PATH } from './supabase-guard.js';
// The seam side of `protect --check --runtime`. Exported because a scaffolded guard is a file in the
// app, and it has to be able to answer a verification request without carrying the logic itself.
export { sentinelAnswer, VERIFY_HEADER } from './verify-sentinel.js';

// Per-site live rule client (Pulse). Re-exported for callers/tests that want to use it directly.
export { PulseRuleClient };

// Server-function guard. Modern Lovable apps mutate data through TanStack server functions
// (browser → server fn → server-side Supabase client), which bypass the browser-side tunnel the
// Supabase guard relies on. This inspects the decoded server-fn call args against the SAME policy
// by feeding them through fetchGuard (the args become the request body, so the engine resolves
// `post.<field>` exactly as it does for a tunneled Supabase insert). Returns a block receipt
// { rule?, message } to throw on, or null to allow (also null in dry-run — the detection is still
// recorded by fetchGuard). Fail-open on any error.
export function createServerFnGuard({ protection }) {
  const guard = protection.fetchGuard();
  return async (data) => {
    let res;
    try {
      const req = new Request('https://patchstack.local/_serverfn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data ?? {}),
      });
      res = await guard(req);
    } catch {
      return null; // fail open
    }
    if (!res) return null; // allowed (or dry-run)
    let body = {};
    try {
      body = await res.clone().json();
    } catch {
      /* non-JSON block response */
    }
    return { rule: body.rule, message: body.message || 'Blocked by Patchstack' };
  };
}

/**
 * An option that has to be a list: the value when it is one, the default when it is absent, and the
 * default plus a report when it is neither.
 *
 * Every shape a caller can pass reaches one of those three outcomes, and which one never depends on
 * what the value could be read AS. The engine's own policy for that phase is what applies, exactly as
 * it does when nothing was configured, and the option is named in the report so the mistake is visible
 * rather than absorbed.
 *
 * Ignored rather than adapted: reading one string as a one-element list is a guess about policy, and
 * "the host you named is allowed" and "no host is allowed" are different policies.
 *
 * The report is the whole of the guard's answer, because `createProtection` does not refuse a
 * configuration: a construction that throws is a request that fails, or an application that does not
 * start, depending on where the seam holding it builds it.
 */
function listOption(value, fallback, name, onError) {
  // Absent means `undefined`, and nothing else. The declared type is a list or nothing, so `null` is a
  // value someone wrote, and a value someone wrote and the guard silently discarded is the outcome this
  // whole function exists to avoid.
  if (value === undefined) return fallback;
  if (Array.isArray(value)) return value;
  notify(onError, new Error(`patchstack: \`${name}\` has to be an array; the value configured is ignored`), 'onError');

  return fallback;
}

export async function createProtection(options = {}) {
  const onError = options.onError;
  // Every list option is read here, once. Their readers run more than once — the egress guard and the
  // request-phase check both want `allowHosts`, and the rules are rebuilt on every refresh — and a
  // configuration mistake does not change while the process lives, so reading it per use would report
  // the same immutable mistake for as long as the guard runs.
  const allowHosts = listOption(options.allowHosts, [], 'allowHosts', onError);
  const configuredResponseRules = listOption(options.responseRules, DEFAULT_RESPONSE_RULES, 'responseRules', onError);
  const configuredEgressRules = listOption(options.egressRules, DEFAULT_EGRESS_RULES, 'egressRules', onError);
  const userOnDetect = options.onDetect ?? defaultOnDetect;

  // Report enforced blocks via existing connector POST /api/logs/log (WP path).
  // Needs api_key from provision / PATCHSTACK_API_KEY / the config files.
  // Opt out: PATCHSTACK_TELEMETRY=off. Never embed api_key in the public widget.
  const apiKey = await resolveApiKey(options);
  const firewallLog =
    apiKey && telemetryEnabled() && options.reportFirewallLog !== false
      ? createFirewallLogReporter({
          apiKey,
          apiBase: resolveApiBase(options.pulseRulesUrl ?? options.baseUrl),
          sourceHost: options.sourceHost,
          fetchImpl: options.fetchImpl,
        })
      : null;

  // Every detection, enforced or not, to the Pulse detections endpoint. Distinct from the block log
  // above: that records what was STOPPED, in the WordPress-compatible shape; this records what a rule
  // WOULD have stopped, which is otherwise unobservable for a rule carrying `enforcement: dry-run`.
  // Minimal payload by design; see `detections.js`.
  let detections = null;

  /**
   * The rule as a callback sees it: its identity, and nothing that carries policy.
   *
   * `onDetect` documents `rule` as `{ id, category }`, and that is what this returns. The rule the engine
   * matches with IS the policy in force, and enforcement lives in its nested parts — `rule_v2`, `when`,
   * and the match and action objects inside them — so handing out the object, or any copy that still
   * shares them, lets a callback change what every later request through this guard is screened for.
   *
   * Projected rather than cloned because this runs on every detection, which an attacker can drive. A
   * deep clone would allocate the whole rule per detection to hand back fields the contract does not
   * promise. The internal reporters keep reading the real rule; only the callback's view is narrowed.
   */
  const ruleIdentity = (rule) => ({ id: rule?.id, category: rule?.category });

  const onDetect = (detection) => {
    // What the platform is told is the engine's account of the request, and a host callback cannot change
    // it. A synchronous callback that replaced `ip`, `clientIpSource`, `rule` or `path` would otherwise
    // decide what the platform is told a rule matched and who it matched — silently, and
    // indistinguishably from a correct report.
    //
    // The callback gets its own object, so what it writes reaches nothing else; each internal reporter
    // builds its own record from the detection itself. Reading before the callback runs is not what
    // carries this — it is defence in depth for the case where the copy is later weakened.
    if (detections) detections.record(detection);
    if (firewallLog && detection?.mode === 'block') {
      firewallLog.record({
        rule: detection.rule,
        method: detection.method,
        path: detection.path,
        ip: detection.ip,
        userAgent: detection.userAgent,
      });
    }

    // Without `capture`: the documented callback carries the rule's identity and the request's own
    // metadata, and a host already holds the request these values came from. Widening it to forward
    // evidence is a decision about the callback contract, not a side effect of collecting any.
    const { capture: _evidence, ...forCallback } = detection ?? {};
    notify(
      userOnDetect,
      { ...forCallback, ...(detection?.rule ? { rule: ruleIdentity(detection.rule) } : {}) },
      'onDetect',
    );
  };

  // Node's own HTTP module where there is one, so a held `writeHead` can be judged by Node itself. Loaded
  // here rather than imported: this module also runs on runtimes that have no `node:http`.
  const nodeHttp = await import('node:http').then((m) => m.default ?? m, () => null);

  // One tiered store (memory → filesystem/pluggable) shared by the initial load and every refresh.
  const store = makeStore(options);
  // Startup must not hang on the network: hosted platforms (Replit et al.) fail a deploy whose health
  // check is slow, and the guard can always boot from last-known-good / the bundled fallback. Refreshes
  // keep the full budget. Override with { bootTimeoutMs }.
  const bootTimeoutMs = Number(options.bootTimeoutMs) > 0 ? Number(options.bootTimeoutMs) : 5_000;
  // Resolved once and threaded through ctx: reading it is a filesystem hit on
  // runtimes that have one, and refreshes should not repeat it.
  const pulseAuth = await resolvePulseAuth(options);
  // A site UUID with no credential behind it, said out loud ONCE at boot.
  //
  // Resolution reads the config files, so it needs a filesystem and a working directory. The
  // runtimes this guard is built for do not all have one: on a Worker or an edge function the file is
  // absent and only `PATCHSTACK_PULSE_AUTH` / `PATCHSTACK_API_KEY` can carry the credential.
  //
  // Every site-addressed Pulse endpoint requires a verified, site-bound credential; only a first-time
  // provisioning call is anonymous. So a missing credential is not a future problem — the rules fetch is
  // refused now. And the refusal is invisible, because a failed fetch fails open onto the cached or
  // bundled bundle: the guard then screens every request, reports healthy, and never receives another
  // rule. That silence is the whole problem — an app protected by rules frozen at install time looks
  // exactly like an app protected by current ones.
  //
  // A warning, not a throw. Booting is protection; refusing to boot over a missing credential would
  // trade a stale rule set for no rule set at all.
  if (options.siteUuid && !pulseAuth) {
    const message =
      'Patchstack: no API credential resolved for site ' +
      options.siteUuid +
      '. Rule updates will be rejected and this guard would keep running on its cached rules. ' +
      'Set PATCHSTACK_API_KEY (or pass { pulseAuth }) — required on runtimes without a filesystem.';
    notify(onError, new Error(message), 'onError');
    console.warn(message);
  }
  // The state sent on the fetch, computed from what is knowable before it: the store says whether the
  // platform has ever delivered rules here, which is the honest origin at the moment of asking. The
  // resolved state is recomputed from the actual origin immediately after, and every later fetch carries
  // whatever the guard is in by then.
  const cachedOrigin = async () => {
    const prior = await store.read();
    if (prior?.bundle) return 'cache';

    return options.rules ? 'bundled' : 'empty';
  };
  const stateFor = (origin) =>
    reportingState({
      siteUuid: options.siteUuid,
      ruleOrigin: origin,
      hasCredential: Boolean(pulseAuth),
      configOptOut: options.reportDetections === false,
    });

  // Read once and reused below, so the state reported on the fetch and the state compared against the
  // settled one are the same value rather than two reads of a store the fetch has since written to.
  const preFetchState = stateFor(await cachedOrigin()).state;
  const bundle = await resolveRules(options, store, {
    timeoutMs: bootTimeoutMs,
    pulseAuth,
    detectionState: preFetchState,
  });

  /**
   * Where the rules in force came from, and whether the last resolution was clean.
   *
   * With a live source, rules that are not current are a protection gap the application may not know it
   * has: a failed fetch, a rejected update and held build-scoped rules are all reported through
   * `onError`, and without one they were reported nowhere. So when no `onError` is given, each distinct
   * cause is written to the console once — enough to be seen, without repeating on every refresh.
   */
  let ruleSource = { ...(bundle.source ?? { ok: true, origin: 'empty' }) };
  const warnedSources = new Set();
  const hasLiveSource = Boolean(options.siteUuid || options.token);
  const noteRuleSource = (source) => {
    ruleSource = { ...(source ?? { ok: true, origin: ruleSource.origin }) };
    if (!hasLiveSource || typeof onError === 'function' || ruleSource.ok !== false) return;
    const cause = `${ruleSource.origin}:${ruleSource.reason ?? ''}`;
    if (warnedSources.has(cause)) return;
    warnedSources.add(cause);
    const running =
      ruleSource.origin === 'cache'
        ? 'the last rules it received'
        : ruleSource.origin === 'bundled'
          ? 'its bundled fallback rules'
          : 'no rules at all';
    console.warn(
      `[patchstack] the guard's rules are not current (${ruleSource.reason ?? 'the rules source did not answer'}); ` +
        `it is running on ${running}. Pass { onError } to handle this yourself.`,
    );
  };
  noteRuleSource(bundle.source);
  // ON by default for an enrolled site running Patchstack-delivered rules, and off otherwise — a local
  // install and a guard running its own bundle send nothing. That default is a change in what an
  // installed app does on the network, so it is disclosed in `AGENT-INSTALL.md` and in the option
  // documentation rather than being inferred from behaviour.
  //
  // It needs a credential. The detections endpoint is site-addressed and site-bound-token-only, so a
  // reporter built without one queues events, posts them, and is refused — spending an outbound request
  // per batch to accomplish nothing, while `reportDetections: true` in the config says reporting is on.
  // Refusing to build it is the honest outcome; `protection.detectionReporting` says which it is.
  //
  // Derived from enrolment rather than from a config flag: reporting is on for a site the platform
  // manages, and off everywhere else. `reportingState` holds the whole decision so every combination is
  // enumerable in a test instead of reachable only by constructing a guard.
  let detectionReporting = 'not-enrolled';
  /**
   * The origin of the rules in force.
   *
   * Held separately from the reported state so a request can carry a state derived FRESH from it. Sending
   * the previously reported state would mean an opt-out that appeared under a running guard was not
   * reported on the next request — only on the one after it.
   */
  let currentOrigin;

  /**
   * Bring reporting into line with the rules now in force.
   *
   * Called at boot and after every refresh, because the inputs are not all boot-time facts: a guard that
   * started on a failed fetch and fell back to its cached or bundled rules can receive platform rules on
   * a later refresh, and an opt-out can appear in the environment under a running process. A state fixed
   * at startup leaves the first case silent for the life of the process.
   *
   * The credential is resolved once at boot, so losing it mid-process does not change the state.
   *
   * Starts and stops the reporter accordingly. Stopping flushes what it holds — the events already
   * collected were collected while reporting was on, and dropping them would lose evidence rather than
   * decline to gather it.
   */
  const applyReportingState = async (origin) => {
    currentOrigin = origin;
    const next = stateFor(origin);
    const changed = next.state !== detectionReporting;
    detectionReporting = next.state;

    if (next.reports && !detections) {
      detections = createDetectionReporter({
        siteUuid: options.siteUuid,
        baseUrl: options.pulseRulesUrl,
        pulseAuth,
        // The bundle the guard is actually running, so a hit can be attributed to the rules that
        // produced it rather than to whatever is current when the report is read.
        rulesEtag: (await store.read())?.etag ?? null,
        fetchImpl: options.fetchImpl,
        flushMs: options.detectionFlushMs,
      });
    } else if (!next.reports && detections) {
      detections.stop();
      detections = undefined;
    }

    if (changed && next.state === 'unavailable-no-credential') {
      const message =
        'Patchstack: this site is enrolled and running managed rules, but no API credential resolved, ' +
        'so no security event could be delivered. Reporting is off.';
      notify(onError, new Error(message), 'onError');
      console.warn(message);
    }

    return next;
  };

  /**
   * Apply the settled state, and correct the platform if the request that just went out declared another.
   *
   * Both the boot fetch and every refresh declare a state BEFORE resolution decides where the rules came
   * from, so either can settle somewhere else. This is the single place that reconciles the two, so the
   * two paths cannot drift apart: a guard whose only refresh is a one-shot manual call would otherwise
   * leave the platform holding the pre-resolution answer for the life of the process.
   *
   * @param {'api'|'cache'|'bundled'|'empty'|undefined} origin
   * @param {string} declared the state carried by the request that produced `origin`
   */
  const applyAndAcknowledge = async (origin, declared) => {
    const settled = await applyReportingState(origin);
    if (settled.state !== declared && detections) detections.announce(settled.state);

    return settled;
  };

  await applyAndAcknowledge(bundle.source?.origin, preFetchState);
  // Mode is mutable so a Pulse refresh can flip dry-run ↔ block when SaaS enables production.
  // Precedence: PATCHSTACK_MODE env (local override) > API enforcement > options.mode > dry-run.
  let mode = resolveMode(options, bundle);
  // Rule-derived runtime state. Held in `let` bindings the guard methods below close over, so a
  // refresh (see the loop near the end) can hot-swap the engines by reassigning them — the
  // egress interception and the protection object itself stay in place, no re-install.
  let requestRules;
  let responseRules;
  let egressRules;
  let screenCap; // max body we'll buffer/screen (rules can raise it)
  let engine;
  let responseRuleSet;
  let egressRuleSet;

  // Split the delivered ruleset by phase (default "request"), merging phase defaults +
  // per-call overrides. Detection is fully rule-driven — nothing hardcoded.
  const applyBundle = (delivered) => {
    const incoming = delivered.firewall ?? [];
    requestRules = byPhase(incoming, 'request');
    responseRules = [...configuredResponseRules, ...byPhase(incoming, 'response')];
    screenCap = responseScreenCap(responseRules);
    egressRules = [...configuredEgressRules, ...byPhase(incoming, 'egress')];
    engine = new RuleEngine({
      firewall: requestRules,
      whitelists: delivered.whitelists,
      whitelist_keys: delivered.whitelist_keys,
      onError,
    });
    // One engine per response rule so we can find ALL matches (to redact each). `action:
    // "redact"` masks the offending span(s); anything else withholds the whole response.
    responseRuleSet = responseRules.map((rule) => {
      const redactors = rule.action === 'redact' || rule.action === 'encode' ? extractRedactors(rule) : null;
      // A redact/encode condition that carries body-transforming mutations (base64_decode, urldecode,
      // json_decode, …) detects on the DECODED body but the span redactors run on the RAW body — so
      // they mask nothing and the secret is served while the log says "redacted". Flag it so screenText
      // fails such a rule CLOSED (block) instead of serving a no-op redaction.
      const mutatedSpan = (rule.action === 'redact' || rule.action === 'encode') && hasSpanMutations(rule);

      return {
        rule,
        engine: new RuleEngine({ firewall: [rule], onError }),
        redactors,
        mutatedSpan,
        // A redaction that reads response headers only, and masks spans in them, is decided and carried
        // out without the body — so it still applies to a response whose body was not screened.
        redactsHeaders:
          rule.action === 'redact' &&
          !mutatedSpan &&
          (redactors ?? []).some((r) => !r.jsonPath) &&
          readsOnlyResponseHeaders(rule),
        // Optional cheap pre-filter: literal anchor(s) that MUST appear for the (expensive) regex to
        // have any chance of matching. Lets screenText skip the full scan on responses with no candidate
        // — the common case — cutting CPU/latency and shrinking the regex/ReDoS surface.
        // Case-insensitive, and checked against the header values as well as the body, since a rule may
        // read either.
        prefilter: Array.isArray(rule.prefilter) && rule.prefilter.length
          ? rule.prefilter.map((s) => String(s).toLowerCase())
          : null,
      };
    });
    // One engine per rule, as the response phase does. It preserves the identity of every rule that
    // matches: each is evaluated on its own, and each match is attributable to the rule that made it.
    egressRuleSet = egressRules.map((rule) => ({
      rule,
      engine: new RuleEngine({ firewall: [rule], onError }),
    }));
  };

  applyBundle(bundle);

  // Fail-open COVERAGE, for the bypasses the guard can OBSERVE. It deliberately passes traffic through
  // rather than risk breaking the app: an oversized request body, a response past the screening cap, a
  // live stream, a binary body, a parse failure, or an outbound call the FETCH pre-screen could not
  // resolve. Each is a real hole in enforcement, and each is counted and reported to `onSkip`, so a
  // host can alert on it and `protection.coverage()` can be surfaced — "always-on" is not "always
  // inspected".
  //
  // Two things are outside it. A resolver failure on the node path is not a bypass at all: that
  // resolver is the connection's, so the call fails rather than going out unscreened. And connection
  // provenance is not observable — whether an outbound call resolved through the screening resolver is
  // decided by the agent and the socket pool, so such a call can miss the address check without
  // appearing in these counts.
  // `onSkip` is a TRUSTED SERVER callback: `detail` carries operational context (sizes, statuses,
  // outbound hostnames) for logging/alerting. Do not forward it to a client response.
  const skipCounts = Object.create(null);
  const onSkip = typeof options.onSkip === 'function' ? options.onSkip : null;
  const recordSkip = (phase, reason, detail) => {
    const key = `${phase}:${reason}`;
    skipCounts[key] = (skipCounts[key] ?? 0) + 1;
    // A reporting callback must never affect request handling — including an async one, whose rejection
    // lands after a try/catch here would have returned.
    notify(onSkip, { phase, reason, detail, count: skipCounts[key] }, 'onSkip');
  };
  // The inspection limits a request-phase evaluation reached (see RuleEngine#evaluate).
  const recordEvaluationSkips = (result) => {
    for (const reason of result?.skips ?? []) recordSkip('request', reason);
  };

  const maskFn =
    typeof options.maskWith === 'function'
      ? options.maskWith
      : () => (typeof options.maskWith === 'string' ? options.maskWith : '[REDACTED]');

  // Given a request/egress result, enforce (block mode) or just record (dry-run).
  //
  // A rule may carry its own `enforcement: 'dry-run'`, which wins over block mode for that rule alone.
  // Auto-generated rules arrive that way: their coordinate comes from best-effort static analysis, so they
  // are served to detect until a probe or a human has justified them, WITHOUT holding back the
  // hand-authored rules on the same site. A rule with no `enforcement` follows the bundle exactly as
  // before, so an older server that never sends the field behaves identically.
  const ruleMode = (rule) => (rule?.enforcement === 'dry-run' ? 'dry-run' : mode);

  // Plans derived once per rule, and only ever consulted where there is somewhere for evidence to go.
  const planCache = createPlanCache();

  /**
   * The evidence for one match, taken here and nowhere else.
   *
   * The resolver stays inside this function. What leaves is the bounded result — a fixed number of
   * values, each of fixed length, and counts of what did not fit. Handing the resolver onward instead
   * would put the whole request within reach of every consumer of a detection, which is the opposite of
   * a plan that names what may be read.
   *
   * Nothing is derived when reporting is off. That is a cost decision rather than a safeguard — with no
   * reporter there is no event for evidence to travel on, and the block log reads named fields only — so
   * skipping the work changes what an app spends, not what leaves it.
   */
  const evidenceFrom = (result) => {
    if (!detections || !result?.rule) return undefined;
    let entry;
    try {
      entry = planCache.for(result.rule);
    } catch (err) {
      notify(onError, err, 'onError');

      return undefined;
    }

    // The reference travels even when the plan permits nothing, because "this rule was allowed to show
    // you nothing" and "this rule showed you nothing" are different facts, and only the first is policy.
    if (!permitsAnything(entry.plan)) return { plan: entry.reference };

    return { plan: entry.reference, ...captureValues(entry.plan, result.resolver) };
  };

  /**
   * `describe` is called only when a detection is actually raised.
   *
   * A function rather than a value: the description costs a URL parse, a header read and an identity,
   * and most requests match nothing, so none of it is done until there is a detection to describe.
   */
  const decide = (phase, result, block, allow, describe = () => ({})) => {
    if (!result || !result.blocked) return allow();
    const ctx = describe() ?? {};
    const effectiveMode = ruleMode(result.rule);
    onDetect({
      phase,
      // The mode this detection was actually handled under, not the site's: a consumer counting blocks
      // would otherwise over-report, and the whole point of a dry-run rule is that it did not block.
      mode: effectiveMode,
      category: result.rule?.category,
      rule: result.rule,
      message: result.message,
      method: ctx.method,
      path: ctx.path,
      ip: ctx.ip,
      // Which call this was. Named here rather than spread from `ctx` for the same reason as everything
      // else in this payload: a field reaches the wire because someone listed it.
      event: ctx.event ?? null,
      // Provenance travels with the address. Without it a consumer cannot tell an observed peer from a
      // value read out of a forwarded header, and `null` from "there was no address to establish".
      clientIpSource: ctx.clientIpSource,
      userAgent: ctx.userAgent,
      // Derived from the reading this decision was made on, before that reading goes out of scope.
      capture: evidenceFrom(result),
    });
    return effectiveMode === 'block' ? block() : allow();
  };

  // The rules a response whose body was not read can still be screened against: header hardening, and
  // redactions of header values. Neither reads the body, and neither needs one to act on.
  const decidedWithoutBody = (rule, entry) => hardensWithoutBody(rule) || Boolean(entry?.redactsHeaders);
  const redactsHeaders = (_rule, entry) => Boolean(entry?.redactsHeaders);

  // Response phase core: screen a text body → { verdict: 'pass'|'block'|'redact', body? }.
  // redact masks matched spans; block withholds; block wins over redact. Enforcement only in
  // block mode (dry-run records via onDetect but returns 'pass').
  const screenText = (text, meta, reqCtx, only) => {
    let blockRule = null;
    const redactions = [];
    const headerMutations = [];
    let lowerText = null; // lazily lowercased body and header values, only if a rule uses a prefilter
    const responseSkips = new Set(); // each inspection limit counted once per response
    for (const entry of responseRuleSet) {
      const { rule, engine: re, redactors, prefilter, mutatedSpan } = entry;
      // `only` narrows the set to the rules a caller is entitled to run. The no-body path uses it to
      // exclude every rule that reads the body, rather than evaluating one against an empty string —
      // `not_contains` matches everything when there is nothing there, so that is not an undecided rule
      // but a wrongly decided one.
      if (only && !only(rule, entry)) continue;
      // Cheap pre-filter: if none of the rule's literal anchors is in the response, its regex can't
      // match — skip the full scan (the common no-secret case) before touching the engine.
      if (prefilter) {
        if (lowerText === null) lowerText = prefilterText(text, meta.headers);
        if (!prefilter.some((p) => lowerText.includes(p))) continue;
      }
      let result;
      try {
        // Include the originating request's method, path and headers so a response rule's `when`
        // route/method scope and any Host/Origin comparison resolve against the request that produced
        // this response.
        result = re.evaluate({ ...(reqCtx || {}), _response: { ...meta, body: text } });
      } catch (err) {
        notify(onError, err, 'onError');
        continue;
      }
      for (const reason of result.skips ?? []) {
        if (responseSkips.has(reason)) continue;
        responseSkips.add(reason);
        recordSkip('response', reason);
      }
      if (!result.blocked) continue;
      // Per-rule enforcement applies to every phase, not just the request. A generated response rule in
      // dry-run must not redact or withhold a body either: "detect until justified" is meaningless if the
      // rule still rewrites what the user sees.
      const responseMode = ruleMode(rule);
      // The same request metadata a request-phase detection carries, taken from the originating request's
      // own resolution. Omitting it left a response detection with no client at all, so a reviewer could
      // not tell which request produced it.
      onDetect({
        phase: 'response',
        mode: responseMode,
        category: rule.category,
        rule,
        message: result.message,
        ...requestMetaFromContext(reqCtx),
        // A response detection names its capture policy like any other. Response sources are never
        // capturable, so a response-only rule reports a plan that permitted nothing — which is the
        // policy, and a different fact from a rule that found nothing.
        capture: evidenceFrom(result),
      });
      if (responseMode !== 'block') continue; // dry-run: observe only
      if (redactors && redactors.length) {
        // Span redactors on a mutation-decoded rule can't map back to the raw body → fail closed.
        const spanRedactors = redactors.filter((r) => !r.jsonPath);
        if (mutatedSpan && spanRedactors.length) {
          if (!blockRule) blockRule = rule;
        } else {
          redactions.push({ rule, redactors });
        }
      } else if (isHeaderMutation(rule.action)) headerMutations.push(rule);
      else if (!blockRule) blockRule = rule;
    }
    if (mode !== 'block' || (!blockRule && !redactions.length && !headerMutations.length)) return { verdict: 'pass' };
    if (blockRule) return { verdict: 'block' };
    let body = text;
    // Redact the offending spans in the body AND in every (string) header value — so a secret
    // that leaks in a header (Set-Cookie, an echoed X-Api-Key, …) is masked too, and a rule that
    // targets `response.header.*` actually strips the header rather than just detecting it.
    const headers = { ...(meta.headers || {}) };
    // Whether the response is a JSON document, asked only once a span rewrite needs it, and the lexed
    // structure of the body as it stands — reused by the next span rewrite while the body is unchanged.
    let responseIsJson;
    let structure;
    for (const { rule, redactors } of redactions) {
      const mask = maskFn(rule.category);
      // action `encode` HTML-escapes the matched value in place (neutralize stored XSS at output);
      // `redact` masks it. jsonPath redactors act on a structural JSON location, span redactors on
      // text spans in the body AND header values. Apply structural first (on clean JSON), then spans.
      const transform = rule.action === 'encode' ? htmlEscape : null;
      const pathRedactors = redactors.filter((r) => r.jsonPath);
      const spanRedactors = redactors.filter((r) => !r.jsonPath);
      if (pathRedactors.length) body = applyPathRedactors(body, pathRedactors, mask, screenCap, transform);
      if (!spanRedactors.length) continue;
      const beforeSpan = body;
      body = applyRedactors(body, spanRedactors, mask, transform);
      // Span rewrites may change JSON string values, but not keys, containers or other values, and a
      // rewrite that would produce an invalid document is withheld rather than sent. Each result is
      // checked before it becomes input to another transformation. A response that was a JSON document
      // stays one at every step — path masking re-serialises valid JSON, and each span step is checked
      // here — so the document's own validity is the only parse this needs.
      if (body !== beforeSpan) {
        responseIsJson ??= isJson(text);
        if (responseIsJson) {
          if (structure?.text !== beforeSpan) structure = { text: beforeSpan, tokens: lexJson(beforeSpan) };
          const tokens = lexJson(body);
          if (!sameJsonStructure(structure.text, structure.tokens, body, tokens)) return { verdict: 'block' };
          structure = { text: body, tokens };
        }
      }
      if (transform) continue; // encoding is a body/output concern — headers aren't HTML
      for (const name of Object.keys(headers)) {
        const value = headers[name];
        if (typeof value === 'string') {
          setOwn(headers, name, applyRedactors(value, spanRedactors, mask));
        } else if (Array.isArray(value)) {
          // Multi-valued headers (Set-Cookie) — redact each entry.
          setOwn(
            headers,
            name,
            value.map((item) => (typeof item === 'string' ? applyRedactors(item, spanRedactors, mask) : item)),
          );
        }
      }
    }
    for (const rule of headerMutations) applyHeaderMutation(headers, rule);
    return { verdict: 'redact', body, headers };
  };

  // Minimal request context for the response phase: what a response rule's `when` scope and any
  // request-header reference (Host/Origin) need — method, path, and request headers. No body.
  /**
   * Present an Express request to the engine with the resolved address, without touching the original.
   *
   * Every field the engine reads is materialised as an OWN property. The engine normalises with
   * `{ ...req, ...normalizeRequest(req) }`, and a spread copies own enumerable properties only — so a
   * prototype-linked view would arrive carrying just the two properties added here, and a rule scoped to
   * a method, or reading an uploaded file or a parsed cookie, would silently find nothing.
   *
   * The application's own request object is left alone: `req.ip` on Express is an accessor the framework
   * defines from its own `trust proxy` setting, and overwriting it would change what the application sees.
   */
  const shapeExpressRequest = (req) => {
    const client = resolveClientIp({
      peer: req?.socket?.remoteAddress,
      headers: req?.headers ?? {},
      trustedProxy: options.trustedProxy,
    });

    return {
      client,
      shaped: {
        // Own copies of everything a rule can address. Listed rather than spread, so a field the engine
        // gains has to be added here deliberately instead of appearing to work by accident.
        // Through the same gate as the engine's own normalisation: this projection turns whatever it reads
        // into an OWN property, so reading a polluted prototype here would launder it into evidence that
        // no later own-property check could tell from the real thing.
        method: requestField(req, 'method'),
        url: requestField(req, 'url'),
        originalUrl: requestField(req, 'originalUrl'),
        headers: requestField(req, 'headers'),
        query: requestField(req, 'query'),
        body: requestField(req, 'body'),
        files: requestField(req, 'files'),
        cookies: requestField(req, 'cookies'),
        socket: requestField(req, 'socket'),
        // The verbatim body, when a caller kept one. A `raw` rule reads it directly, and the engine
        // otherwise reconstructs raw by re-serialising the parsed body — which cannot carry what parsing
        // did not keep: a body that failed to parse at all, a duplicate key where only the last value
        // survives, or the exact bytes a signature was written against.
        //
        // Own property only. Evidence is what this request actually carried: a value reachable through a
        // polluted prototype is not, and materialising it here would turn it into evidence indistinguish-
        // able from real bytes — firing every raw rule that matches it. The adapters that capture real
        // bytes define `_rawBody` on the request object itself.
        ...(Object.hasOwn(req ?? {}, '_rawBody') ? { _rawBody: req._rawBody } : {}),
        // The resolved address, and the resolution itself for the consumers downstream.
        ip: client.ip ?? '',
        _clientIp: client,
      },
    };
  };

  /**
   * The transport peer for a Fetch request, from the host's `peerAddress` callback.
   *
   * A WHATWG Request carries no peer, so on a Fetch runtime the address is only known to the host (Deno's
   * handler info, Bun's server, a Node adapter's socket). The callback gets the request the host served —
   * for a request rebuilt from another, the original — and the host's own handler arguments. What it
   * returns is validated as an address by the resolver; a callback that throws supplies no peer.
   */
  const peerOf = (request, hostArgs) => {
    if (typeof options.peerAddress !== 'function') return undefined;
    try {
      return options.peerAddress(request?.[SOURCE_REQUEST] ?? request, ...hostArgs);
    } catch (err) {
      notify(onError, err, 'onError');

      return undefined;
    }
  };
  // A trust policy names the peers a forwarded header may be believed from, so without a usable peer it
  // can never apply and every address reads `unavailable`. Said once per guard, because it holds for
  // every request.
  let warnedNoPeer = false;
  const warnNoPeer = () => {
    if (warnedNoPeer) return;
    warnedNoPeer = true;
    const message =
      '[patchstack] trustedProxy is set, but this Fetch runtime supplied no peer address, so forwarded ' +
      'headers are not used and client addresses read as unavailable. Pass { peerAddress } to supply one.';
    if (typeof onError === 'function') notify(onError, new Error(message), 'onError');
    else console.warn(message);
  };
  // The address resolved for each screened Fetch request, so a later response screen for the same request
  // names the same client rather than resolving again without the host's arguments.
  const clientByRequest = new WeakMap();
  // The client for a response screened on its own: the request phase's answer when there was one,
  // otherwise resolved here the same way the request phase would have.
  const clientForResponse = (request, hostArgs) => {
    const known = clientByRequest.get(request);
    if (known) return known;
    const client = resolveClientIp({
      peer: peerOf(request, hostArgs),
      headers: headerObject(request.headers),
      trustedProxy: options.trustedProxy,
    });
    if (options.trustedProxy !== undefined && client.source === 'unavailable') warnNoPeer();

    return client;
  };

  /**
   * Screen a fetch request once, and hand back both the decision and the address it resolved.
   *
   * Shared by `fetchGuard()` and `fetch(handler)` so the response phase can reuse the request phase's
   * resolution instead of making its own.
   */
  const screenFetchRequest = async (request, hostArgs = []) => {
    let result;
    let shaped;
    try {
      shaped = await fromFetchRequest(request, {
        peer: peerOf(request, hostArgs),
        trustedProxy: options.trustedProxy,
        maxBodyBytes: options.maxBodyBytes,
      });
      if (shaped?._clientIp) {
        clientByRequest.set(request, shaped._clientIp);
        if (options.trustedProxy !== undefined && shaped._clientIp.source === 'unavailable') warnNoPeer();
      }
      if (shaped?._bodyInspectionSkip) {
        recordSkip('request', shaped._bodyInspectionSkip, { limit: options.maxBodyBytes ?? 1024 * 1024 });
      }
      result = engine.evaluate(shaped);
      recordEvaluationSkips(result);
    } catch (err) {
      notify(onError, err, 'onError');

      return { blocked: null, client: undefined }; // fail open
    }
    const blocked = decide(
      'request',
      result,
      () => blockResponse(result, request),
      () => null,
      () => requestMeta(shaped, request),
    );

    return { blocked, client: shaped?._clientIp };
  };

  const reqContextFromFetch = (request, client) => {
    try {
      const u = new URL(request.url);
      const headers = headerObject(request.headers);
      // A fetch Request doesn't expose the Host header (it's set at send time), so derive it from the
      // URL — response rules that compare origins (open-redirect / CORS) need the request Host.
      if (!headers.host) headers.host = u.host;
      // `client` is the resolution the request phase already made for this request, when there was one.
      // Resolving again here could disagree with it, and a response detection naming a different address
      // than the request detection for the same request describes two clients that do not exist.
      const resolved = client ?? { ip: null, source: 'unavailable' };

      return {
        method: request.method,
        originalUrl: u.pathname + u.search,
        headers,
        ip: resolved.ip ?? '',
        _clientIp: resolved,
        // The request itself, so the identity can be asked for LATER. This context is built on every
        // request whether or not anything matches, so asking here would mint one for every request —
        // and asking of the context rather than of the request would give the response a different
        // identity from the request that caused it, reporting one call as two.
        _eventOf: request,
      };
    } catch {
      return undefined;
    }
  };
  // The response phase evaluates against the ORIGINATING request, so the resolution travels with it: a
  // response rule reading `server.ip`, and a response detection's record, get the same address the
  // request phase used.
  const reqContextFromNode = (req, client) =>
    req
      ? {
          method: req.method,
          originalUrl: req.url,
          headers: req.headers || {},
          ip: client?.ip ?? '',
          _clientIp: client ?? { ip: null, source: 'unavailable' },
          // The request itself, for the same reasons as on the fetch path above: asked for later, and
          // asked of the request rather than of this context.
          _eventOf: req,
        }
      : undefined;

  // Screen a fetch Response (used by .fetch() and — via protection.screenResponse — the Supabase guard).
  const screenResp = async (response, reqCtx) => {
    const read = await readTextResponse(response, screenCap);
    if (read.skip) {
      // Nothing was screened — a leak/PII rule cannot have applied. Record it (a live stream and a
      // binary body are by design; a body-cap or read failure is a coverage hole worth alerting on).
      if (read.skip !== 'not-a-response') {
        recordSkip('response', read.skip, { status: response?.status, ...(read.encoding ? { encoding: read.encoding } : {}) });
      }
      if (read.skip === 'not-a-response') return response;

      // Header hardening still applies: it needs no body, and a header does not become expensive
      // because the body beside it is large. `readTextResponse` reads a CLONE, so the
      // original body is untouched and can be handed on as it is.
      return hardenHeadersOnly(response, reqCtx);
    }
    const text = read.text;
    const r = screenText(text, { status: response.status, headers: headerObject(response.headers) }, reqCtx);
    if (r.verdict === 'block') return leakResponse();
    if (r.verdict === 'redact') return rebuildResponse(response, r.body, r.headers);
    return response;
  };

  /**
   * Did the mutations actually change a header?
   *
   * Presence and value are separate questions. A header that was absent and is now set is a change
   * whatever it is set to, including the empty string — a rule that sets one deliberately empty is a rule
   * doing something, and folding absence into `''` discards it. Removal is `null`, a change only where
   * the header was there to remove. A multi-valued header (`Set-Cookie`) is compared entry by entry,
   * since hardening one cookie of several is a change and re-emitting them unchanged is not.
   */
  const headerValueChanged = (was, value) => {
    const had = was !== undefined && was !== null;

    if (value === null || value === undefined) return had;
    if (!had) return true;

    if (Array.isArray(value) || Array.isArray(was)) {
      const a = Array.isArray(was) ? was : [was];
      const b = Array.isArray(value) ? value : [value];

      return a.length !== b.length || b.some((item, i) => String(item) !== String(a[i]));
    }

    return String(value) !== String(was);
  };

  const headersChanged = (before, after) =>
    Object.entries(after).some(([name, value]) => headerValueChanged(before[name], value));

  /**
   * The header argument of `writeHead(status[, statusMessage][, headers])`, and how to put changed
   * values back into it.
   *
   * Its shape is preserved. An object cannot carry a name twice, but either array form can — two
   * `Set-Cookie`s — so rebuilding one as an object would silently drop all but the last.
   */
  const writeHeadHeaderIndex = (args) => {
    const at = typeof args[1] === 'string' ? 2 : 1;
    const value = args[at];

    return value !== null && typeof value === 'object' ? at : -1;
  };

  const writeHeadEntries = (headers) => {
    if (!Array.isArray(headers)) return Object.entries(headers);
    // `[[name, value], …]` and a flat `[name, value, name, value, …]` are both accepted here.
    if (headers.length && headers.every((entry) => Array.isArray(entry) && entry.length === 2)) {
      return headers.map(([name, value]) => [String(name), value]);
    }

    const entries = [];
    for (let i = 0; i + 1 < headers.length; i += 2) entries.push([String(headers[i]), headers[i + 1]]);

    return entries;
  };

  /** The same headers as a lower-cased map, a repeated name collapsing into the array it stands for. */
  const writeHeadHeaderObject = (headers) => {
    const out = {};
    for (const [name, value] of writeHeadEntries(headers)) {
      const key = name.toLowerCase();
      appendOwn(out, key, value);
    }

    return out;
  };

  /** `changed` is keyed by lower-cased name; a null or undefined value removes the header. */
  const rewriteWriteHeadHeaders = (headers, changed) => {
    const replaced = new Set();
    const entries = [];

    for (const [name, value] of writeHeadEntries(headers)) {
      const key = name.toLowerCase();
      if (!changed.has(key)) {
        entries.push([name, value]);

        continue;
      }

      // The rule's value stands for every entry under this name, so later ones are dropped rather
      // than left behind next to it.
      if (replaced.has(key)) continue;
      replaced.add(key);

      const replacement = changed.get(key);
      if (replacement === null || replacement === undefined) continue;
      entries.push([name, replacement]);
    }

    // An object holds a multi-valued header as one property whose value is the array, so the array
    // stays whole. Expanded into repeated entries it would reach `Object.fromEntries`, which keeps
    // only the last — two hardened cookies would ship as one.
    if (!Array.isArray(headers)) return Object.fromEntries(entries);

    // An array carries each value under its own copy of the name, so here it is expanded.
    const paired = headers.length > 0 && headers.every((entry) => Array.isArray(entry) && entry.length === 2);
    const expanded = entries.flatMap(([name, value]) =>
      Array.isArray(value) ? value.map((item) => [name, item]) : [[name, value]],
    );

    return paired ? expanded : expanded.flat();
  };

  /**
   * Apply the header mutations that need no body, and pass the body through untouched.
   *
   * Separate from `rebuildResponse`, which replaces a body it has already rewritten: there is no rewritten
   * body here, and reading one to rebuild it would defeat the cap that sent the response down this path.
   */
  const hardenHeadersOnly = (response, reqCtx) => {
    try {
      const meta = { status: response.status, headers: headerObject(response.headers) };
      const r = screenText('', meta, reqCtx, decidedWithoutBody);
      // `block` cannot arise: only header actions, and redactions that have a header span to mask,
      // were eligible.
      if (r.verdict !== 'redact' || !r.headers) return response;

      // A matched rule is not a changed header. `harden-cookie` on a response that sets no cookie,
      // `remove-header` for a header that is absent, and `ensure` where the header is already there all
      // match and mutate nothing. Rebuilding for those replaces the object, drops `Content-Length`, and
      // loses `url`, `redirected` and `type` — on the streamed and binary responses this path exists to
      // hand on untouched.
      if (!headersChanged(meta.headers, r.headers)) return response;

      return rebuildResponse(response, response.body, r.headers);
    } catch (err) {
      // Fail open, like every other path: an unhardened response is worse than none, and a thrown
      // error here would withhold a response the guard was only meant to add a header to.
      notify(onError, err, 'onError');

      return response;
    }
  };

  // Wrap a Node ServerResponse so its (buffered, text) body is screened before it's sent.
  // Opt-in (buffering can delay a streamed response); over 512 KiB it stops buffering and
  // passes through unscanned.
  const wrapNodeResponse = (res, reqCtx) => {
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    // The response's own header operations, for this wrapper's use. While a `writeHead` is held the
    // application sees them throw, as they would once a head was sent — but this wrapper still has to
    // put the hardened and rewritten values in place before the real `writeHead` runs.
    const setHeaderNow = typeof res.setHeader === 'function' ? res.setHeader.bind(res) : null;
    const removeHeaderNow = typeof res.removeHeader === 'function' ? res.removeHeader.bind(res) : null;
    // Whether a head has REALLY gone. `headersSent` is redefined below to include a held one, so the
    // original is kept: a getter on a real ServerResponse, a plain value on a response-like object.
    const sentAccessor = accessorOf(res, 'headersSent');
    let sentValue = sentAccessor ? undefined : res.headersSent;
    const reallySent = () => Boolean(sentAccessor ? sentAccessor.call(res) : sentValue);
    const chunks = [];
    let size = 0;
    let overflow = false;
    const MAX = screenCap;

    /**
     * Header hardening, applied before the first byte leaves.
     *
     * On this path the body is buffered and screened at `end`, but a body over the cap abandons
     * buffering and flushes what it has — and once a byte has gone, the headers have gone with it. So
     * the mutations that need no body are applied up front, where they still can be: over the cap, a
     * binary body, a live stream, or an ordinary one.
     *
     * Runs once, and the rules it answers are then left out of the pass at `end` — a rule that matched
     * has already been reported, and reporting it again would say two responses were hardened when one
     * was. The pass at `end` keeps the rules this one cannot answer, which is how a body-READING
     * hardening rule is still honoured.
     *
     * `content-length` is left alone. The pass at `end` drops it because it rewrote the body; nothing is
     * rewritten here, so the length still describes what the client will receive.
     */
    let hardened = false;
    let answeredWithoutBody = false;
    const hardenBeforeFlush = (effective) => {
      if (hardened) return null;
      hardened = true;
      try {
        // Nothing can be changed once the headers are on the wire, and saying so is better than
        // throwing from inside a write.
        if (reallySent() || !setHeaderNow) return null;

        const set = typeof res.getHeaders === 'function' ? res.getHeaders() : {};
        // What the client will actually receive. `writeHead` supplies its own status and its own
        // headers, and its headers beat anything set beforehand — so a rule judging only the set it
        // does not see would be judging a response nobody gets.
        const headers = effective && effective.headers ? { ...set, ...effective.headers } : set;
        const status = effective && effective.status !== undefined ? effective.status : res.statusCode;
        const r = screenText('', { status, headers }, reqCtx, hardensWithoutBody);
        // These rules have now been evaluated and their detections recorded, whatever the verdict, so
        // the pass at `end` must not evaluate them a second time and report the same detection twice.
        answeredWithoutBody = true;
        if (r.verdict !== 'redact' || !r.headers) return null;

        // `content-length` needs no special handling: nothing here rewrites the body, so the length
        // still describes what the client will receive and the value written back is the one already
        // there. The pass at `end` drops it for the opposite reason.
        const changed = new Map();
        for (const [name, value] of Object.entries(r.headers)) {
          if (!headerValueChanged(headers[name], value)) continue;

          changed.set(name.toLowerCase(), value);
          try {
            if (value === null || value === undefined) removeHeaderNow?.(name);
            else setHeaderNow(name, value);
          } catch {
            // An unusable header name from a rule is skipped, like everywhere else on this path.
          }
        }

        return changed.size ? changed : null;
      } catch (err) {
        notify(onError, err, 'onError');

        return null;
      }
    };

    // The rules the pass above did not answer: the ones that read the body, which is why a
    // body-reading hardening rule is still honoured at `end`.
    const stillToAnswer = (rule) => !hardensWithoutBody(rule);

    /**
     * `writeHead`, held until the first byte actually leaves.
     *
     * Calling it sends the status line and headers, `Content-Length` included — and the body this path
     * screens is not known until `end`, so a head sent early may not describe the body that follows.
     * So the call is recorded, `res` is returned so a chained
     * `.end()` still works, and the real `writeHead` runs when the body is written: with the
     * application's own arguments, the hardened header values put back into them, and — when the body
     * changed — the status and length that describe the body actually sent.
     *
     * Its arguments are what a rule is shown, because they carry the status the response goes out with
     * and headers that beat anything set beforehand. Set with `setHeader` alone, a header the
     * application also passes here would be overwritten on the way out.
     */
    let pendingHead = null;
    // Set once this wrapper starts sending. Node writes an implicit head through `res.writeHead` too,
    // and from then on every call is the real one.
    let sending = false;
    const origWriteHead = typeof res.writeHead === 'function' ? res.writeHead.bind(res) : null;
    if (origWriteHead) {
      res.writeHead = function (...args) {
        if (sending || reallySent()) return origWriteHead(...args); // Node's own behaviour, and its error
        // A head is already held: to the application it has been sent, and a second one is refused the
        // way Node refuses it.
        if (pendingHead) throw headersSentError('write');
        // Node judges the call now, as it would have: an invalid status or header throws its own error
        // here rather than when the body is written, and the status and reason phrase it settles on are
        // the ones a handler reading them afterwards should see.
        const judged = judgeWriteHead(args);
        if (judged) {
          res.statusCode = judged.statusCode;
          res.statusMessage = judged.statusMessage;
          // The header state Node would have left behind, applied while the head is still unheld so the
          // response's own setters accept it.
          mirrorHeaders(judged.headers);
          pendingHead = args;
        } else {
          pendingHead = args;
          if (typeof args[0] === 'number') res.statusCode = args[0];
          if (typeof args[1] === 'string') res.statusMessage = args[1];
        }

        return res;
      };
    }

    /**
     * Node's `writeHead`, run on a detached copy of this response: throws Node's own error, or returns the
     * status, reason phrase and header state Node settled on.
     *
     * A copy rather than a fresh response, because what `writeHead` does depends on the state it finds —
     * a reason phrase already set is kept, and headers already set are merged with the ones it is given,
     * by rules that differ between Node versions. Replaying them on a copy lets Node decide, rather than
     * this wrapper guessing.
     */
    function judgeWriteHead(args) {
      const ServerResponse = nodeHttp?.ServerResponse;
      if (typeof ServerResponse !== 'function') return null;
      const detached = new ServerResponse({ method: res.req?.method ?? 'GET', httpVersionMajor: 1, httpVersionMinor: 1, headers: {} });
      if (res.statusMessage !== undefined) detached.statusMessage = res.statusMessage;
      for (const [name, value] of headerEntries(res)) detached.setHeader(name, value);
      detached.writeHead(...args);

      return { statusCode: detached.statusCode, statusMessage: detached.statusMessage, headers: headerEntries(detached) };
    }

    /** A response's headers under the names they were set with. */
    function headerEntries(target) {
      const names = typeof target.getRawHeaderNames === 'function'
        ? target.getRawHeaderNames()
        : typeof target.getHeaderNames === 'function' ? target.getHeaderNames() : [];

      return names.map((name) => [name, target.getHeader(name)]);
    }

    /**
     * Bring this response's header state to `entries`, touching only the names that differ. `writeHead`
     * only ever adds or replaces headers in that state, so nothing here needs removing.
     */
    function mirrorHeaders(entries) {
      if (!setHeaderNow) return;
      for (const [name, value] of entries) {
        const current = res.getHeader?.(name);
        if (current === undefined || headerValueChanged(current, value)) setHeaderNow(name, value);
      }
    }

    // Everything else the application can observe answers as it would once a head had been sent.
    Object.defineProperty(res, 'headersSent', {
      configurable: true,
      enumerable: true,
      get: () => pendingHead !== null || reallySent(),
      // A response-like object that tracks the flag itself keeps doing so.
      set: (value) => {
        if (!sentAccessor) sentValue = value;
      },
    });
    for (const [method, verb] of [['setHeader', 'set'], ['removeHeader', 'remove'], ['appendHeader', 'append']]) {
      const original = typeof res[method] === 'function' ? res[method].bind(res) : null;
      if (!original) continue;
      res[method] = function (...args) {
        if (pendingHead) throw headersSentError(verb);

        return original(...args);
      };
    }
    // An explicit flush asks for the head now, so it goes now, hardened. The body that follows can then
    // only change where no length was promised, which `end` already accounts for.
    if (typeof res.flushHeaders === 'function') {
      const origFlushHeaders = res.flushHeaders.bind(res);
      res.flushHeaders = function () {
        sendHead();

        return origFlushHeaders();
      };
    }

    /**
     * The hardening that needs no body, run once: before the body is screened, so the pass at `end`
     * leaves out the rules it already answered, and its header values reused when the head is sent.
     */
    let hardenDone = false;
    let hardenedValues = null;
    const hardenOnce = () => {
      if (hardenDone) return hardenedValues;
      hardenDone = true;
      if (!pendingHead) {
        hardenedValues = hardenBeforeFlush();

        return hardenedValues;
      }
      const at = writeHeadHeaderIndex(pendingHead);
      hardenedValues = hardenBeforeFlush({
        status: typeof pendingHead[0] === 'number' ? pendingHead[0] : undefined,
        headers: at === -1 ? null : writeHeadHeaderObject(pendingHead[at]),
      });

      return hardenedValues;
    };

    /** The status and headers the client will receive: the held `writeHead` over what was set. */
    const effectiveHead = () => {
      const set = typeof res.getHeaders === 'function' ? { ...res.getHeaders() } : {};
      // A response-like object with `getHeader` but not `getHeaders` still answers the two names the
      // decision below depends on.
      if (typeof res.getHeaders !== 'function' && typeof res.getHeader === 'function') {
        for (const name of ['content-type', 'content-length']) {
          const value = res.getHeader(name);
          if (value !== undefined) set[name] = value;
        }
      }
      if (!pendingHead) return { status: res.statusCode, headers: set };
      const at = writeHeadHeaderIndex(pendingHead);

      return {
        status: typeof pendingHead[0] === 'number' ? pendingHead[0] : res.statusCode,
        headers: at === -1 ? set : { ...set, ...writeHeadHeaderObject(pendingHead[at]) },
      };
    };

    /**
     * Redactions of header values, for a response whose body will not be screened.
     *
     * Such a rule reads headers only, so it is decided the same way whether or not the body is read — it
     * is run here instead of at `end`, never as well, so it reports once. Returns the changes for
     * `sendHead`, or undefined when there are none. A head that has already gone cannot take them, which
     * is recorded, as it is for a screened body.
     */
    const redactUnreadHeaders = () => {
      try {
        const head = effectiveHead();
        const r = screenText('', head, reqCtx, redactsHeaders);
        if (r.verdict !== 'redact' || !r.headers) return undefined;
        const changed = new Map();
        for (const [name, value] of Object.entries(r.headers)) {
          if (headerValueChanged(head.headers[name], value)) changed.set(name.toLowerCase(), value);
        }
        if (changed.size && reallySent()) {
          recordSkip('response', 'headers-sent', { headers: [...changed.keys()] });

          return undefined;
        }

        return changed.size ? { headers: changed } : undefined;
      } catch (err) {
        notify(onError, err, 'onError');

        return undefined;
      }
    };

    /**
     * Send the head, if the application asked for one explicitly. `changes` is what the screen at `end`
     * decided: a new status, and header values keyed by lower-cased name (null removes one). Applied to
     * both places a header can live — the held arguments and the response's own header state — because
     * whichever holds a name is the one that is sent.
     */
    const sendHead = (changes) => {
      if (sending) return;
      const hardened = hardenOnce();
      sending = true;
      if (!pendingHead) {
        if (changes) applyToResponse(changes);

        return;
      }
      const args = [...pendingHead];
      pendingHead = null;
      const merged = new Map(hardened ?? []);
      for (const [name, value] of changes?.headers ?? []) merged.set(name, value);
      if (changes?.status !== undefined) {
        args[0] = changes.status;
        // A status message belongs to the status it came with.
        if (typeof args[1] === 'string') args.splice(1, 1);
      }
      // Both places a header can live: the held arguments, which beat anything set, and the response's
      // own headers, which Node merges with them — so a name the arguments do not carry still goes out.
      const headerAt = writeHeadHeaderIndex(args);
      if (headerAt !== -1 && merged.size) args[headerAt] = rewriteWriteHeadHeaders(args[headerAt], merged);
      applyToResponse({ headers: merged });
      origWriteHead(...args);
    };

    /** Header changes onto the response's own header state, for the head Node writes implicitly. */
    const applyToResponse = (changes) => {
      if (changes.status !== undefined) res.statusCode = changes.status;
      for (const [name, value] of changes.headers ?? []) {
        try {
          if (value === null || value === undefined) removeHeaderNow?.(name);
          else setHeaderNow?.(name, value);
        } catch {
          // An unusable header name from a rule is skipped, like everywhere else on this path.
        }
      }
    };

    const collect = (chunk, enc) => {
      if (chunk == null) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8');
      size += buf.length;
      if (size > MAX) {
        // Too big to screen — abandon buffering, but FLUSH what we already captured (the head) plus
        // this chunk before switching to pass-through, so the client gets a complete body (not a
        // truncated one missing everything before the cap was hit).
        sendHead(redactUnreadHeaders());
        for (const c of chunks) origWrite(c);
        chunks.length = 0;
        origWrite(buf);
        overflow = true;
        recordSkip('response', 'body-cap', { bytes: size });
        return;
      }
      chunks.push(buf);
    };
    res.write = function (chunk, enc, cb) {
      if (overflow) return origWrite(chunk, enc, cb);
      collect(chunk, enc);
      if (typeof enc === 'function') enc();
      else if (typeof cb === 'function') cb();
      return true;
    };
    res.end = function (chunk, enc, cb) {
      if (typeof chunk === 'function') { cb = chunk; chunk = undefined; enc = undefined; }
      else if (typeof enc === 'function') { cb = enc; enc = undefined; }
      if (overflow) { if (chunk != null) origWrite(chunk, enc); return origEnd(cb); }
      collect(chunk, enc);
      if (overflow) return origEnd(cb); // collect just flushed head + final chunk on overflow
      hardenOnce();

      const passThrough = (changes) => {
        sendHead(changes);
        for (const c of chunks) origWrite(c);

        return origEnd(cb);
      };

      const buffer = Buffer.concat(chunks);
      const head = effectiveHead();
      let ct = head.headers['content-type'];
      if (Array.isArray(ct)) ct = ct[0];
      const kind = screenableContentType(ct);
      // Skip live streams / binary bodies (incl. an octet-stream that sniffs as binary) — untouched.
      if (kind === 'skip' || (kind === 'sniff' && looksBinary(buffer))) {
        recordSkip('response', kind === 'skip' ? (baseContentType(ct) === 'text/event-stream' ? 'live-stream' : 'non-text-content-type') : 'binary-body');

        return passThrough(redactUnreadHeaders());
      }
      // Encoded bytes cannot be screened as text: sent exactly as they are, under their own coding. The
      // coding is read from the head that will be sent, which includes a held `writeHead`'s own headers.
      const codings = declaredCodings(head.headers['content-encoding']);
      if (codings.length > 0 && stillEncoded(buffer)) {
        recordSkip('response', 'encoded-body', { encoding: codings.join(', ') });

        return passThrough(redactUnreadHeaders());
      }
      const text = buffer.toString('utf8');
      let r;
      try {
        r = screenText(text, head, reqCtx, answeredWithoutBody ? stillToAnswer : undefined);
      } catch (err) {
        notify(onError, err, 'onError');

        return passThrough();
      }
      if (r.verdict !== 'block' && r.verdict !== 'redact') return passThrough();

      // The body is about to change, so the head must describe the new one. If the head has already
      // gone — by a route this wrapper does not hold — a changed body can only be sent safely when the
      // response is chunked, since then no length was promised. Anything else is cut off rather than
      // sent under a length it does not have, or sent as the original the verdict was about.
      if (reallySent() && res.chunkedEncoding !== true) {
        notify(onError, new Error('Patchstack: response withheld — its headers were sent before the body could be screened'), 'onError');
        res.destroy?.();

        return res;
      }

      if (r.verdict === 'block') {
        const body = JSON.stringify({ error: 'Response withheld by Patchstack (sensitive data detected)' });
        if (reallySent()) {
          // Chunked, so the body can still change, but the status already went out as the application's.
          res.destroy?.();

          return res;
        }
        // One framing: the length describes this body, so any transfer coding the application chose
        // for its own goes with it.
        sendHead({
          status: 500,
          headers: new Map([
            ['content-type', 'application/json'],
            ['content-length', String(Buffer.byteLength(body))],
            ['transfer-encoding', null],
          ]),
        });

        return origEnd(body, cb);
      }

      // Redact: the rule's header values, and a length for the rewritten body. A length is always
      // replaced rather than left behind, because the one the application set described the original.
      const changed = new Map();
      if (r.headers) {
        for (const [name, value] of Object.entries(r.headers)) {
          if (name.toLowerCase() === 'content-length') continue;
          if (!headerValueChanged(head.headers[name], value)) continue;
          changed.set(name.toLowerCase(), value);
        }
      }
      if (!reallySent()) {
        // The rewritten body keeps the application's framing: a declared length is replaced by the new
        // one (and nothing else frames it), and a response without one is left to its transfer coding.
        const declared = head.headers['content-length'];
        if (declared === undefined) {
          changed.set('content-length', null);
        } else {
          changed.set('content-length', String(Buffer.byteLength(r.body)));
          changed.set('transfer-encoding', null);
        }
        sendHead({ headers: changed });
      } else if (changed.size) {
        // The body is still redacted, but header values cannot follow a head that has gone.
        recordSkip('response', 'headers-sent', { headers: [...changed.keys()] });
      }

      return origEnd(r.body, cb);
    };
  };

  // Egress phase: is this outbound call blocked? (records detection either way)
  const allow = new Set(allowHosts.map((h) => String(h).toLowerCase()));
  const egressShouldBlock = (url, host, method) => {
    if (host && allow.has(host.toLowerCase())) return false;

    // The outbound request's own method and path. An egress detection has no client address and no user
    // agent by nature: the call is the application's, not a visitor's, so there is nobody to attribute it
    // to. Its destination host reaches the report through capture, for a rule that names `egress.url` or
    // `egress.host` — which the internal-host rules do.
    let egressPath = null;
    try {
      const u = new URL(url);
      egressPath = u.pathname + u.search;
    } catch {
      egressPath = typeof url === 'string' ? url : null;
    }

    // Every rule is asked, and every match is reported under its own rule. Two rules matching one call
    // are two matches of one outbound attempt, not two attempts — and the identity below is what says so,
    // so a consumer counting attempts is not counting rules.
    //
    // Minted once for the call, before any rule is asked, so every match on it reports the same one.
    const egressEvent = mintEvent();
    let block = false;
    for (const { rule, engine: re } of egressRuleSet) {
      let result;
      try {
        result = re.evaluate({ _egress: { url, host, method } });
      } catch (err) {
        notify(onError, err, 'onError');

        continue;
      }
      if (!result.blocked) continue;

      // A dry-run rule records the outbound attempt without preventing it. Blocking a request the app
      // makes is at least as disruptive as blocking one it receives.
      const egressMode = ruleMode(rule);

      onDetect({
        phase: 'egress',
        mode: egressMode,
        category: rule?.category,
        rule,
        message: result.message,
        // One identity for this outbound call, shared by every rule that matches it — the egress phase
        // evaluates all of them rather than stopping at the first, so without this two rules refusing one
        // call would count as two calls refused.
        //
        // Its own identity, not the identity of whatever request the application was serving when it made
        // the call. An outbound attempt is a thing that happened in its own right, and a call made outside
        // any request — a job, a timer — has no request to belong to.
        event: egressEvent,
        method: typeof method === 'string' ? method : null,
        path: egressPath,
        capture: evidenceFrom(result),
      });

      // Any enforcing match blocks, whatever else matched and in whatever order: an observing rule
      // beside an enforcing one records the attempt and does not soften it.
      if (egressMode === 'block') block = true;
    }

    return block;
  };

  const protection = {
    get mode() {
      return mode;
    },
    get rules() {
      return { request: requestRules, response: responseRules, egress: egressRules };
    },

    /**
     * Enforcement coverage: how often the guard failed open rather than inspecting, in the cases it can
     * observe itself — keyed `<phase>:<reason>` (e.g. `response:body-cap`, `request:body-cap`,
     * `response:live-stream`, `egress:resolver-failed` for a fetch call whose address could not be
     * resolved). "Always-on" is not "always inspected", so surface this (or pass `onSkip`) rather than
     * assuming coverage.
     *
     * Not a total, in two ways. An outbound call can miss the address check without being counted:
     * whether it resolved through the screening resolver depends on the agent and the socket pool,
     * which this guard cannot observe. And a resolver failure on the node path appears nowhere here
     * because it is not a bypass — that resolver is the connection's, so the call fails instead.
     * Zero skips means nothing the guard can see was bypassed, not that nothing was.
     */
    coverage() {
      return { skipped: { ...skipCounts } };
    },

    // Screen a fetch Response through the response-phase rules (redact/block). Used by
    // .fetch(), and by the Supabase guard on its forwarded upstream response.
    // A standalone response screen with no request phase of its own — the Supabase guard's forwarded
    // upstream response. It resolves once here, which is the only resolution for this call.
    screenResponse: (response, request, ...hostArgs) =>
      screenResp(response, request ? reqContextFromFetch(request, clientForResponse(request, hostArgs)) : undefined),

    // (request) => Response | null   (null = allow, caller proceeds). Request phase only.
    fetchGuard() {
      return async (request, ...hostArgs) => (await screenFetchRequest(request, hostArgs)).blocked;
    },

    // Wrap a fetch handler: screens the request, then the response (redact/block).
    fetch(handler) {
      return async (request, ...rest) => {
        // The request phase's own resolution is carried into the response phase rather than the response
        // screening making a second one. Two resolutions for one request can disagree, and a response
        // detection naming a different address than the request detection describes two clients that do
        // not exist.
        const { blocked, client } = await screenFetchRequest(request, rest);
        if (blocked) return blocked;
        const response = await handler(request, ...rest);

        return screenResp(response, reqContextFromFetch(request, client));
      };
    },

    // Express middleware (request phase; expects express-parsed req.query/req.body).
    // Pass { screenResponses: true } to also screen the outgoing response (buffers it).
    express(exprOptions = {}) {
      return (req, res, next) => {
        let result;
        // Resolved once, before evaluation, and reused by the engine, the response screening and the
        // block record below. Three consumers deriving it separately could attribute one request to
        // three different addresses.
        const { shaped, client } = shapeExpressRequest(req);
        try {
          result = engine.evaluate(shaped);
          recordEvaluationSkips(result);
        } catch (err) {
          notify(onError, err, 'onError');
          if (exprOptions.screenResponses) wrapNodeResponse(res, reqContextFromNode(req, client));
          return next();
        }
        decide(
          'request',
          result,
          () => {
            if (isDocumentNavigation((n) => req.headers?.[n])) {
              res.status(403).type('html').send(renderBlockPage({ url: req.originalUrl || req.url || '/', code: result?.rule?.id }));
            } else {
              res.status(403).json(blockBody(result));
            }
          },
          () => {
            if (exprOptions.screenResponses) wrapNodeResponse(res, reqContextFromNode(req, client));
            next();
          },
          () => nodeRequestMeta(req, client),
        );
      };
    },

    // Node / Connect middleware — buffers the body itself (request phase). Register it BEFORE any body
    // parser: it reads the request stream, and exposes what it read as `req.body` so a parser is not
    // also needed. (`.express()` is the other way round — it reads a body somebody else parsed.)
    // Pass { screenResponses: true } to also screen the outgoing response (buffers it).
    node(nodeOptions = {}) {
      const maxBytes = nodeOptions.maxBodyBytes ?? 1024 * 1024;
      return (req, res, next) => {
        // Registered after a body parser, the stream is already at its end: 'data' and 'end' will not fire
        // again, and waiting for them would hold the request open for as long as the client allows. Screen
        // the body the parser left instead — a guard that stops serving the app is a worse outcome than the
        // registration order it was trying to insist on.
        if (req.readableEnded || req.body !== undefined) {
          screenNodeRequest(req, res, next, '', req.body);
          return;
        }

        // A body longer than the cap is screened up to the cap, as on the Fetch path, and reported.
        readBodyPrefix(req, maxBytes, (err, read) => {
          if (err) {
            notify(onError, err, 'onError');
            next();
            return;
          }
          if (read.overflow) recordSkip('request', 'body-cap', { bytes: read.size, limit: maxBytes });
          if (read.failed) recordSkip('request', 'read-failed', { bytes: read.size });
          screenNodeRequest(req, res, next, read.text, undefined, read.overflow || read.failed);
        });
      };

      // `parsedBody`, when given, is a body somebody else already parsed: it replaces the shaped body
      // rather than being re-serialized, because re-encoding it would have to guess a format and a form
      // body handed back as JSON resolves no `post.<field>` at all. `truncated` says `rawBody` is only the
      // beginning of a longer body.
      function screenNodeRequest(req, res, next, rawBody, parsedBody, truncated = false) {
        let shaped;
        let result;
        try {
          shaped = fromNodeRequest(req, rawBody, { trustedProxy: options.trustedProxy });
          if (parsedBody !== undefined && parsedBody !== null) shaped.body = parsedBody;
          result = engine.evaluate(shaped);
          recordEvaluationSkips(result);
        } catch (err) {
          notify(onError, err, 'onError');
          return next();
        }
        decide(
          'request',
          result,
          () => {
            res.statusCode = 403;
            if (isDocumentNavigation((n) => req.headers?.[n])) {
              res.setHeader('content-type', 'text/html; charset=utf-8');
              res.end(renderBlockPage({ url: req.url || '/', code: result?.rule?.id }));
            } else {
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify(blockBody(result)));
            }
          },
          () => {
            // This guard consumed the request stream to screen it; re-expose the parsed
            // body so a downstream handler (without its own body-parser) can read it. A body cut off at
            // the cap is not re-exposed: what was parsed is only its beginning, not the request's body.
            if (req.body === undefined && !truncated) req.body = shaped.body;
            // The resolution the shaping already made, carried into the response phase and the record.
            if (nodeOptions.screenResponses) wrapNodeResponse(res, reqContextFromNode(req, shaped?._clientIp));
            next();
          },
          () => nodeRequestMeta(req, shaped?._clientIp),
        );
      }
    },
  };

  // Egress interception is opt-in (it wraps the global fetch, and node:http/https on Node).
  if (options.egress) {
    protection.uninstallEgress = await installEgressGuard({
      shouldBlock: egressShouldBlock,
      onBlock: options.onEgressBlock,
      // Route egress coverage gaps (a DNS resolver failure / no resolver on this runtime) into the
      // same skip accounting as the request/response phases.
      onSkip: ({ reason, detail }) => recordSkip('egress', reason, detail),
      dnsScreen: options.screenDns !== false,
      allowHosts,
    });
  }

  // Live rule refresh. The guard otherwise reads its rules once, at process start — so a rule that
  // only becomes relevant after boot (a dependency added mid-session and flagged by Pulse, a
  // zero-day published) never applies until the process restarts. A refresh re-fetches and
  // hot-swaps the engines in place; the same tick can be driven by a poll loop (`refreshMs`), a
  // manual `protection.refresh()`, or an authenticated push (`protection.refreshHandler()`).
  const cwd = options.cwd ?? (typeof process !== 'undefined' ? process.cwd() : undefined);
  const live = Boolean(options.siteUuid || options.token);
  const refreshSecret = options.refreshSecret ?? (typeof process !== 'undefined' ? process.env.PATCHSTACK_REFRESH_SECRET : undefined);
  const refreshable = live && (options.refreshMs > 0 || Boolean(refreshSecret));

  // On the Pulse (siteUuid) path, re-post the dependency manifest before re-fetching. A targeted
  // `npm install <pkg>` fires no npm lifecycle hook, so nothing else re-scans; reporting here lets
  // the server flag a newly-added vulnerable dependency and the SAME tick's rule fetch pick up its
  // rule. Loaded once, up front, only when a refresh path is enabled — a refresh-off production
  // guard never pulls in the scan pipeline; a load/report failure never blocks the rule refresh.
  let reporter = null;
  if (refreshable && options.siteUuid && options.reportManifest !== false && cwd) {
    try {
      ({ reportManifest: reporter } = await import('./refresh-manifest.js'));
    } catch (err) {
      notify(onError, err, 'onError'); // scan pipeline unavailable (e.g. an edge runtime) — rules still refresh
    }
  }

  let recovery = null;
  const runRefreshTick = async () => {
    if (reporter) {
      try {
        await reporter(cwd);
      } catch (err) {
        notify(onError, err, 'onError'); // a failed report must not stop the rule refresh
      }
    }
    // Derived from the origin in force, re-reading the environment, rather than resent from the last
    // reported value: an opt-out that appeared since the previous request has to travel on THIS one. Held
    // in a binding because the acknowledgement below compares against exactly what this request carried.
    const declaredState = stateFor(currentOrigin).state;
    const next = await resolveRules(options, store, {
      timeoutMs: options.refreshTimeoutMs,
      pulseAuth,
      detectionState: declaredState,
    });
    mode = resolveMode(options, next);
    applyBundle(next);
    noteRuleSource(next.source);
    if (next.source?.ok !== false) recovery?.stop();
    // Recomputed from the origin this refresh resolved. Within one process the reachable changes are a
    // rules source that STARTS being the platform's, and an opt-out appearing in the environment. It
    // cannot stop being the platform's: once a bundle has been accepted the memory tier holds it, so a
    // later failed fetch still resolves to `cache`. The credential is resolved once at boot.
    await applyAndAcknowledge(next.source?.origin, declaredState);
    // After the swap, and only after it: later detections belong to the bundle now running. A refresh
    // that fell back to the cached or bundled ruleset kept the previous rules, and `store.read()` then
    // still holds the previous identity — which is exactly the answer that stays true.
    if (detections) detections.setRulesEtag((await store.read())?.etag ?? null);

    // The tick's own outcome, separate from the guard's. `resolveRules` deliberately absorbs an API or
    // network failure and returns usable rules, which is right for protection and wrong for a poller:
    // a scheduler that only counts THROWN errors reads a fleet-wide outage as a healthy poll and keeps
    // knocking at the normal interval. Reported, not thrown — a caller's manual `refresh()` must not
    // start failing because the platform is down and the cached rules held.
    return next.source ?? { ok: true };
  };

  // Every trigger below goes through this, so no two refreshes ever run at once.
  const refreshTick = serialise(runRefreshTick);

  if (live) {
    // Manual one-shot refresh (also the primitive the loop + push endpoint run).
    protection.refresh = () => refreshTick();
    // Authenticated push endpoint — the platform/SaaS hits it for an immediate refresh. No secret
    // configured → the handler 404s (never an open refresh trigger).
    protection.refreshHandler = () => makeRefreshHandler(refreshTick, refreshSecret);
  }

  const loop = options.refreshMs > 0 && live
    ? startRefresh(refreshTick, { refreshMs: options.refreshMs, onError })
    : null;
  // No loop to try again later, and the first resolution was not clean: retry until it is, rather than
  // serving stale or fallback rules for the life of the process. Only with a credential to ask with: the
  // site-addressed rules endpoint refuses a request without one, the credential is resolved once at
  // boot, and asking again every ten minutes forever would change nothing. The boot warning above
  // already says what is missing.
  const canAsk = Boolean(options.token || pulseAuth);
  recovery = live && canAsk && !loop && ruleSource.ok === false ? startRecovery(refreshTick, { onError }) : null;

  // One method, always present, that reaches everything holding a timer, a buffer or a process-wide
  // hook: the refresh loop, the block log, the detection reporter, the outbound screen. Always present
  // because a lifecycle method that exists only for some configurations is one a caller cannot rely on
  // — and each of these components can be the only one installed, so any of them can be the one left
  // running.
  //
  // Returns a promise that settles when the reporter has finished draining, so a host shutting down can
  // await it rather than racing the last batch against process exit. Bounded and best-effort — a runtime
  // that terminates regardless still wins — and ignoring the return behaves exactly as before.
  protection.stop = () => {
    loop?.stop();
    recovery?.stop();
    // This protection's outbound screen leaves the shared guard; other protections keep theirs.
    protection.uninstallEgress?.();
    // Both reporters, because the promise says every buffer this reaches is finished with. Waiting only
    // for one would resolve while the other still had records outstanding — and resolve immediately in a
    // configuration where the one being waited for was never built.
    const outstanding = [firewallLog?.stop(), detections?.stop()].filter(
      (wait) => wait && typeof wait.then === 'function',
    );

    return Promise.all(outstanding).then(() => undefined);
  };
  // The rule refresh only: the poll loop and the recovery retries. The reporters and this protection's
  // outbound screen keep running; `stop()` ends those as well.
  protection.stopRefresh = () => {
    loop?.stop();
    recovery?.stop();

    return Promise.resolve();
  };
  // Which of the three states reporting is in: requested and running, requested but undeliverable, or
  // not requested. A boolean would collapse the middle one into "off", which is the reassuring reading.
  // A getter, because the state follows refreshes: a property assigned once would report the boot value
  // for the life of the process, including after reporting started or stopped.
  Object.defineProperty(protection, 'ruleSource', {
    get: () => ({ ...ruleSource }),
    enumerable: true,
  });
  Object.defineProperty(protection, 'detectionReporting', {
    get: () => detectionReporting,
    enumerable: true,
  });
  // Delivery health while there is a reporter: what was attempted, acknowledged, refused, and dropped.
  // Undefined when there is none, so "no reporter" and "a reporter with nothing to show" stay apart.
  Object.defineProperty(protection, 'detectionHealth', {
    get: () => (detections ? () => detections.health() : undefined),
    enumerable: true,
  });
  // The same for the block log, when there is one: accepted, delivered, failed, dropped, and still queued.
  Object.defineProperty(protection, 'blockLogHealth', {
    get: () => (firewallLog ? () => firewallLog.health() : undefined),
    enumerable: true,
  });

  return protection;
}

/** The accessor behind `name` on `obj` or its prototype chain, or null when it is a plain value. */
function accessorOf(obj, name) {
  for (let o = obj; o; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, name);
    if (d) return typeof d.get === 'function' ? d.get : null;
  }
  return null;
}

/** The error Node raises for a header operation once the head has gone. */
function headersSentError(verb) {
  return Object.assign(new Error(`Cannot ${verb} headers after they are sent to the client`), { code: 'ERR_HTTP_HEADERS_SENT' });
}

/**
 * Resolve runtime enforcement mode.
 * Precedence: PATCHSTACK_MODE env > Pulse `enforcement` on the rules bundle > options.mode > dry-run.
 */
function resolveMode(options, bundle) {
  const env = typeof process !== 'undefined' ? process.env?.PATCHSTACK_MODE : undefined;
  if (env === 'block' || env === 'dry-run') return env;
  if (bundle?.enforcement === 'block' || bundle?.enforcement === 'dry-run') return bundle.enforcement;
  if (options?.mode === 'block') return 'block';
  if (options?.mode === 'dry-run') return 'dry-run';
  return 'dry-run';
}

/**
 * The two files a credential can live in, in the order they are read.
 *
 * Setup writes the credential to the local file and the public identity to the other one, because the
 * public file is meant to be committed. The committed file is still read second: installs that predate
 * the split keep their credential there, and a guard that stopped authenticating on upgrade would lose
 * live rules and reporting on every one of them.
 */
const CREDENTIAL_FILES = ['.patchstackrc.local.json', '.patchstackrc.json'];

/**
 * A credential field from the config files, or undefined.
 *
 * fs/path are imported LAZILY — this module must stay loadable on edge runtimes (Next edge middleware,
 * Workers, Deno, Supabase Functions), where a static `node:fs` import fails to resolve and would take the
 * guard down.
 */
async function readCredentialField(options, field) {
  if (typeof process === 'undefined' || typeof process.cwd !== 'function') return undefined;

  let readFileSync;
  let join;
  try {
    const [fs, pathMod] = await Promise.all([import('node:fs'), import('node:path')]);
    readFileSync = fs.readFileSync;
    join = pathMod.join;
  } catch {
    return undefined; // no filesystem on this runtime
  }

  const cwd = options?.cwd ?? process.cwd();
  for (const filename of CREDENTIAL_FILES) {
    try {
      const value = JSON.parse(readFileSync(join(cwd, filename), 'utf8'))?.[field];
      if (typeof value === 'string' && value.length > 0) return value;
    } catch {
      /* missing or unparseable — try the next one */
    }
  }

  return undefined;
}

/** WP-format api_key for connector /api/logs/log. Never use the public site UUID. */
async function resolveApiKey(options) {
  if (typeof options?.apiKey === 'string' && options.apiKey.length > 0) return options.apiKey;
  if (typeof process !== 'undefined') {
    const fromEnv = process.env?.PATCHSTACK_API_KEY;
    if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  }

  return readCredentialField(options, 'apiKey');
}

/**
 * Credential for the authenticated rules lookup (ADR-0018). Same resolution
 * order and the same edge-runtime caution as resolveApiKey, and falls back to
 * it so guards installed before pulseAuth existed keep authenticating.
 *
 * Returning undefined does not fail the boot — protection still runs on the cached or bundled rules —
 * but the fetch then goes out unauthenticated and the platform refuses it, so the guard stops receiving
 * rules. That is why the caller warns about it at boot rather than treating it as a normal state.
 */
async function resolvePulseAuth(options) {
  if (typeof options?.pulseAuth === 'string' && options.pulseAuth.length > 0) return options.pulseAuth;
  if (typeof process !== 'undefined') {
    const fromEnv = process.env?.PATCHSTACK_PULSE_AUTH;
    if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  }
  const fromFile = await readCredentialField(options, 'pulseAuth');
  if (fromFile !== undefined) return fromFile;

  return resolveApiKey(options);
}

// --- phase / response helpers -------------------------------------------

function byPhase(rules, phase) {
  return (rules ?? []).filter((r) => (r.phase ?? 'request') === phase);
}

// Classify a content-type for response screening: 'text' = screen; 'sniff' = screen only if the
// bytes aren't binary (octet-stream is often a misdeclared JSON export/config); 'skip' = pass
// through unscreened (live streams, known binary families). SSE is matched on the EXACT base type,
// not a loose substring — `application/json; profile="event-stream"` is not a stream.
function baseContentType(ct) {
  return String(ct || '').toLowerCase().split(';')[0].trim();
}
function screenableContentType(ct) {
  const base = baseContentType(ct);
  if (base === 'text/event-stream') return 'skip'; // live token/SSE stream — never buffer
  if (base === '') return 'text';
  if (/(json|text|xml|html|javascript|csv|yaml|x-www-form-urlencoded)/.test(base)) return 'text';
  if (base === 'application/octet-stream') return 'sniff'; // maybe a text/JSON export mislabeled
  return 'skip'; // image/video/audio/font/pdf/zip/wasm/… — don't buffer binary
}
/** What a response rule's prefilter looks for its anchors in, lower-cased: the body and every header value. */
function prefilterText(body, headers) {
  const values = [];
  for (const value of Object.values(headers ?? {})) {
    if (Array.isArray(value)) values.push(...value.map(String));
    else if (value !== undefined && value !== null) values.push(String(value));
  }

  return [body, ...values].join('\n').toLowerCase();
}

// Cheap binary sniff over a byte prefix: a NUL byte, or many control chars, means "don't treat as text".
function looksBinary(bytes) {
  const n = Math.min(bytes.length, 512);
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) ctrl++;
  }
  return n > 0 && ctrl / n > 0.1;
}

/** The content codings a `Content-Encoding` value declares, `identity` left out. Empty: not encoded. */
function declaredCodings(value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '');

  return raw.toLowerCase().split(',').map((c) => c.trim()).filter((c) => c !== '' && c !== 'identity');
}

/**
 * Whether a body under a declared content coding is still encoded — not readable as text.
 *
 * The header alone does not say: `fetch()` decodes a compressed response and keeps its
 * `Content-Encoding`, so a proxied response can declare `gzip` and carry plain text. Encoded output is
 * binary-looking or not valid UTF-8; text that is neither is read as the text it is.
 */
function stillEncoded(bytes) {
  if (looksBinary(bytes)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);

    return false;
  } catch {
    return true;
  }
}

// Returns { text } when the body was fully buffered for screening, or { skip: <reason> } when it was
// NOT screened — the reason is surfaced to `onSkip`/coverage so a fail-open bypass is observable
// instead of silent (an unscreened response is a real hole in enforcement).
async function readTextResponse(response, cap = DEFAULT_SCREEN_CAP) {
  if (!response || typeof response.clone !== 'function') return { skip: 'not-a-response' };
  const ct = response.headers?.get?.('content-type') || '';
  const kind = screenableContentType(ct);
  if (kind === 'skip') return { skip: baseContentType(ct) === 'text/event-stream' ? 'live-stream' : 'non-text-content-type' };
  const codings = declaredCodings(response.headers?.get?.('content-encoding'));
  const encodedSkip = () => ({ skip: 'encoded-body', encoding: codings.join(', ') });
  const sniff = kind === 'sniff';
  const len = Number(response.headers?.get?.('content-length') || 0);
  if (len && len > cap) return { skip: 'body-cap' };
  let clone;
  try {
    clone = response.clone();
  } catch {
    return { skip: 'clone-failed' };
  }

  // Read only through the cap. Cancelling the clone at that point keeps the unread original branch from
  // making the stream tee retain the remainder before the response is handed back.
  const body = clone.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let size = 0;
    let sniffed = !sniff;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (!sniffed) {
          sniffed = true;
          if (looksBinary(value)) {
            void reader.cancel().catch(() => {});
            return { skip: 'binary-body' };
          }
        }
        size += value.byteLength;
        if (size >= cap) {
          void reader.cancel().catch(() => {});
          return { skip: 'body-cap' };
        }
        chunks.push(value);
      }
    } catch {
      void reader.cancel().catch(() => {});
      return { skip: 'read-failed' };
    } finally {
      reader.releaseLock();
    }
    const bytes = concatBytes(chunks, size);
    if (codings.length > 0 && stillEncoded(bytes)) return encodedSkip();
    try {
      return { text: new TextDecoder().decode(bytes) };
    } catch {
      return { skip: 'decode-failed' };
    }
  }

  try {
    if (codings.length > 0) {
      const bytes = new Uint8Array(await clone.arrayBuffer());
      if (bytes.byteLength > cap) return { skip: 'body-cap' };
      if (stillEncoded(bytes)) return encodedSkip();

      return { text: new TextDecoder().decode(bytes) };
    }
    const text = await clone.text();
    if (text.length > cap) return { skip: 'body-cap' };
    if (sniff && looksBinary(new TextEncoder().encode(text.slice(0, 512)))) return { skip: 'binary-body' };
    return { text };
  } catch {
    return { skip: 'read-failed' };
  }
}

function concatBytes(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function headerObject(headers) {
  const out = {};
  headers?.forEach?.((v, k) => { setOwn(out, k.toLowerCase(), v); });
  // Set-Cookie is multi-valued; forEach collapses it. Recover the individual cookies so each can
  // be screened (and re-emitted) separately.
  const setCookies = headers?.getSetCookie?.();
  if (setCookies && setCookies.length) setOwn(out, 'set-cookie', setCookies);
  return out;
}

// True if any of the rule's conditions carries a body-transforming mutation on a SPAN match
// (regex/contains/stripos) — those decode the body before matching, so a span redactor derived from
// the literal/regex can't be located in the raw body. (array_key_value structural redaction decodes
// the JSON itself, so json_decode there is fine and doesn't count.)
function hasSpanMutations(rule) {
  let found = false;
  const walk = (conds) => {
    for (const c of conds ?? []) {
      if (found) return;
      if (Array.isArray(c.rules)) walk(c.rules);
      const isSpan = c.match && (c.match.type === 'regex' || c.match.type === 'contains' || c.match.type === 'stripos');
      if (isSpan && Array.isArray(c.mutations) && c.mutations.length) found = true;
    }
  };
  walk(rule.rule_v2);
  return found;
}

// Derive redaction targets from a rule's own conditions: regex → mask every match;
// contains/stripos → mask the literal. (Other match types can't identify a span → the
// rule falls back to block.)
function extractRedactors(rule) {
  const out = [];
  const walk = (conds) => {
    for (const c of conds ?? []) {
      if (Array.isArray(c.rules)) walk(c.rules);
      const m = c.match;
      if (!m) continue;
      if (m.type === 'regex' && typeof m.value === 'string') {
        // Route through the SAME ReDoS guard detection uses — a catastrophic redactor pattern must
        // not hang the response path (safeRegExp returns null for dangerous/invalid patterns → skip).
        const safe = safeRegExp(m.value);
        if (safe) {
          const flags = safe.flags.includes('g') ? safe.flags : safe.flags + 'g';
          try {
            out.push({ re: new RegExp(safe.source, flags) });
          } catch {
            /* skip invalid */
          }
        }
      } else if ((m.type === 'contains' || m.type === 'stripos') && m.value != null) {
        out.push({ literal: String(m.value) });
      } else if (m.type === 'jwt_claim_equals' && typeof m.claim === 'string') {
        // A span-producing target, not a predicate. A boolean-only matcher would leave `redact` with
        // no span to mask, so the rule would fall back to withholding the WHOLE response — turning a
        // one-token leak into an outage. The spans come from the same `jwtClaimSpans` the matcher
        // used, so what is reported and what is masked cannot diverge.
        out.push({ jwtClaim: { claim: m.claim, value: String(m.value ?? '') } });
      } else if (m.type === 'array_key_value' && m.match && isBodyParam(c.parameter)) {
        // Structural redaction: mask the value at a JSON path (fanning out over arrays) rather than
        // a text span — e.g. key "orders.customers.email" masks that field in every array element.
        const keys = Array.isArray(m.key) ? m.key : [m.key];
        for (const key of keys) {
          out.push({ jsonPath: String(key).split('.'), condition: m.match });
        }
      }
    }
  };
  walk(rule.rule_v2);
  return out;
}

// HTML-entity escape, for the `encode` action (neutralize markup rather than mask it). NOTE: this is
// sound only for HTML text / attribute-VALUE contexts. It does NOT neutralize a `javascript:` / `data:`
// URI or an event-handler name (those carry no HTML metacharacters) — use `block` for a rule that
// targets a URL/scheme context. See the rule-authoring guidance in the triage-vpatch-npm skill.
function htmlEscape(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function isJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// JSON token kinds. Punctuation is its own character code, so equal kinds mean equal punctuation.
const JSON_STRING = 1;
const JSON_NUMBER = 2;
const JSON_LITERAL = 3;
const JSON_NUMBER_TOKEN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

function isHexCode(c) {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}

// A string segment with no escape or control character, which needs no character-by-character check.
const PLAIN_STRING_SEGMENT = /^[^"\\\u0000-\u001f]*$/;

/**
 * Split text into JSON tokens in one pass, or `null` when any token is not lexically valid JSON: only
 * JSON's own whitespace between tokens, and every string's escapes and characters checked as a parser
 * checks them. Grammar is not checked here: two token sequences of the same kinds, one of them a valid
 * document, are both valid. Token `k` is `kinds[k]` over `text.slice(spans[2k], spans[2k + 1])`.
 */
function lexJson(text) {
  let kinds = new Int32Array(1024);
  let spans = new Int32Array(2048);
  let count = 0;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
      i++;
      continue;
    }
    const start = i;
    let kind;
    if (c === 0x22) {
      i++;
      const close = text.indexOf('"', i);
      if (close === -1) return null;
      if (PLAIN_STRING_SEGMENT.test(text.slice(i, close))) {
        i = close;
      } else {
        for (;;) {
          if (i >= n) return null;
          const d = text.charCodeAt(i);
          if (d === 0x22) break;
          if (d < 0x20) return null;
          if (d !== 0x5c) {
            i++;
            continue;
          }
          const e = text.charCodeAt(i + 1);
          if (e === 0x75) {
            for (let k = 2; k < 6; k++) if (!isHexCode(text.charCodeAt(i + k))) return null;
            i += 6;
          } else if (e === 0x22 || e === 0x5c || e === 0x2f || e === 0x62 || e === 0x66 || e === 0x6e || e === 0x72 || e === 0x74) {
            i += 2;
          } else {
            return null;
          }
        }
      }
      i++;
      kind = JSON_STRING;
    } else if (c === 0x7b || c === 0x7d || c === 0x5b || c === 0x5d || c === 0x3a || c === 0x2c) {
      i++;
      kind = c;
    } else if (text.startsWith('true', i) || text.startsWith('null', i)) {
      i += 4;
      kind = JSON_LITERAL;
    } else if (text.startsWith('false', i)) {
      i += 5;
      kind = JSON_LITERAL;
    } else {
      JSON_NUMBER_TOKEN.lastIndex = i;
      if (!JSON_NUMBER_TOKEN.test(text)) return null;
      i = JSON_NUMBER_TOKEN.lastIndex;
      kind = JSON_NUMBER;
    }
    if (count === kinds.length) {
      const grownKinds = new Int32Array(count * 2);
      grownKinds.set(kinds);
      kinds = grownKinds;
      const grownSpans = new Int32Array(count * 4);
      grownSpans.set(spans);
      spans = grownSpans;
    }
    kinds[count] = kind;
    spans[2 * count] = start;
    spans[2 * count + 1] = i;
    count++;
  }
  return { kinds, spans, count };
}

/**
 * Does `after` keep the structure of the valid JSON document `before`? String values are the only
 * interchangeable tokens: punctuation, key names and every other value stay exact, including number
 * spellings and repeated keys. The token kinds match one for one and every token lexes, so `after`
 * is also a valid document.
 */
function sameJsonStructure(beforeText, before, afterText, after) {
  if (!before || !after || before.count !== after.count) return false;
  const { kinds, spans, count } = before;
  for (let k = 0; k < count; k++) {
    const kind = kinds[k];
    if (after.kinds[k] !== kind) return false;
    if (kind > JSON_LITERAL) continue; // punctuation: the kind is the character
    if (kind === JSON_STRING && kinds[k + 1] !== 0x3a) continue; // a string value may change
    const was = beforeText.slice(spans[2 * k], spans[2 * k + 1]);
    const now = afterText.slice(after.spans[2 * k], after.spans[2 * k + 1]);
    if (was === now) continue;
    // A key may be spelled with different escapes and still name the same member.
    if (kind !== JSON_STRING || JSON.parse(was) !== JSON.parse(now)) return false;
  }
  return true;
}

// `transform` (optional): map a matched span to its replacement (the `encode` action passes
// htmlEscape). Without it, matches are replaced by the `mask` string (the `redact` action).
function applyRedactors(body, redactors, mask, transform) {
  let out = body;
  for (const r of redactors) {
    if (r.re) out = out.replace(r.re, transform ? (m) => transform(m) : mask);
    else if (r.jwtClaim) {
      // Spans are computed against the body as it stands, then each distinct token is replaced
      // literally — so a response carrying two matching tokens loses both, and a token that appears
      // twice loses both copies.
      for (const token of jwtClaimSpans(out, r.jwtClaim.claim, r.jwtClaim.value)) {
        out = out.split(token).join(transform ? transform(token) : mask);
      }
    } else if (r.literal) {
      // Detection (matchValue for contains/stripos) is case-insensitive, so mask case-insensitively
      // too — otherwise a `contains: "SECRET"` redactor detects `secret` but masks nothing, serving
      // the leak while reporting a redaction. Escape the literal so it matches literally, not as regex.
      const re = new RegExp(r.literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      out = out.replace(re, (m) => (transform ? transform(m) : mask));
    }
  }
  return out;
}

// A response-body redaction target (array_key_value masks the JSON body). A bare condition with no
// parameter also defaults to the body.
function isBodyParam(parameter) {
  return parameter == null || parameter === 'response.body' || parameter === 'raw' || parameter === 'response.raw';
}

// Build a predicate from the array_key_value nested match, so a path can be masked conditionally
// (only leaves that match) or — with `isset` — unconditionally. Fail-closed (don't mask) on error.
function conditionPredicate(condition) {
  if (!condition || !condition.type) return () => true;
  return (value) => {
    try {
      return matchValue(condition.type, value, condition.value, condition);
    } catch {
      return false;
    }
  };
}

const DEFAULT_SCREEN_CAP = 512 * 1024;

// Effective response-screening size cap for a rule set. Bodies larger than this are passed through
// UNSCREENED (so a redact rule can't mask them — the leak/PII would slip out). A rule can raise the
// ceiling for the whole response phase: `bypass_limit: true` removes the cap entirely (accepts the
// memory cost on a hostile large body), or `max_bytes: <n>` raises it to n. The cap is shared (the
// body is buffered once), so the effective cap is the MAX across all active response rules.
function responseScreenCap(rules) {
  let cap = DEFAULT_SCREEN_CAP;
  for (const r of rules ?? []) {
    if (r && r.bypass_limit === true) return Infinity;
    const n = Number(r && r.max_bytes);
    if (Number.isFinite(n) && n > cap) cap = n;
  }
  return cap;
}

// Apply jsonPath redactors structurally: parse the JSON body, mask each targeted leaf (fanning out
// over arrays at every path segment), re-serialize. Fail-open — a non-JSON / oversized / unparseable
// body is returned unchanged, and any per-leaf error is swallowed.
function applyPathRedactors(text, pathRedactors, mask, cap, transform) {
  if (!pathRedactors.length || typeof text !== 'string' || text.length > cap) return text;
  const head = text.trimStart()[0];
  if (head !== '{' && head !== '[') return text; // not a JSON object/array
  // Preserve every number token across the parse→stringify round-trip: JSON.parse would round a
  // 20-digit id or a long decimal, turn `1e400` into null and respell `1E2` or `-0`. Each number is
  // quoted to a placeholder string before parsing and unquoted after stringifying, so every leaf the
  // masking leaves alone keeps its exact spelling.
  let preserved;
  let obj;
  try {
    // Only valid JSON reaches tokenization; malformed intermediate text is not a token source.
    JSON.parse(text);
    preserved = preserveNumbers(text, mask);
    obj = JSON.parse(preserved.text);
  } catch {
    return text;
  }
  let changed = false;
  for (const r of pathRedactors) {
    const pred = conditionPredicate(r.condition);
    walkLeaves(obj, r.jsonPath, (loc) => {
      try {
        const number = preserved.numbers.get(loc.value);
        // Detection uses JSON.parse's numeric value. Match that same value, while retaining the
        // original token for any untouched leaf and for string transformations.
        if (pred(number === undefined ? loc.value : Number(number))) {
          // `encode`: escape the leaf's own value in place; `redact`: replace it with the mask.
          setOwn(loc.parent, loc.key, transform ? transform(number ?? String(loc.value)) : mask);
          changed = true;
        }
      } catch {
        /* skip this leaf */
      }
    });
  }
  return changed ? restoreNumbers(JSON.stringify(obj), preserved.numbers) : text;
}

// Replace every whole number token, never a digit sequence inside a string, with a placeholder.
// The placeholders are unique to this document and cannot alias a literal string or the mask.
function preserveNumbers(text, mask) {
  const occupied = new Set([mask]);
  const found = [];
  const tokens = /"(?:[^"\\]|\\[\s\S])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token[0] === '"') occupied.add(JSON.parse(token));
    else found.push({ start: match.index, token });
  }
  const numbers = new Map();
  const chunks = [];
  let offset = 0;
  let index = 0;
  for (const { start, token } of found) {
    let marker;
    do { marker = '__PSNUMBER_' + index++ + '__'; } while (occupied.has(marker));
    numbers.set(marker, token);
    chunks.push(text.slice(offset, start), JSON.stringify(marker));
    offset = start + token.length;
  }
  chunks.push(text.slice(offset));
  return { text: chunks.join(''), numbers };
}

function restoreNumbers(text, numbers) {
  return text.replace(/"(__PSNUMBER_\d+__)"/g, (token, marker) => numbers.get(marker) ?? token);
}

// Response-hardening actions. Mutate the (lowercase-keyed) headers object in place; a `null` value
// signals removal to rebuildResponse / the node path. `set-header` sets/overwrites (or `ensure`s only
// when absent); `remove-header` strips; `harden-cookie` adds missing HttpOnly/Secure/SameSite flags.
function isHeaderMutation(action) {
  return action === 'set-header' || action === 'remove-header' || action === 'harden-cookie';
}

function applyHeaderMutation(headers, rule) {
  if (rule.action === 'remove-header') {
    for (const name of rule.remove_headers ?? []) setOwn(headers, String(name).toLowerCase(), null);
    return;
  }
  if (rule.action === 'set-header') {
    const ensure = rule.ensure === true; // set only when the header is absent (don't clobber)
    for (const [name, value] of Object.entries(rule.set_headers ?? {})) {
      const key = String(name).toLowerCase();
      const present = headers[key] != null && headers[key] !== '';
      if (ensure && present) continue;
      setOwn(headers, key, String(value));
    }
    return;
  }
  if (rule.action === 'harden-cookie') {
    const cookie = headers['set-cookie'];
    const flags = rule.cookie_flags ?? {};
    if (Array.isArray(cookie)) {
      headers['set-cookie'] = cookie.map((c) => (typeof c === 'string' ? hardenCookie(c, flags) : c));
    } else if (typeof cookie === 'string') {
      headers['set-cookie'] = hardenCookie(cookie, flags);
    }
  }
}

// `SameSite` takes exactly three values, and the flag is interpolated into the header — so anything
// else is either ignored by the browser or appends further cookie attributes (`Lax; Domain=…`). The
// contract refuses such a rule, and this drops it if one arrives anyway.
const SAME_SITE = ['Strict', 'Lax', 'None'];

function hardenCookie(cookie, { httpOnly = true, secure = true, sameSite = 'Lax' } = {}) {
  let out = String(cookie);
  if (httpOnly && !/;\s*httponly/i.test(out)) out += '; HttpOnly';
  if (secure && !/;\s*secure/i.test(out)) out += '; Secure';
  const canonical = SAME_SITE.find((v) => typeof sameSite === 'string' && v.toLowerCase() === sameSite.toLowerCase());
  if (canonical && !/;\s*samesite\s*=/i.test(out)) out += `; SameSite=${canonical}`;
  return out;
}

function rebuildResponse(response, body, redactedHeaders) {
  const headers = new Headers(response.headers);
  headers.delete('content-length'); // body length changed after redaction
  if (redactedHeaders) {
    for (const [name, value] of Object.entries(redactedHeaders)) {
      if (value === null || value === undefined) {
        try { headers.delete(name); } catch { /* skip */ } // header-mutation removal
      } else if (typeof value === 'string') {
        // Both `get` and `set` are inside the guard, because `Headers` rejects an invalid field name on
        // either. An unusable name supplied by a rule is skipped, which is what keeps response
        // screening fail-open.
        try {
          if (headers.get(name) !== value) headers.set(name, value);
        } catch { /* invalid header name — skip */ }
      } else if (Array.isArray(value)) {
        // Re-emit each (possibly redacted) Set-Cookie separately (Headers collapses them otherwise).
        try {
          headers.delete(name);
          for (const item of value) headers.append(name, String(item));
        } catch { /* skip */ }
      }
    }
  }
  // Null-body statuses (204/205/304/101) must not carry a body, or the Response constructor throws.
  const nullBody = response.status === 101 || response.status === 204 || response.status === 205 || response.status === 304;
  return new Response(nullBody ? null : body, { status: response.status, statusText: response.statusText, headers });
}

function leakResponse() {
  return new Response(JSON.stringify({ error: 'Response withheld by Patchstack (sensitive data detected)' }), {
    status: 500,
    headers: { 'content-type': 'application/json' }
  });
}

// (rule source / tiered store moved to ./rules/source.js + ./rules/store.js)

// --- responses ----------------------------------------------------------

// Client-facing block text — deliberately generic: no WAF narrative, no rule title. The reason
// detail stays in the server-side log via onDetect.
const BLOCK_MESSAGE = 'This request has been blocked by Patchstack.';

function blockBody(result) {
  // Human text is masked (no WAF narrative, no rule title). The opaque rule id stays for machine
  // consumers (server-fn receipts, support reference); full rule detail lives in the server log.
  return { error: BLOCK_MESSAGE, message: BLOCK_MESSAGE, rule: result?.rule?.id };
}

// A top-level document navigation (vs an XHR/fetch)? Browsers set Sec-Fetch-Dest on navigations;
// fall back to the Accept header. Governs whether a block returns the HTML page or JSON.
function isDocumentNavigation(getHeader) {
  const dest = getHeader('sec-fetch-dest');
  if (dest) return dest === 'document';
  return (getHeader('accept') || '').includes('text/html');
}

// Request-phase block. Serves the branded HTML "Access Denied" page to a browser navigation, and
// masked JSON to XHR/fetch/programmatic clients.
function blockResponse(result, request) {
  if (request && isDocumentNavigation((n) => request.headers.get(n))) {
    return new Response(renderBlockPage({ url: request.url, code: result?.rule?.id }), {
      status: 403,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
  return new Response(JSON.stringify(blockBody(result)), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
}

function defaultOnDetect({ phase, mode, category, rule, message }) {
  const tag = mode === 'block' ? 'BLOCK' : 'DETECT (dry-run)';
  console.warn(`[patchstack] ${tag} phase=${phase ?? 'request'} category=${category ?? '?'} rule=${rule?.id ?? '?'} ${message ?? ''}`.trim());
}

/**
 * Request metadata for a detection or a block record, using the address already resolved for it.
 *
 * `shaped` is the object the engine evaluated, which carries the one resolution for this request. The
 * original request is only consulted for the path, the method and the user agent — never for an address,
 * because a second derivation could disagree with the first and attribute one request to two clients.
 *
 * @param {{ ip?: string, _clientIp?: { ip: string | null, source: string } } | undefined} shaped
 * @param {Request | undefined} request
 */
/**
 * The identity of the event a detection belongs to.
 *
 * A detection says a rule matched. It does not say WHAT it matched, so two detections cannot be told
 * apart as one call two rules saw from two separate calls — and two rules matching one call is the
 * ordinary case, not an edge one: a rule that enforces and a rule that only observes are meant to match
 * the same thing, and the response phase and the egress phase both evaluate every rule rather than
 * stopping at the first match. Without an identity, anything adding those counts up reports one call
 * more than once.
 *
 * Drawn from randomness, and nothing about the request goes into it — not the address, not the path, not
 * a header — because it is only ever compared with other identities, and anything derived from the
 * request would carry something about whoever made it into a place nothing needs it.
 *
 * That is a property of where the value comes from, not of how it looks. Its shape says only that this
 * guard minted it; a hash of an address would look the same, so nothing downstream can establish from
 * the value alone that it means nothing. This is the only place that can.
 *
 * Held against the request object rather than written onto it: two phases of one request are one event,
 * and a weak key means an identity lives exactly as long as the request it names and is never a leak.
 *
 * @type {WeakMap<object, string>}
 */
const eventIdentities = new WeakMap();

/**
 * 32 hexadecimal characters naming one call.
 *
 * Web crypto where the runtime has it. Where it does not — this package runs on edge runtimes too, and
 * what they expose varies — the clock and `Math.random` stand in, as this package already does for its
 * reporter's own
 * instance id and is enough here for the same reason: this identity is never a secret and never a
 * boundary. Nothing is authorised by holding it and nothing is denied by guessing it. What it has to do
 * is not collide between two calls, and a millisecond plus eighty-odd bits does that.
 *
 * A runtime with neither would be one with no clock, so there is no null case to handle. Wrapped anyway,
 * because a throw here would be a request that never gets screened over a field used for counting.
 */
function mintEvent() {
  try {
    const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(16));
    if (bytes) return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    // Falls through to the clock below.
  }

  try {
    let hex = Date.now().toString(16);
    while (hex.length < 32) hex += Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');

    return hex.slice(0, 32);
  } catch {
    // Fail-open, like everything else here: no identity is a detection that cannot be grouped, which is
    // a worse count than one nobody can group. It is not a reason to fail a request.
    return null;
  }
}

/**
 * The identity for a request, minted the first time anything asks.
 *
 * Lazily, so a request that matches nothing costs nothing. Every phase of one request asks with the same
 * request object and so gets the same answer, whichever of them fires first.
 */
function eventFor(request) {
  if (request === null || typeof request !== 'object') return mintEvent();

  const existing = eventIdentities.get(request);
  if (existing !== undefined) return existing;

  const minted = mintEvent();
  if (minted !== null) eventIdentities.set(request, minted);

  return minted;
}

/**
 * Request metadata from a response-phase context.
 *
 * The context is the originating request, already carrying its own resolution — so a response detection
 * names the same client as the request detection for that request.
 */
function requestMetaFromContext(reqCtx) {
  if (!reqCtx) return {};
  const client = reqCtx._clientIp ?? { ip: null, source: 'unavailable' };

  return {
    method: reqCtx.method ?? null,
    // The originating request's identity, so a response detection and the request detection for the same
    // request are one event rather than two. Asked for here, which is inside a detection being raised.
    event: eventFor(reqCtx._eventOf),
    // Path AND query. The reporter is what drops the query's VALUES, keeping its parameter names, so
    // trimming it here would leave a Fetch or response detection unable to say what was requested.
    path: typeof reqCtx.originalUrl === 'string' ? reqCtx.originalUrl : null,
    ip: client.ip,
    clientIpSource: client.source,
    userAgent: reqCtx.headers?.['user-agent'] ?? null,
  };
}

function requestMeta(shaped, request) {
  const client = shaped?._clientIp ?? { ip: null, source: 'unavailable' };
  let path = null;
  let method = null;
  let userAgent = null;

  if (request) {
    try {
      const u = new URL(request.url);
      path = u.pathname + u.search;
    } catch {
      path = typeof request.url === 'string' ? request.url : null;
    }
    method = request.method ?? null;
    userAgent = request.headers?.get?.('user-agent') ?? null;
  }

  return { method, path, ip: client.ip, clientIpSource: client.source, userAgent, event: eventFor(request) };
}

/**
 * Request metadata on the Node and Express paths, using the address already resolved for the request.
 *
 * @param {import('http').IncomingMessage & { originalUrl?: string }} req
 * @param {{ ip: string | null, source: string } | undefined} client
 */
function nodeRequestMeta(req, client) {
  if (!req) return {};
  const headers = req.headers ?? {};
  const ua = headers['user-agent'] ?? headers['User-Agent'];
  const resolved = client ?? { ip: null, source: 'unavailable' };

  return {
    method: req.method ?? null,
    path: req.originalUrl || req.url || null,
    // Never `req.ip`: under Express's `trust proxy` that is header-derived by a policy this guard has not
    // verified, and a second derivation could disagree with the one the engine evaluated.
    ip: resolved.ip,
    clientIpSource: resolved.source,
    userAgent: typeof ua === 'string' ? ua : Array.isArray(ua) ? ua[0] : null,
    event: eventFor(req),
  };
}
