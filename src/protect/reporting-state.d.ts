// Declarations for `reporting-state.js`. The runtime is plain JS, so these are hand-authored — the same
// arrangement as `protect.d.ts`. They exist because the installer's `--check` decides the reporting state
// with the very function the guard uses: a second copy of that decision would drift, and the copy in the
// CLI would be the one nobody notices is wrong.

export type ReportingState =
  | "on"
  | "disabled-by-config"
  | "disabled-by-telemetry-opt-out"
  | "not-enrolled"
  | "no-managed-rules"
  | "unavailable-no-credential";

export const REPORTING_STATES: readonly ReportingState[];

export function reportingState(input: {
  siteUuid?: unknown;
  ruleOrigin?: "api" | "cache" | "bundled" | "empty";
  hasCredential?: boolean;
  configOptOut?: boolean;
  env?: Record<string, string | undefined>;
}): { state: ReportingState; reports: boolean };

/** A sentence an operator can act on, for every state that does not report. */
export function explainReportingState(state: ReportingState): string;
