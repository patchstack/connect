// The CAPABILITY CONTRACT: the closed vocabularies that describe what the map can see.
//
// These lists are consumed by layers that ship separately — this extractor, the rule-authoring toolchain,
// and the platform that binds a coordinate into a rule. Each used to keep its own copy, which is a drift
// problem with a silent failure mode: a sink kind added here and missed by an authoring layer makes every
// detector naming it unauthorable, and one missed by the platform makes every flow of that kind unusable.
// Nothing errors — the capability simply never matches, which reads exactly like "not reachable".
//
// So there is ONE definition, here, and it is versioned. The TypeScript unions are derived from these
// arrays (not declared alongside them, which would be a fourth copy), `capabilities.json` is generated
// from them for the other repos to vendor and assert against, and a test fails if the two disagree.
//
// Adding a capability is deliberately a contract change: bump `CAPABILITY_VERSION`, regenerate the
// manifest, and update every layer that vendors it. A new sink family also owes adversarial corpus
// cases before it may generate rules — one capability admits a whole package family at once, so a wrong
// argument-role table mis-pins all of them.

/**
 * Version of this vocabulary. Additive changes (a new member) bump the MINOR; removing or renaming a
 * member is breaking and bumps the MAJOR, because a consumer pinned to the old list will keep emitting a
 * value that can no longer match.
 */
export const CAPABILITY_VERSION = '1.0.0';

/** Sink families the extractor recognizes. A dangerous OPERATION, not a package. */
export const SINK_KINDS = ['db', 'fs', 'http', 'exec', 'eval'] as const;

/**
 * Which argument of a sink call received the tainted value. This decides which mitigation class is even
 * applicable — `command` vs `args`, `path` vs `content`, `sql` vs `values` — so a consumer that cannot
 * read it cannot compile a rule.
 */
export const ARGUMENT_ROLES = [
  'command', 'file', 'args',
  'url', 'init', 'body', 'options',
  'path', 'content',
  'sql', 'values', 'columns', 'column', 'value',
  'code', 'unknown',
] as const;

/**
 * The mitigation classes a flow can support. Deliberately narrower than the roles: only patterns where a
 * request value reaching that argument is inherently dangerous AND a rule can express it.
 */
export const CANDIDATE_FAMILIES = ['ssrf', 'command-injection', 'path-traversal', 'sql-injection', 'code-injection'] as const;

/**
 * Flow confidence tiers, strongest first. Only the first two are *proven*; the rest are distinct kinds of
 * not-knowing rather than weaker degrees of the same thing, which is why consumers must treat this as a
 * set membership test and never as an ordering comparison.
 */
export const CONFIDENCE_TIERS = ['exact-local', 'transformed-local', 'imported', 'heuristic', 'unknown'] as const;

/** The tiers that assert the input actually reaches the sink — the only ones a rule may be pinned from. */
export const PROVEN_CONFIDENCE_TIERS = ['exact-local', 'transformed-local'] as const;

/** The single tier eligible for automatic promotion to blocking (subject to the server's own gates). */
export const AUTO_PROMOTABLE_CONFIDENCE = 'exact-local';

/** How a sink's package was established. Absent attribution is deliberately not a member: see `Sink`. */
export const ATTRIBUTIONS = ['import', 'global', 'inferred'] as const;

/** The request address spaces an input can live in — half of an input's identity. */
export const ADDRESS_SPACES = ['post', 'get', 'cookie', 'files', 'server', 'route-param', 'unknown'] as const;

/** The whole contract, as the other repos consume it. Key order is stable so the JSON is diffable. */
export const CAPABILITY_MANIFEST = {
  version: CAPABILITY_VERSION,
  sinkKinds: SINK_KINDS,
  argumentRoles: ARGUMENT_ROLES,
  candidateFamilies: CANDIDATE_FAMILIES,
  confidenceTiers: CONFIDENCE_TIERS,
  provenConfidenceTiers: PROVEN_CONFIDENCE_TIERS,
  autoPromotableConfidence: AUTO_PROMOTABLE_CONFIDENCE,
  attributions: ATTRIBUTIONS,
  addressSpaces: ADDRESS_SPACES,
} as const;

/**
 * What a declared capability owes before it counts as supported.
 *
 * Declaring a member of `SINK_KINDS` is a claim that the extractor recognizes that operation. Nothing in
 * the vocabulary enforces it: a kind can be added, the manifest regenerated, and every consumer taught to
 * accept a capability that no recognizer ever emits — a vocabulary entry with no behaviour behind it, and
 * a rule family that can never fire. The corpus does not catch it either, because a fixture that exercises
 * the OTHER kinds still passes a "we emit some sinks" assertion.
 *
 * So each kind names its own control: the minimal shape that must produce a sink of exactly that kind.
 * `tests/map/capabilities.test.ts` runs every control and fails on the one that produces nothing, and the
 * `Record<SinkKind, …>` type means adding a kind without a control is a TYPE error rather than a missing
 * test — the compiler asks the question before CI does.
 */
export interface CapabilityControl {
  /**
   * Handler body for the control fixture: one statement that must yield a sink of this kind, written the
   * way an app really would. `req.body.<param>` is the tainted input.
   */
  control: string;
  /** Imports the control needs, and the packages they come from. */
  setup: string;
  /** Dependencies the fixture's package.json must declare. */
  deps: string[];
  /**
   * true when a proven flow into this kind can compile a rule. Those are the kinds where a wrong
   * recognizer blocks real traffic, so they additionally owe adversarial corpus coverage — a lookalike
   * that must produce NO candidate. See the adversarial category in tests/map/corpus.test.ts.
   */
  ruleGeneratable: boolean;
}

export const CAPABILITY_CONTROLS: Record<(typeof SINK_KINDS)[number], CapabilityControl> = {
  db: {
    setup: 'import { Pool } from "pg";\nconst pool = new Pool();',
    control: 'pool.query(req.body.sql);',
    deps: ['pg'],
    ruleGeneratable: true,
  },
  fs: {
    setup: 'import fs from "node:fs";',
    control: 'fs.readFileSync(req.body.path);',
    deps: [],
    ruleGeneratable: true,
  },
  http: {
    setup: '',
    control: 'fetch(req.body.url);',
    deps: [],
    ruleGeneratable: true,
  },
  exec: {
    setup: 'import { exec } from "node:child_process";',
    control: 'exec(req.body.cmd);',
    deps: [],
    ruleGeneratable: true,
  },
  eval: {
    setup: '',
    control: 'eval(req.body.code);',
    deps: [],
    ruleGeneratable: true,
  },
};
