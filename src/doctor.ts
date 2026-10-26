// `doctor`: one check of everything Patchstack needs to work in this project, each problem with its fix.
//
// It reads the project the way `guide` and `protect --check` do, and adds the checks behind the failures
// that are otherwise silent: a guard rules file setup cannot find, a missing or retired read-only rules
// credential, and a map that is not linked to the guard. With --url it also looks at the live app. It
// writes nothing.

import { readFileSync } from 'node:fs';

import { readBuildStamp } from './build-id.js';
import { findRulesFile, ruleBundleOf } from './build-stamp.js';
import { buildClaimUrl, buildSyncStatusUrl, type ClaimPreview } from './client.js';
import { assertConnectableEndpoint } from './endpoint-policy.js';
import { DEV_ONLY_INSTALL, guideMissing, needsSourceProductionMarker, type GuideState } from './guide.js';
import { buildTokenUrl, parsePulseAuth } from './pulse-token.js';
import { connectHeaders } from './report-context.js';
import type { Config } from './types.js';

export type DoctorStatus = 'ok' | 'problem' | 'unknown';

export interface DoctorFinding {
  status: DoctorStatus;
  /** What was found, in one short sentence. */
  text: string;
  /** What to do about it, one line each. */
  fix?: string[];
  /** A step only the app's owner can take (connecting their account, publishing), not a change to the project. */
  owner?: boolean;
}

export interface DoctorOptions {
  /** The live app's address, for the checks that need it. */
  url?: string | null;
  fetchImpl?: typeof fetch;
  /** Whether the site has an owner, from the public claim page. */
  claimPreview: (config: Config) => Promise<ClaimPreview>;
  /** How long to give the live app to finish the rules check its visit started, before reading sync status. */
  settleMs?: number;
}

const READER = /^rr_[0-9a-f]{48}-\d+$/;
const PROBE = '../../../../etc/passwd';
const LIVE_TIMEOUT_MS = 10_000;
/** A published app re-checks its rules every few minutes while it has visitors; older than this is worth a look. */
const SYNC_STALE_MS = 2 * 60 * 60 * 1000;

type Exchange = { verdict: 'accepted' | 'refused' | 'unreachable'; token: string | null };

/** Ask Patchstack whether it accepts a credential. The token is used only for the sync-status read below. */
async function exchangeCredential(config: Config, credential: string, fetchImpl: typeof fetch): Promise<Exchange> {
  const parsed = parsePulseAuth(credential);
  if (parsed === null) return { verdict: 'refused', token: null };
  try {
    const url = buildTokenUrl(config.endpoint);
    assertConnectableEndpoint(config, url);
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...connectHeaders() },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: parsed.clientId, client_secret: parsed.clientSecret }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!response.ok) return { verdict: response.status === 401 || response.status === 403 ? 'refused' : 'unreachable', token: null };
    const token = ((await response.json().catch(() => null)) as { access_token?: unknown } | null)?.access_token;

    return { verdict: 'accepted', token: typeof token === 'string' && token !== '' ? token : null };
  } catch {
    return { verdict: 'unreachable', token: null };
  }
}

/** The guard's rules file: where it is, the read-only credential in it, and whether the map is linked. */
async function rulesFileFindings(cwd: string, config: Config, fetchImpl: typeof fetch): Promise<{ findings: DoctorFinding[]; token: string | null }> {
  const location = findRulesFile(cwd);
  if (location.kind === 'none') {
    return { token: null, findings: [{
      status: 'problem',
      text: "Patchstack cannot find the guard's rules file, so setup cannot keep its rules current",
      fix: ['Run: npx @patchstack/connect protect', 'Then: npx @patchstack/connect setup'],
    }] };
  }
  if (location.kind === 'unreadable') {
    return { token: null, findings: [{
      status: 'problem',
      text: `The guard's rules file is not valid JSON (${location.paths.join(', ')})`,
      fix: ['Restore it from version control, or delete it and run: npx @patchstack/connect protect', 'Then: npx @patchstack/connect setup'],
    }] };
  }
  if (location.kind === 'ambiguous') {
    return { token: null, findings: [{
      status: 'problem',
      text: `Two Patchstack guards are installed, each with its own rules file (${location.paths.join(', ')})`,
      fix: [
        'Keep the guard npx @patchstack/connect protect --check reports as wired.',
        'Remove the other guard and its rules file, after checking nothing in the app imports that guard.',
        'Then: npx @patchstack/connect setup',
      ],
    }] };
  }

  let bundle: Record<string, unknown> | null = null;
  try {
    bundle = ruleBundleOf(JSON.parse(readFileSync(location.path, 'utf8')));
  } catch {
    // Read as missing below.
  }
  const findings: DoctorFinding[] = [];
  let token: string | null = null;
  const reader = (bundle?._patchstack as { rules_reader?: unknown } | undefined)?.rules_reader;
  if (typeof reader !== 'string' || !READER.test(reader)) {
    findings.push({
      status: 'problem',
      text: "The guard's rules file has no read-only rules credential, so the published app cannot fetch rule updates or report attacks without the site key",
      fix: ['Run: npx @patchstack/connect setup (it writes the credential; it needs the site key on this machine)', 'Then publish the app again.'],
    });
  } else {
    const { verdict, token: readerToken } = await exchangeCredential(config, reader, fetchImpl);
    token = readerToken;
    findings.push(
      verdict === 'accepted'
        ? { status: 'ok', text: 'The read-only rules credential works: the published app can fetch rule updates and report attacks' }
        : verdict === 'refused'
          ? {
              status: 'problem',
              text: 'Patchstack refused the read-only rules credential (the site key was replaced, or the site was removed)',
              fix: ['Run: npx @patchstack/connect setup (it writes a current one)', 'Then publish the app again.'],
            }
          : { status: 'unknown', text: 'Could not reach Patchstack to check the read-only rules credential' },
    );
  }
  if (bundle === null || readBuildStamp(bundle) === null) {
    findings.push({
      status: 'problem',
      text: "The app's map is not linked to the guard, so rules written for this app's own inputs can only report, not block",
      fix: ['Run: npx @patchstack/connect setup --verbose and fix the reason on its "could not bind this map" line', 'Then run setup again.'],
    });
  } else {
    findings.push({ status: 'ok', text: "The app's map is linked to the guard" });
  }

  return { findings, token };
}

/** "3 minutes ago", "5 hours ago", "2 days ago". */
function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

type Fetch = { at: string; rule_count: number | null } | null;

/**
 * Whether the published app fetches its rules, from Patchstack's own record of rules fetches.
 *
 * The published app fetches on the read-only credential; a copy holding the site key (the workspace, or a
 * deployment that sets PATCHSTACK_API_KEY) on the key. doctor reads the record and never fetches rules
 * itself, which would be recorded as a fetch. An app with no visitors does not fetch, so an old fetch is
 * only a problem once `visited` says doctor has just sent the live app a request.
 */
async function syncFindings(config: Config, token: string, visited: boolean, fetchImpl: typeof fetch): Promise<DoctorFinding[]> {
  let body: { rules_fetches?: { reader?: Fetch; site_key?: Fetch } };
  try {
    const url = buildSyncStatusUrl(config.endpoint, config.siteUuid as string);
    assertConnectableEndpoint(config, url);
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...connectHeaders() },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (response.status === 404) return [{ status: 'unknown', text: 'Patchstack does not report rules syncing for this site yet' }];
    if (!response.ok) return [{ status: 'unknown', text: 'Could not get the rules sync status from Patchstack' }];
    body = (await response.json()) as typeof body;
  } catch {
    return [{ status: 'unknown', text: 'Could not reach Patchstack to check whether the published app fetches its rules' }];
  }

  const now = Date.now();
  const reader = body.rules_fetches?.reader ?? null;
  const key = body.rules_fetches?.site_key ?? null;
  const at = (fetch: Fetch) => (fetch === null ? NaN : Date.parse(fetch.at));
  const count = (fetch: Fetch) => (fetch?.rule_count == null ? '' : ` (${fetch.rule_count} rule${fetch.rule_count === 1 ? '' : 's'})`);
  const visit = 'Run: npx @patchstack/connect doctor --url <your live app> (it visits the app, which makes it check its rules), then look again.';

  if (reader !== null && now - at(reader) <= SYNC_STALE_MS) {
    return [{ status: 'ok', text: `The published app fetched its rules from Patchstack ${ago(at(reader), now)}${count(reader)}` }];
  }
  const notSyncing = [
    'Publish the app again on the latest @patchstack/connect.',
    'Check the guard is wired: npx @patchstack/connect protect --check',
    'Then: npx @patchstack/connect doctor --url <your live app>',
  ];
  if (reader !== null) {
    const text = `The published app last fetched its rules from Patchstack ${ago(at(reader), now)}${count(reader)}`;
    return [visited
      ? { status: 'problem', text: `${text}, and did not fetch them when doctor just visited it`, fix: notSyncing }
      : { status: 'unknown', text: `${text}. An app with no visitors does not fetch`, fix: [visit] }];
  }
  if (key !== null) {
    return [{
      status: 'unknown',
      text: `Only a copy holding the site key has fetched rules (${ago(at(key), now)}): a published app that sets PATCHSTACK_API_KEY fetches that way; otherwise the published app has never fetched them`,
      fix: visited ? notSyncing : [visit],
    }];
  }

  return [visited
    ? { status: 'problem', text: 'The published app has never fetched its rules from Patchstack, even when doctor just visited it', fix: notSyncing }
    : { status: 'unknown', text: 'The published app has never fetched its rules from Patchstack', fix: ['If the app is published, ' + visit.charAt(0).toLowerCase() + visit.slice(1), 'If it is not published yet, publish it.'] }];
}

/** The live app: whether it carries the widget and whether its guard stops a test attack. */
async function liveFindings(url: string, state: GuideState, fetchImpl: typeof fetch): Promise<{ findings: DoctorFinding[]; reached: boolean }> {
  let page: URL;
  try {
    page = new URL(url);
    if (page.protocol !== 'https:' && page.protocol !== 'http:') throw new Error('not http');
  } catch {
    return { reached: false, findings: [{ status: 'unknown', text: `${url} is not a web address; pass the live app's address, e.g. --url https://your-app.example` }] };
  }

  const findings: DoctorFinding[] = [];
  try {
    const response = await fetchImpl(page, { signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
    const html = await response.text();
    // A page that does not load says nothing about the guard either, so the test attack is not sent.
    if (!response.ok) {
      return { reached: false, findings: [{ status: 'unknown', text: `The live app answered ${response.status}, so it could not be checked (is it published? a private publish shows a sign-in page)` }] };
    }
    if (!state.widgetOptOut && state.siteUuid !== null) {
      findings.push(
        html.includes('patchstack-widget.js') && html.includes(state.siteUuid)
          ? { status: 'ok', text: 'The live app carries the Patchstack widget for this site' }
          : { status: 'problem', text: 'The live app does not carry the Patchstack widget for this site yet', fix: ['Publish the app again: the live app still runs a build from before setup.'], owner: true },
      );
    }
  } catch {
    return { reached: false, findings: [{ status: 'unknown', text: `Could not reach ${page.origin}` }] };
  }

  const probe = new URL(page);
  probe.searchParams.set('file', PROBE);
  try {
    const response = await fetchImpl(probe, { signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
    const body = await response.text();
    findings.push(
      response.status === 403 && /blocked by Patchstack/i.test(body)
        ? { status: 'ok', text: "The live app's guard blocked a test attack" }
        : {
            status: 'problem',
            text: `The live app let a test attack through (it answered ${response.status} to ?file=${PROBE})`,
            fix: [
              'If the app has not been published since setup, publish it again.',
              'If the site is not connected to a Patchstack account that includes protection, Patchstack only reports attacks: connect it.',
            ],
            owner: true,
          },
    );
  } catch {
    findings.push({ status: 'unknown', text: `Could not reach ${page.origin} for the test attack` });
  }

  return { findings, reached: true };
}

/**
 * Every check, in the order a fix is worth making. `state` is `collectGuideState` for the project.
 */
export async function runDoctorChecks(cwd: string, state: GuideState, config: Config, options: DoctorOptions): Promise<DoctorFinding[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const findings: DoctorFinding[] = [];

  if (state.installed === null) {
    return [{ status: 'problem', text: 'Patchstack is not installed in this project', fix: ['Run: npx @patchstack/connect setup'] }];
  }
  if (state.siteUuid === null) {
    return [{ status: 'problem', text: 'This project is not on Patchstack yet', fix: ['Run: npx @patchstack/connect setup'] }];
  }

  // Whether the site has an owner. The note in .patchstackrc.json answers it once it is recorded.
  let connected: boolean | null = state.claimed ? true : null;
  if (connected === null) {
    const preview = await options.claimPreview(config);
    connected = preview.state === 'claimed' ? true : preview.state === 'unclaimed' ? false : null;
  }
  if (connected === null) findings.push({ status: 'unknown', text: 'Could not reach Patchstack to check whether this site is connected to an account' });

  // Each thing setup leaves to do, as setup and guide word it. The connection is reported above, with its link.
  const missing = guideMissing(state, { connected: true });
  if (connected === false) {
    const link = config.endpointTrusted !== false ? buildClaimUrl(config.endpoint, state.siteUuid) : null;
    findings.push({
      status: 'problem',
      text: 'Not connected to a Patchstack account, so Patchstack only reports attacks and does not block them',
      fix: [link ? `Open ${link} and sign in.` : 'Run: npx @patchstack/connect claim'],
      owner: true,
    });
  } else if (connected) {
    findings.push({ status: 'ok', text: 'Connected to a Patchstack account' });
  }
  for (const item of missing) {
    findings.push({ status: 'problem', text: item.plain?.text ?? item.text, fix: [...(item.hint ?? []), ...(item.detail ?? [])] });
  }
  const keys = new Set(missing.map((item) => item.key));

  if (!keys.has(DEV_ONLY_INSTALL)) findings.push({ status: 'ok', text: `Patchstack ${state.installed.version} is installed` });
  if (!state.protectionApplicable) {
    findings.push({ status: 'ok', text: 'This app has no server to protect, so runtime protection does not apply' });
  } else if (state.protectionWired) {
    findings.push({ status: 'ok', text: `Protection is wired into your server (${state.protectionStack})` });
  }
  if (state.installScanWired && (!state.hasBuildScript || (state.prebuildWired && state.postbuildWired))) {
    findings.push({ status: 'ok', text: 'Your installs and builds run the Patchstack check' });
  }
  if (needsSourceProductionMarker(state) && state.productionMarkerWired) {
    findings.push({ status: 'ok', text: 'Your pages carry the marker that tells Patchstack when the app is live' });
  }

  let readerToken: string | null = null;
  if (state.protectionApplicable && state.protectionWired) {
    const rules = await rulesFileFindings(cwd, config, fetchImpl);
    findings.push(...rules.findings);
    readerToken = rules.token;
  }
  let visited = false;
  if (options.url) {
    const live = await liveFindings(options.url, state, fetchImpl);
    findings.push(...live.findings);
    visited = live.reached;
  }
  if (state.protectionApplicable && state.protectionWired) {
    // The site key on this machine when there is one, otherwise the read-only credential checked above.
    const key = config.pulseAuth ?? config.apiKey;
    const token = typeof key === 'string' && key !== '' ? (await exchangeCredential(config, key, fetchImpl)).token ?? readerToken : readerToken;
    if (token !== null) {
      // A visit can start the app's rules check in the background; give it a moment to be recorded.
      if (visited) await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? 3_000));
      findings.push(...await syncFindings(config, token, visited, fetchImpl));
    }
  }

  // Problems first, in the order found, then what could not be checked, then what passed.
  const rank: Record<DoctorStatus, number> = { problem: 0, unknown: 1, ok: 2 };

  return findings.map((finding, index) => ({ finding, index }))
    .sort((a, b) => rank[a.finding.status] - rank[b.finding.status] || a.index - b.index)
    .map(({ finding }) => finding);
}

/** The report, ending with what to do next for whoever runs it, person or assistant. */
export function renderDoctor(findings: DoctorFinding[], { url }: { url?: string | null } = {}): string[] {
  const mark: Record<DoctorStatus, string> = { ok: '✓', problem: '✗', unknown: '?' };
  const lines = ['Patchstack doctor: is Patchstack set up and working in this project?', ''];
  for (const finding of findings) {
    lines.push(`  ${mark[finding.status]} ${finding.text}${finding.owner ? ' (for the app owner)' : ''}`);
    for (const [index, fix] of (finding.fix ?? []).entries()) lines.push(`      ${index === 0 ? 'Fix: ' : '     '}${fix}`);
  }
  lines.push('');
  const problems = findings.filter((finding) => finding.status === 'problem');
  const toFix = problems.filter((finding) => !finding.owner).length;
  const forOwner = problems.length - toFix;
  if (problems.length === 0) lines.push('No problems found.');
  if (toFix > 0) {
    lines.push(`${toFix} problem${toFix === 1 ? '' : 's'} to fix in the project. Fix each ✗ above as its Fix line says, then run npx @patchstack/connect doctor again until none is left.`);
  }
  if (forOwner > 0) {
    lines.push(`${forOwner} step${forOwner === 1 ? '' : 's'} for the app owner (marked "for the app owner"): connecting their Patchstack account or publishing the app. Pass ${forOwner === 1 ? 'it' : 'them'} on; nothing in the project fixes ${forOwner === 1 ? 'it' : 'them'}.`);
  }
  if (findings.some((finding) => finding.status === 'unknown')) lines.push('A ? could not be checked from here; it is not a problem on its own.');
  if (!url) lines.push("To also check the live app, run: npx @patchstack/connect doctor --url <your live app's address>");

  return lines;
}
