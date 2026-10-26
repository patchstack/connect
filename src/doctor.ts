// `doctor`: one check of everything Patchstack needs to work in this project, each problem with its fix.
//
// It reads the project the way `guide` and `protect --check` do, and adds the checks behind the failures
// that are otherwise silent: a guard rules file setup cannot find, a missing or retired read-only rules
// credential, and a map that is not linked to the guard. With --url it also looks at the live app. It
// writes nothing.

import { readFileSync } from 'node:fs';

import { readBuildStamp } from './build-id.js';
import { findRulesFile, ruleBundleOf } from './build-stamp.js';
import { buildClaimUrl, type ClaimPreview } from './client.js';
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
}

const READER = /^rr_[0-9a-f]{48}-\d+$/;
const PROBE = '../../../../etc/passwd';
const LIVE_TIMEOUT_MS = 10_000;

/** Ask Patchstack whether it accepts a credential, without keeping the token it hands back. */
async function credentialAccepted(config: Config, credential: string, fetchImpl: typeof fetch): Promise<'accepted' | 'refused' | 'unreachable'> {
  const parsed = parsePulseAuth(credential);
  if (parsed === null) return 'refused';
  try {
    const url = buildTokenUrl(config.endpoint);
    assertConnectableEndpoint(config, url);
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...connectHeaders() },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: parsed.clientId, client_secret: parsed.clientSecret }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    return response.ok ? 'accepted' : response.status === 401 || response.status === 403 ? 'refused' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/** The guard's rules file: where it is, the read-only credential in it, and whether the map is linked. */
async function rulesFileFindings(cwd: string, config: Config, fetchImpl: typeof fetch): Promise<DoctorFinding[]> {
  const location = findRulesFile(cwd);
  if (location.kind === 'none') {
    return [{
      status: 'problem',
      text: "Patchstack cannot find the guard's rules file, so setup cannot keep its rules current",
      fix: ['Run: npx @patchstack/connect protect', 'Then: npx @patchstack/connect setup'],
    }];
  }
  if (location.kind === 'unreadable') {
    return [{
      status: 'problem',
      text: `The guard's rules file is not valid JSON (${location.paths.join(', ')})`,
      fix: ['Restore it from version control, or delete it and run: npx @patchstack/connect protect', 'Then: npx @patchstack/connect setup'],
    }];
  }
  if (location.kind === 'ambiguous') {
    return [{
      status: 'problem',
      text: `Two Patchstack guards are installed, each with its own rules file (${location.paths.join(', ')})`,
      fix: [
        'Keep the guard npx @patchstack/connect protect --check reports as wired.',
        'Remove the other guard and its rules file, after checking nothing in the app imports that guard.',
        'Then: npx @patchstack/connect setup',
      ],
    }];
  }

  let bundle: Record<string, unknown> | null = null;
  try {
    bundle = ruleBundleOf(JSON.parse(readFileSync(location.path, 'utf8')));
  } catch {
    // Read as missing below.
  }
  const findings: DoctorFinding[] = [];
  const reader = (bundle?._patchstack as { rules_reader?: unknown } | undefined)?.rules_reader;
  if (typeof reader !== 'string' || !READER.test(reader)) {
    findings.push({
      status: 'problem',
      text: "The guard's rules file has no read-only rules credential, so the published app cannot fetch rule updates or report attacks without the site key",
      fix: ['Run: npx @patchstack/connect setup (it writes the credential; it needs the site key on this machine)', 'Then publish the app again.'],
    });
  } else {
    const verdict = await credentialAccepted(config, reader, fetchImpl);
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

  return findings;
}

/** The live app: whether it carries the widget and whether its guard stops a test attack. */
async function liveFindings(url: string, state: GuideState, fetchImpl: typeof fetch): Promise<DoctorFinding[]> {
  let page: URL;
  try {
    page = new URL(url);
    if (page.protocol !== 'https:' && page.protocol !== 'http:') throw new Error('not http');
  } catch {
    return [{ status: 'unknown', text: `${url} is not a web address; pass the live app's address, e.g. --url https://your-app.example` }];
  }

  const findings: DoctorFinding[] = [];
  try {
    const response = await fetchImpl(page, { signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
    const html = await response.text();
    // A page that does not load says nothing about the guard either, so the test attack is not sent.
    if (!response.ok) {
      return [{ status: 'unknown', text: `The live app answered ${response.status}, so it could not be checked (is it published? a private publish shows a sign-in page)` }];
    }
    if (!state.widgetOptOut && state.siteUuid !== null) {
      findings.push(
        html.includes('patchstack-widget.js') && html.includes(state.siteUuid)
          ? { status: 'ok', text: 'The live app carries the Patchstack widget for this site' }
          : { status: 'problem', text: 'The live app does not carry the Patchstack widget for this site yet', fix: ['Publish the app again: the live app still runs a build from before setup.'], owner: true },
      );
    }
  } catch {
    return [{ status: 'unknown', text: `Could not reach ${page.origin}` }];
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

  return findings;
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

  if (state.protectionApplicable && state.protectionWired) findings.push(...await rulesFileFindings(cwd, config, fetchImpl));
  if (options.url) findings.push(...await liveFindings(options.url, state, fetchImpl));

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
