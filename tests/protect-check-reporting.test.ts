import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { reportingChecks } from '../src/protect/install/reporting.js';
// @ts-expect-error -- plain ESM runtime module
import { REPORTING_STATES } from '../src/protect/reporting-state.js';

/**
 * What `protect --check` says about detection reporting.
 *
 * "The guard is wired" and "the platform is hearing about it" are different claims, and the second can be
 * false while the first is true. These cover the three answers available and, as much, which questions
 * are refused.
 *
 * The split follows the order `reportingState` decides in. An opt-out, enrolment and the credential are
 * settled by facts this machine can read, so those are reported as facts. Whether the rules running are
 * the platform's needs a guard that has resolved them, so `on` is never asserted from here.
 */

const dirs: string[] = [];

function project(rc?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ps-check-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }));
  if (rc) writeFileSync(join(dir, '.patchstackrc.json'), JSON.stringify(rc));

  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const UUID = '11111111-2222-3333-4444-555555555555';
/** An environment with a credential and no opt-out — the case where the origin is what is left. */
const withCredential = { PATCHSTACK_API_KEY: 'k' };

const find = (checks: ReturnType<typeof reportingChecks>, fragment: string) => {
  const hit = checks.find((c) => c.label.includes(fragment));
  expect(hit, `no check mentioning "${fragment}"`).toBeDefined();

  return hit!;
};

describe('what it can answer', () => {
  it('says an app is not enrolled, and what that costs', () => {
    const checks = reportingChecks(project(), {});
    const enrolled = find(checks, 'enrolled');

    expect(enrolled.ok).toBe(false);
    expect(enrolled.unverifiable).toBeUndefined();
    // The consequence, not just the fact: the guard still protects, and reports nothing.
    expect(enrolled.hint).toMatch(/protects the app but reports nothing/);
    expect(find(checks, 'reporting is off').label).toContain('not-enrolled');
  });

  it('counts an identity the guard would read from the environment', () => {
    // A guard whose file was never baked resolves `PATCHSTACK_SITE_UUID` instead, so this reports on the
    // identity that would be used rather than on one source of it.
    const checks = reportingChecks(project(), { PATCHSTACK_SITE_UUID: UUID });

    expect(find(checks, 'enrolled').ok).toBe(true);
  });

  it('falls back to the environment when the recorded identity is unusable', () => {
    // The file being wrong does not make the app unenrolled: the guard reaches for the environment next,
    // and so does this.
    const checks = reportingChecks(project({ siteUuid: 'not-a-uuid' }), { PATCHSTACK_SITE_UUID: UUID });

    expect(find(checks, 'enrolled').ok).toBe(true);
  });

  it.each([
    ['a malformed recorded identity', { siteUuid: 'not-a-uuid' }, {}],
    ['a malformed identity in the environment', undefined, { PATCHSTACK_SITE_UUID: 'nope' }],
  ])('reports an unusable identity as unusable, not as absent: %s', (_label, rc, env) => {
    // Two different problems with two different fixes. "Nothing is recorded" sends someone to `scan`;
    // "this value cannot be used" sends them to the value. Only a UUID the scaffolder would bake counts,
    // so the two ends agree on what an enrolment is.
    const enrolled = find(reportingChecks(project(rc), env as Record<string, string>), 'enrolled');

    expect(enrolled.ok).toBe(false);
    expect(enrolled.hint).toMatch(/not a usable UUID/);
  });

  it('sends someone to provision one when nothing is recorded at all', () => {
    const enrolled = find(reportingChecks(project(), {}), 'enrolled');

    expect(enrolled.ok).toBe(false);
    expect(enrolled.hint).toMatch(/no site identity/);
    expect(enrolled.hint).toMatch(/PATCHSTACK_SITE_UUID/);
  });

  it('names a missing credential rather than a missing enrolment', () => {
    // The credential is checked before the rules question for this reason: a missing credential is what
    // makes managed rules missing, and reporting `no-managed-rules` sends an operator to look for an
    // enrolment they already have.
    const checks = reportingChecks(project({ siteUuid: UUID }), {});

    expect(find(checks, 'enrolled').ok).toBe(true);
    expect(find(checks, 'reporting is off').label).toContain('unavailable-no-credential');
  });

  it.each([
    ['PATCHSTACK_REPORT_DETECTIONS', 'disabled-by-config'],
    ['PATCHSTACK_TELEMETRY', 'disabled-by-telemetry-opt-out'],
  ])('reports %s as the deliberate choice it is', (variable, state) => {
    const checks = reportingChecks(project({ siteUuid: UUID }), { ...withCredential, [variable]: '0' });
    const off = find(checks, 'reporting is off');

    expect(off.label).toContain(state);
    // A choice, not a fault: passing, so `--check` does not train people to ignore it. The state is in
    // the label because a passing check does not print its hint.
    expect(off.ok).toBe(true);
  });

  it('keeps the two opt-outs apart', () => {
    // Collapsed into one, an operator who set one variable is sent to look at the other.
    const byConfig = find(reportingChecks(project({ siteUuid: UUID }), { PATCHSTACK_REPORT_DETECTIONS: '0' }), 'reporting is off');
    const byTelemetry = find(reportingChecks(project({ siteUuid: UUID }), { PATCHSTACK_TELEMETRY: '0' }), 'reporting is off');

    expect(byConfig.label).not.toBe(byTelemetry.label);
  });

  it('lets an opt-out outrank a missing credential', () => {
    // A deployment that switched reporting off should be told that is why, not that it lacks a
    // credential it never needed.
    const checks = reportingChecks(project({ siteUuid: UUID }), { PATCHSTACK_TELEMETRY: '0' });

    expect(find(checks, 'reporting is off').label).toContain('disabled-by-telemetry-opt-out');
  });
});

describe('what it refuses to answer', () => {
  it('will not claim reporting is on when the rule origin is still unknown', () => {
    // Everything readable here is satisfied, and the state is still not settled: reporting is on for
    // Patchstack-delivered rules and off for a bundle of the caller's own. Asserting `on` would be the
    // report claiming something no one established.
    const checks = reportingChecks(project({ siteUuid: UUID }), withCredential);
    const on = find(checks, 'reporting is switched on');

    expect(on.unverifiable).toBe(true);
    expect(on.hint).toContain('no-managed-rules');
    // And where the settled answer actually lives.
    expect(on.hint).toContain('protection.detectionReporting');
    // The environment caveat, because these variables are this machine's and not the deployment's.
    expect(on.hint).toMatch(/deployment may set an opt-out this machine cannot see/);
  });

  it('never reports delivery health as healthy', () => {
    // A wired guard says events CAN be sent; it says nothing about whether any were, or whether the
    // platform took them.
    for (const env of [{}, withCredential, { ...withCredential, PATCHSTACK_TELEMETRY: '0' }]) {
      const health = find(reportingChecks(project({ siteUuid: UUID }), env), 'delivery health');

      expect(health.unverifiable).toBe(true);
      expect(health.hint).toContain('protection.detectionHealth()');
      expect(health.hint).toMatch(/not evidence that anything arrived/);
    }
  });

  it('marks every question it cannot answer, rather than omitting it', () => {
    // An unanswerable question has to appear and be marked, not be left out: a question nobody is asked
    // is a question nobody knows was unanswered.
    const checks = reportingChecks(project({ siteUuid: UUID }), withCredential);

    expect(checks.filter((c) => c.unverifiable)).toHaveLength(2);
    for (const check of checks.filter((c) => c.unverifiable)) {
      // The CLI prints the hint for every `?` line, so an unverifiable check without one prints a
      // question mark and no question.
      expect(check.hint).toBeTruthy();
    }
  });
});

describe('the vocabulary', () => {
  it('reports states the guard can actually be in', () => {
    // One vocabulary, from one function. A state named here that the guard cannot reach, or one it
    // reaches under another name, is a gap between what an operator is told and what is true.
    const reachable = REPORTING_STATES as readonly string[];

    const cases: Array<[Record<string, unknown> | undefined, Record<string, string>]> = [
      [undefined, {}],
      [{ siteUuid: UUID }, {}],
      [{ siteUuid: UUID }, withCredential],
      [{ siteUuid: UUID }, { ...withCredential, PATCHSTACK_REPORT_DETECTIONS: '0' }],
      [{ siteUuid: UUID }, { ...withCredential, PATCHSTACK_TELEMETRY: '0' }],
    ];

    for (const [rc, env] of cases) {
      const checks = reportingChecks(project(rc), env);
      const stated = checks
        .map((c) => /\(([a-z-]+)\)/.exec(c.label)?.[1])
        .filter((name): name is string => Boolean(name));

      for (const name of stated) expect(reachable).toContain(name);
    }
  });

  it('is unaffected by a malformed rc file', () => {
    // Unreadable is not enrolled. Throwing here would fail `--check` on a broken file rather than
    // reporting what it found.
    const dir = project();
    writeFileSync(join(dir, '.patchstackrc.json'), '{ not json');

    expect(() => reportingChecks(dir, {})).not.toThrow();
    expect(find(reportingChecks(dir, {}), 'enrolled').ok).toBe(false);
    // And an unreadable file does not hide an identity the environment carries.
    expect(find(reportingChecks(dir, { PATCHSTACK_SITE_UUID: UUID }), 'enrolled').ok).toBe(true);
  });
});
