import { describe, expect, it } from 'vitest';
import { DEFAULT_EGRESS_RULES, DEFAULT_RESPONSE_RULES } from '../../src/protect/defaults.js';
import { LIMITS } from '../../src/protect/rules/contract.js';
import {
  deriveCandidate,
  measurePatternCost,
  regexClausesOf,
  screenPatternCost,
} from '../../scripts/regex-cost.mjs';

/**
 * What a compiled pattern costs to REJECT a body, at a size it may really be run at.
 *
 * Regression coverage for the rules this package compiles in, and nothing wider. It does not screen a
 * rule delivered from the rules service, and does not stand between an authored rule and being served.
 *
 * `safeRegExp()` refuses exponential shapes and accepts the polynomial one — two sibling quantified
 * atoms separated by a literal both admit. The shape cannot be refused by reading a pattern, since a
 * check strict enough to catch it refuses linear patterns too, so it is measured here instead.
 *
 * Rejection, not matching: a match returns at its first success and pays none of the backtracking.
 * Every candidate is therefore built so the pattern cannot match it, and a candidate that does match
 * makes the screening invalid rather than passing.
 */

/** A pattern with the polynomial shape, and one without it. Neither is shipped. */
const OVERLAPPING = "/\\bpostgres:\\/\\/[A-Za-z0-9:._-]+:[A-Za-z0-9:._-]+@/i";
const DISJOINT = "/\\bpostgres:\\/\\/[A-Za-z0-9._-]+:[A-Za-z0-9:._-]+@/i";

/** Two sibling quantifiers and no group: accepted by `safeRegExp`, and does not finish at this size. */
const UNBOUNDED = '/a+b+c/';

/** The default response screening cap. `max_bytes` raises it and `bypass_limit` removes it. */
const CAP = 512 * 1024;

/** Smaller, for the cases that only need the verdict to be decisive. */
const DEMO = 64 * 1024;

const BUDGET_MS = 250;

type WorstCase = string | { lead?: string; fill: string };

/**
 * The input each compiled regex has to work hardest to reject, keyed by rule and clause.
 *
 * Keyed by clause, not by rule: one rule may carry several patterns, and a worst case for the first
 * says nothing about the third. Declared rather than derived, because the derived candidate is a
 * heuristic — and one that fails to provoke a pattern reports a cost the pattern never paid.
 */
const WORST_CASE: Record<string, WorstCase> = {
  // A label run that never reaches the closing `-----`, with no `PRIVATE KEY` in it.
  'resp-private-key::rule_v2[0].match': { lead: '-----BEGIN ', fill: 'A' },
  'resp-aws-access-key::rule_v2[0].match': 'AKIAAAAAAAAAAAAAAAAA',
  'resp-gcp-api-key::rule_v2[0].match': 'AIzaAAAAAAAAAAAAAAAAAAAA',
  // Three token characters and then one the alphabet excludes, so the length is never reached.
  'resp-vendor-api-key::rule_v2[0].match': 'sk_live_aaa-',
  'resp-supabase-secret-key::rule_v2[0].match': 'sb_secret_aaaaaaaaaaaaaaaaaaaaaa_',
  // The userinfo run with its separator and no `@`. The scheme is the lead and is laid down once:
  // repeating it would put a `/` in the run, which both userinfo classes exclude, and bound the
  // re-splitting this is meant to provoke.
  'resp-db-connection-string::rule_v2[0].match': { lead: 'postgres://', fill: 'a:' },
  // One line, no newline anywhere — a newline bounds `.` for free and flatters the measurement.
  'resp-stack-trace::rule_v2[0].match': { lead: ' at f (', fill: 'a:1:1' },
  'resp-sql-error::rule_v2[0].match': 'SQLSTATE[',
  'resp-exception-trace::rule_v2[0].match': 'at a.b(c.java:1',
};

const compiled = [...DEFAULT_RESPONSE_RULES, ...DEFAULT_EGRESS_RULES] as any[];
const keyOf = (clause: { ruleId: string | null; path: string }) => `${clause.ruleId}::${clause.path}`;
const clauses = compiled.flatMap((rule) => regexClausesOf(rule));

describe('the measurement itself', () => {
  it('reports a pattern that does not finish, without waiting for it', async () => {
    // The property that makes a budget a budget. A regex is synchronous and cannot be interrupted from
    // inside, so a timing checked after `test()` returns cannot catch the pattern that never returns —
    // and no test timeout catches it either, because a test timeout cannot interrupt synchronous work.
    // The deadline is enforced by the parent of the worker doing the measuring.
    const started = Date.now();
    const result = await screenPatternCost(UNBOUNDED, { candidate: 'a', bytes: CAP, budgetMs: BUDGET_MS });
    const waited = Date.now() - started;

    expect(result.screened).toBe(true);
    expect(result.within, 'a pattern that never returned was reported as within budget').toBe(false);
    expect(result.worst!.timedOut, 'expected the deadline to expire, not a completed measurement').toBe(true);
    // Generous, and still orders below what this pattern would take to finish on its own.
    expect(waited, `screening waited ${waited}ms`).toBeLessThan(10_000);
  }, 30_000);

  it('reports the polynomial shape as outside the budget', async () => {
    // Non-vacuity: a screening that passes everything says nothing about what it screened.
    const result = await screenPatternCost(OVERLAPPING, {
      candidate: { lead: 'postgres://', fill: 'a:' },
      bytes: DEMO,
      budgetMs: BUDGET_MS,
    });

    expect(result.screened).toBe(true);
    expect(result.within).toBe(false);
  }, 30_000);

  it('reports the same pattern with a disjoint separator as within it', async () => {
    // The single difference is the colon in the first class. Same candidate, same size.
    const result = await screenPatternCost(DISJOINT, {
      candidate: { lead: 'postgres://', fill: 'a:' },
      bytes: DEMO,
      budgetMs: BUDGET_MS,
    });

    expect(result.screened, result.reason).toBe(true);
    expect(result.within, `took ${result.worst?.elapsed?.toFixed(1)}ms`).toBe(true);
  }, 30_000);

  it('derives a candidate that provokes the shape on its own', async () => {
    // The declared candidate carries a reviewer's knowledge; the derived one is what a pattern nobody
    // wrote a worst case for still gets, so it has to be worth something on its own.
    const derived = deriveCandidate(OVERLAPPING, DEMO);

    expect(derived, 'no candidate was derived').not.toBeNull();
    expect(derived!.startsWith('postgres://'), 'the lead-in was not reproduced').toBe(true);
    expect(derived).not.toContain('@');

    const measured = (await measurePatternCost(OVERLAPPING, derived!, { timeoutMs: BUDGET_MS })) as any;
    expect(measured.timedOut, 'the derived candidate provoked nothing').toBe(true);
  }, 30_000);

  it('invalidates a screening whose candidate matched', async () => {
    // A match returns at the first success and measures nothing about backtracking. Reporting a cost
    // from it would say a worst case had been screened when it had not — so the screening is invalid,
    // even when another candidate rejected quickly and could have supplied a comfortable verdict.
    const result = await screenPatternCost(UNBOUNDED, { candidate: 'abc', bytes: 4096, budgetMs: BUDGET_MS });

    expect(result.screened).toBe(false);
    expect(result.reason).toContain('MATCHED');
    expect(result.matched).toContain('declared');
  }, 30_000);

  it('measures a sticky pattern as sticky', async () => {
    // Flags are kept as authored. `y` only tries at `lastIndex`, so dropping it turns a sticky
    // expression into a search of the whole candidate — a different expression, with a different cost.
    // `safeRegExp` accepts `y`, so a rule may carry one.
    const sticky = (await measurePatternCost('/abc/y', 'zabc', { timeoutMs: BUDGET_MS })) as any;
    const searching = (await measurePatternCost('/abc/', 'zabc', { timeoutMs: BUDGET_MS })) as any;

    expect(sticky.matched, 'the sticky flag was dropped').toBe(false);
    expect(searching.matched).toBe(true);
  }, 30_000);

  it('never builds a candidate carrying a newline', () => {
    // `.` stops at a newline, so a candidate containing one bounds the run for free and understates
    // every `.`-based pattern — including two of the compiled ones.
    for (const clause of clauses) {
      const derived = deriveCandidate(clause.pattern, 4096);
      if (derived === null) continue;
      expect(derived, `${keyOf(clause)} derived a candidate containing a newline`).not.toMatch(/[\r\n]/);
    }
  });

  it('reports a pattern it cannot compile rather than passing it', async () => {
    expect((await screenPatternCost('not a pattern')).screened).toBe(false);
    expect((await screenPatternCost('/[/')).screened).toBe(false);
  }, 30_000);
});

describe('finding the patterns a rule carries', () => {
  it('finds a regex in a clause that is not the first', () => {
    // Reading `rule_v2[0]` covers a rule whose FIRST condition is a regex. A rule with a `contains`
    // first and a regex second is then screened by nothing, while the count of screened rules looks
    // right — the shape of defect this file exists to catch elsewhere.
    const rule = {
      id: 'r1',
      rule_v2: [
        { parameter: 'get.q', match: { type: 'contains', value: 'x' } },
        { parameter: 'get.p', match: { type: 'regex', value: '/second/' } },
      ],
    };

    expect(regexClausesOf(rule)).toEqual([{ ruleId: 'r1', path: 'rule_v2[1].match', pattern: '/second/' }]);
  });

  it('finds a regex nested under a sub-list and under a nested match', () => {
    const rule = {
      id: 'r2',
      rule_v2: [
        {
          parameter: 'rules',
          rules: [{ parameter: 'get.q', match: { type: 'regex', value: '/inner/' } }],
        },
        {
          parameter: 'post.body',
          match: { type: 'array_key_value', value: 'a.b', match: { type: 'regex', value: '/leaf/' } },
        },
      ],
    };

    expect(regexClausesOf(rule).map((clause) => [clause.path, clause.pattern])).toEqual([
      ['rule_v2[0].rules[0].match', '/inner/'],
      ['rule_v2[1].match.match', '/leaf/'],
    ]);
  });

  it('reaches a regex as deep as the contract allows', () => {
    // The walk and the contract have to agree. A rule nested to the contract's limit is valid and
    // servable, so a pattern at that depth must be found — one the walk stops short of is screened by
    // nothing while the count of screened clauses looks right.
    const nest = (depth: number): any =>
      depth === 0
        ? [{ parameter: 'get.q', match: { type: 'regex', value: '/deep/' } }]
        : [{ parameter: 'rules', rules: nest(depth - 1) }];

    const atLimit = regexClausesOf({ id: 'deep', rule_v2: nest(LIMITS.maxNestingDepth) });

    expect(atLimit.map((clause) => clause.pattern), `nothing found at depth ${LIMITS.maxNestingDepth}`).toEqual([
      '/deep/',
    ]);
  });

  it('finds nothing to screen in a match that carries no pattern', () => {
    // `jwt_claim_equals` also has a `value`. Reading it as a pattern reports "did not compile" for a
    // rule that has nothing to compile, which is a failure indistinguishable from a real one.
    const rule = {
      id: 'r3',
      rule_v2: [{ parameter: 'response.body', match: { type: 'jwt_claim_equals', claim: 'role', value: 'service_role' } }],
    };

    expect(regexClausesOf(rule)).toEqual([]);
  });
});

describe('every regex the compiled rules carry, at the size it may be screened at', () => {
  // The budget is generous — orders above what a linear pattern spends here — so this fails on a shape
  // change rather than on timing noise.
  it.each(clauses.map((clause) => [keyOf(clause), clause] as const))('%s', async (key, clause) => {
    const result = await screenPatternCost(clause.pattern, {
      candidate: WORST_CASE[key],
      bytes: CAP,
      budgetMs: BUDGET_MS,
    });

    expect(result.screened, result.reason).toBe(true);
    expect(
      result.within,
      `${key} took ${result.worst!.timedOut ? `longer than ${BUDGET_MS}ms` : `${result.worst!.elapsed.toFixed(1)}ms`} on its ${result.worst!.source} candidate`,
    ).toBe(true);
  }, 30_000);

  it('screens at least one regex from every compiled rule that carries any', () => {
    // The set, not just the members: a rule whose patterns all went missing from the walk would leave
    // the cases above passing over a shorter list.
    const carrying = compiled.filter((rule) => regexClausesOf(rule).length > 0).map((rule) => rule.id);
    const screened = new Set(clauses.map((clause) => clause.ruleId));

    expect(carrying.filter((id) => !screened.has(id))).toEqual([]);
    expect(clauses.length).toBeGreaterThanOrEqual(carrying.length);
  });

  it('has a declared worst case for every one of them', () => {
    // Completeness. A clause with no worst case was screened by a heuristic, not by a reviewer.
    const missing = clauses.filter((clause) => WORST_CASE[keyOf(clause)] === undefined).map(keyOf);

    expect(missing, 'these compiled regex clauses have no declared worst case').toEqual([]);
  });

  it('declares a worst case for nothing that is not compiled in', () => {
    // The other direction: a stale entry leaves a real clause uncovered while the count looks right.
    const live = new Set(clauses.map(keyOf));
    const stale = Object.keys(WORST_CASE).filter((key) => !live.has(key));

    expect(stale, 'these worst cases name no compiled regex clause').toEqual([]);
  });
});
