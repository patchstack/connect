import { describe, it, expect } from 'vitest';
import {
  REPORTING_STATES,
  explainReportingState,
  reportingState,
} from '../../src/protect/reporting-state.js';

/**
 * Every combination that decides whether a guard reports security events.
 *
 * Enumerated rather than sampled. The states are the difference between retained evidence being
 * collected and not, and between a dashboard saying "nothing matched" and "reporting is off" — so each
 * input combination has one defined answer and there is no combination without one.
 */
type Input = Parameters<typeof reportingState>[0];

const base: Input = { siteUuid: 'site-1', ruleOrigin: 'api', hasCredential: true, env: {} };

describe('reporting state', () => {
  it('reports only for an enrolled site running managed rules with a credential', () => {
    expect(reportingState(base)).toEqual({ state: 'on', reports: true });
  });

  it('treats cached platform rules as managed', () => {
    // Excluding `cache` would silence reporting for sites whose delivery is degraded — the ones whose
    // evidence is most worth having.
    expect(reportingState({ ...base, ruleOrigin: 'cache' })).toEqual({ state: 'on', reports: true });
  });

  it.each([
    ['bundled', 'no-managed-rules'],
    ['empty', 'no-managed-rules'],
  ] as const)('does not report when the rules came from %s', (origin, expected) => {
    // No managed rule document exists to attribute a detection to.
    expect(reportingState({ ...base, ruleOrigin: origin })).toEqual({ state: expected, reports: false });
  });

  it('blames the credential, not the rule origin, when both are missing', () => {
    // A missing credential is what CAUSES managed rules to be missing: the fetch is refused and
    // resolution falls back to the caller's bundle or to nothing. Reporting the origin first would send
    // an operator looking for an enrolment they already have.
    expect(
      reportingState({ ...base, hasCredential: false, ruleOrigin: 'empty' }).state,
    ).toBe('unavailable-no-credential');
  });

  it.each(['', undefined, null, 42, {}])('does not report without a site identity (%s)', (siteUuid) => {
    expect(reportingState({ ...base, siteUuid } as Input)).toEqual({ state: 'not-enrolled', reports: false });
  });

  it('does not report without a credential, and says so distinctly', () => {
    // Distinct from "off": the deployment intends to report and cannot, which is a delivery problem
    // rather than a choice.
    expect(reportingState({ ...base, hasCredential: false })).toEqual({
      state: 'unavailable-no-credential',
      reports: false,
    });
  });

  it.each(['0', 'false', 'off', 'no', 'FALSE', 'Off'])(
    'honours PATCHSTACK_REPORT_DETECTIONS=%s',
    (value) => {
      expect(reportingState({ ...base, env: { PATCHSTACK_REPORT_DETECTIONS: value } })).toEqual({
        state: 'disabled-by-config',
        reports: false,
      });
    },
  );

  it.each(['', undefined, '1', 'true', 'on', 'yes', 'anything-else'])(
    'does not read PATCHSTACK_REPORT_DETECTIONS=%s as an opt-out',
    (value) => {
      // An unset or empty variable is the default, not a choice; and only the false-ish words switch it
      // off, so a deployment setting it to any other value is not silently disabling evidence.
      expect(reportingState({ ...base, env: { PATCHSTACK_REPORT_DETECTIONS: value } }).reports).toBe(true);
    },
  );

  it('keeps the two opt-outs distinguishable', () => {
    // An operator who set one variable must not be told to check the other.
    expect(reportingState({ ...base, env: { PATCHSTACK_TELEMETRY: '0' } }).state).toBe(
      'disabled-by-telemetry-opt-out',
    );
    expect(reportingState({ ...base, env: { PATCHSTACK_REPORT_DETECTIONS: '0' } }).state).toBe(
      'disabled-by-config',
    );
  });

  it('reports an explicit opt-out ahead of a missing credential', () => {
    // The order is the meaning: a deployment that switched reporting off should be told that is why,
    // not that it lacks a credential it never needed.
    expect(
      reportingState({
        ...base,
        hasCredential: false,
        siteUuid: undefined,
        env: { PATCHSTACK_REPORT_DETECTIONS: '0' },
      }).state,
    ).toBe('disabled-by-config');
  });

  it.each([true, false, undefined])('honours configOptOut=%s as an opt-out only', (configOptOut) => {
    // The programmatic flag can switch reporting off. It must never switch it on: whether a site is
    // managed is the platform's answer, and a guard that could self-declare it would report against rule
    // ids the platform never issued.
    const offSite = { siteUuid: undefined, ruleOrigin: 'bundled', hasCredential: false, env: {}, configOptOut } as Input;
    const onSite = { ...base, configOptOut } as Input;

    expect(reportingState(offSite).reports, 'an unmanaged site never reports').toBe(false);
    expect(reportingState(onSite).reports).toBe(configOptOut !== true);
    if (configOptOut === true) {
      expect(reportingState(onSite).state).toBe('disabled-by-config');
    }
  });

  it('has exactly one answer for every combination of inputs', () => {
    // Exhaustive over the axes. A combination with no defined state would surface as reporting silently
    // on or silently off depending on which check happened to fall through.
    const origins = ['api', 'cache', 'bundled', 'empty', undefined] as const;
    const envs = [
      {},
      { PATCHSTACK_REPORT_DETECTIONS: '0' },
      { PATCHSTACK_TELEMETRY: '0' },
      { PATCHSTACK_REPORT_DETECTIONS: '0', PATCHSTACK_TELEMETRY: '0' },
    ];
    let count = 0;

    for (const siteUuid of ['site-1', '', undefined]) {
      for (const ruleOrigin of origins) {
        for (const hasCredential of [true, false]) {
          for (const env of envs) {
            for (const configOptOut of [true, false, undefined]) {
              const result = reportingState({ siteUuid, ruleOrigin, hasCredential, env, configOptOut } as Input);
              count++;

              expect(REPORTING_STATES).toContain(result.state);
              // `reports` is true for exactly one state, so the two can never disagree.
              expect(result.reports).toBe(result.state === 'on');
              // And an opt-out is absolute: no other input combination can override it.
              if (configOptOut === true) expect(result.reports).toBe(false);
            }
          }
        }
      }
    }

    expect(count).toBe(3 * 5 * 2 * 4 * 3);
  });

  it('explains every state it can produce', () => {
    // A state name is a label; an operator asking why nothing arrived needs the sentence.
    for (const state of REPORTING_STATES) {
      const explanation = explainReportingState(state);

      expect(explanation.length).toBeGreaterThan(20);
      expect(explanation).not.toContain('Unrecognised');
    }
  });
});
