export type Action = "ALLOW" | "LOG" | "BLOCK" | "REDIRECT";

export declare const ACTIONS: {
  ALLOW: "ALLOW";
  LOG: "LOG";
  BLOCK: "BLOCK";
  REDIRECT: "REDIRECT";
};

/** A normalized snapshot of one request. The framework guard builds this. */
export interface RequestContext {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Parsed request payload; rule parameters read from here (e.g. "insert.title"). */
  body: Record<string, unknown>;
  ip?: string;
}

export interface RuleCondition {
  parameter: string | string[];
  match: { type: "inline_xss" | "contains" | "equals" | string; value?: unknown };
  mutations?: string[];
}

/** Only apply the rule if the app has this package at a vulnerable version. */
export interface PackageCond {
  package: string;
  vulnerable_versions?: string[];
}

export interface Rule {
  id: string;
  title?: string;
  vulnerability_id?: string;
  package_cond?: PackageCond;
  rule_v2: RuleCondition[];
}

/** The app's installed package list, so package_cond can gate. */
export interface Manifest {
  packages: Record<string, string>;
}

export interface Verdict {
  matched: boolean;
  action: Action;
  rule_id: string | null;
  vulnerability_id: string | null;
  package: string | null;
  version: string | null;
  explain: string[];
  trace: unknown[];
}

export declare function evaluate(ctx: RequestContext, rules: Rule[], manifest?: Manifest): Verdict;
export declare function urldecode(value: string): string;
