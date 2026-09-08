// What `protect --check` can and cannot establish about detection reporting.
//
// Wiring is a property of the repository, so `--check` answers it. Reporting is a property of the running
// deployment, and most of it cannot be answered from a developer's machine or from CI. So these checks
// matter as much for the questions they refuse as for the ones they answer: "the guard is wired" and "the
// platform is hearing about it" are different claims, and the second can be false while the first is true.
//
// The state is decided by `reportingState`, the function the guard uses. Two copies of that decision would
// drift, and the one in the CLI would be the one nobody notices is wrong.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { reportingState, explainReportingState } from '../reporting-state.js';
import type { VerifyCheck } from './types.js';
import { read, hasResolvableCredential, isSiteUuid } from './util.js';

/**
 * The site identity the guard would run with, resolved the way the guard resolves it.
 *
 * A baked value first, then `PATCHSTACK_SITE_UUID` — the same order and the same fallback as the
 * scaffolded guard, so this reports on the identity that would be used rather than on one source of it.
 * A guard whose file was never baked is enrolled through the environment.
 *
 * Only a usable identity counts, by the scaffolder's own test. `found` separates "nothing is recorded"
 * from "something is recorded and cannot be used", because those send a reader to different places.
 */
function siteIdentity(
  cwd: string,
  env: Record<string, string | undefined>,
): { uuid: string | null; found: boolean } {
  const rc = join(cwd, '.patchstackrc.json');
  let recorded: unknown;

  if (existsSync(rc)) {
    try {
      recorded = JSON.parse(read(rc)).siteUuid;
    } catch {
      // Unreadable is not absent: the environment may still carry a usable identity, and the guard would
      // use it.
      recorded = undefined;
    }
  }

  if (isSiteUuid(recorded)) return { uuid: recorded, found: true };

  const fromEnv = env.PATCHSTACK_SITE_UUID;
  if (isSiteUuid(fromEnv)) return { uuid: fromEnv, found: true };

  const anything = (typeof recorded === 'string' && recorded !== '') || (fromEnv ?? '') !== '';

  return { uuid: null, found: anything };
}

/**
 * The reporting section of `protect --check`.
 *
 * Which answers are available here follows from the order `reportingState` decides in: an explicit
 * opt-out, then enrolment, then the credential, and only then whether the rules running are the
 * platform's. Everything before that last step is decided by facts this machine can read, so those
 * states are reported as facts. The last step needs a running guard that has resolved its rules, so
 * `on` is never asserted from here — the honest answer is that it depends on something not yet known.
 *
 * @param env the environment to judge, defaulting to this process's. A deployment's is not this one.
 */
export function reportingChecks(cwd: string, env: Record<string, string | undefined> = process.env): VerifyCheck[] {
  const { uuid: siteUuid, found: identityFound } = siteIdentity(cwd, env);
  const hasCredential = hasResolvableCredential(cwd, env);

  // Asked with the most favourable rule origin, so that anything OTHER than `on` came from a check
  // `reportingState` makes before the origin is consulted — which is to say, from something readable
  // here. `on` under that assumption means the real state is either `on` or `no-managed-rules`, and
  // this machine cannot tell which.
  const { state } = reportingState({ siteUuid, hasCredential, ruleOrigin: 'api', env });

  const checks: VerifyCheck[] = [
    {
      group: 'reporting',
      label: 'this app is enrolled (a site identity is recorded)',
      ok: siteUuid !== null,
      hint: identityFound
        ? 'a site identity is recorded but is not a usable UUID — check `siteUuid` in .patchstackrc.json, or PATCHSTACK_SITE_UUID. The guard protects the app and reports nothing, because there is nothing to attribute a detection to.'
        : 'no site identity — run `npx @patchstack/connect scan` to provision one, or set PATCHSTACK_SITE_UUID in the deployment. Without it the guard protects the app but reports nothing.',
    },
  ];

  if (state === 'on') {
    checks.push({
      group: 'reporting',
      label: 'detection reporting is switched on for this environment',
      ok: true,
      unverifiable: true,
      hint:
        'nothing here switches it off, but whether it actually reports depends on the rules the guard ' +
        'resolves at runtime: reporting is on for Patchstack-delivered rules and off for a bundle of ' +
        "your own (`no-managed-rules`). Read `protection.detectionReporting` in the running app for the " +
        'settled answer. This also only judges the environment it ran in — a deployment may set an ' +
        'opt-out this machine cannot see.',
    });
  } else {
    // Decided before the rule origin mattered, so this is the state, not a guess. Said in the label
    // because a passing check does not print its hint, and an opt-out is a choice rather than a fault.
    checks.push({
      group: 'reporting',
      label: `detection reporting is off for this environment (${state})`,
      ok: state === 'disabled-by-config' || state === 'disabled-by-telemetry-opt-out',
      hint: `${explainReportingState(state)} Judged from this environment only; a deployment's is not this one.`,
    });
  }

  checks.push({
    group: 'reporting',
    // A wired guard says events CAN be sent. It says nothing about whether any were, or whether the
    // platform took them, and this is where an operator would otherwise assume both.
    label: 'delivery health (events attempted, acknowledged, refused, dropped)',
    ok: true,
    unverifiable: true,
    hint:
      'not observable from here — the counters live in the running guard. Call ' +
      '`protection.detectionHealth()` in the deployment: it is undefined when there is no reporter, and ' +
      'otherwise reports what was attempted, acknowledged, refused and dropped for queue pressure. ' +
      'A wired guard is not evidence that anything arrived.',
  });

  return checks;
}
