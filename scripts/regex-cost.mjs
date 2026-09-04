// What a rule's regex can cost, measured rather than inferred.
//
// Review tooling, not runtime. It lives here rather than under `src/protect/` because it is Node-only
// — it measures in a `worker_threads` worker — and the engine it screens also runs on edge runtimes
// with no Node built-ins. Nothing on the request path imports it, it is not part of the published
// package, and putting it beside the engine would invite both of those to change quietly.
//
// `safeRegExp()` refuses the shapes that backtrack EXPONENTIALLY — a quantifier inside a quantified
// group, an alternation under a quantifier. It does not refuse the polynomial shape: two sibling
// quantified atoms separated by a literal that both of them admit. `[a-z:]+:[a-z:]+@` leaves every
// colon available as the separator, so a candidate run with no `@` is re-split at every position.
//
// That shape is not detectable statically without refusing safe rules along with it. `.+\(.+:\d+\)`
// has the same overlap on paper — `.` admits `(` — and is linear in practice, because the required
// literal after each run gives the engine something to scan for. A static check strict enough to
// catch the first refuses the second, and a refused pattern is a rule that never fires: it protects
// nothing, and the counts that would show it are the counts it was supposed to produce. Measuring
// tells the two apart; reading the pattern does not.
//
// So this module measures, and nothing here refuses anything. It runs where a rule is reviewed, not
// where one is applied: this package's tests screen the compiled defaults with it. It is deliberately
// not on the request path — probing every delivered pattern at load would spend the cost it looks for.
//
// Measurement happens in a worker with a deadline the PARENT enforces. A regex is synchronous and
// cannot be interrupted from inside, so a budget checked after `test()` returns is not a budget: the
// pattern it is meant to catch is the one that never returns. `/a+b+c/` passes `safeRegExp` and does
// not finish rejecting a 512KB run of `a` in any time worth waiting for. `worker.terminate()` does
// stop a hot regex, so the deadline is real rather than advisory.
//
// The screening cap is not a substitute: `max_bytes` raises it and `bypass_limit` removes it, so a
// rule may be screened against a body far larger than the default.

import { LIMITS } from '../src/protect/rules/contract.js';

/** Characters a representative candidate is drawn from. Deliberately narrow and printable. */
const ALPHABET = [...'abzABZ019', ...'._-~%', ...':;,@/', ...'!$&\'()*+=', ...'[]{}<>"\\', ' '];

/**
 * Split a pattern body into atoms, each with whether a quantifier follows it.
 *
 * Not a regex parser. It reads enough structure to find the quantified runs and the literals between
 * them, and treats anything it does not recognise as an opaque atom — which costs a weaker candidate,
 * never a wrong verdict, because a candidate that fails to provoke the pattern makes the measurement
 * report a cost the pattern really did have on that input.
 */
function atomsOf(body) {
  const atoms = [];
  let i = 0;

  while (i < body.length) {
    let source = null;

    if (body[i] === '\\') {
      // An escape is one atom: `\w`, `\d`, `\s`, `\.`, `\/`.
      source = body.slice(i, i + 2);
      i += 2;
    } else if (body[i] === '[') {
      // A character class, whose first `]` may be literal and whose members may be escaped.
      let j = i + 1;
      if (body[j] === '^') j += 1;
      if (body[j] === ']') j += 1;
      while (j < body.length && body[j] !== ']') j += body[j] === '\\' ? 2 : 1;
      source = body.slice(i, j + 1);
      i = j + 1;
    } else if (body[i] === '(') {
      // A group, to the matching paren. Opaque: candidates are not derived from inside one.
      let depth = 0;
      let j = i;
      while (j < body.length) {
        if (body[j] === '\\') j += 2;
        else {
          if (body[j] === '(') depth += 1;
          else if (body[j] === ')') {
            depth -= 1;
            if (depth === 0) break;
          }
          j += 1;
        }
      }
      source = body.slice(i, j + 1);
      i = j + 1;
    } else {
      source = body[i];
      i += 1;
    }

    // A quantifier binds to the atom just read.
    let quantified = false;
    if (i < body.length) {
      if (body[i] === '+' || body[i] === '*') {
        quantified = true;
        i += 1;
      } else if (body[i] === '{') {
        const close = body.indexOf('}', i);
        if (close !== -1 && /^\{\d+(,\d*)?\}$/.test(body.slice(i, close + 1))) {
          quantified = true;
          i = close + 1;
        }
      }
    }
    if (body[i] === '?') i += 1; // lazy or optional; the atom is the same either way

    atoms.push({ source, quantified, literal: /^(?:[^\\[(.^$|?*+{}]|\\[^wdsWDSbB])$/.test(source) });
  }

  return atoms;
}

/** The one character of ALPHABET this atom accepts, or null when it accepts none of them. */
function representative(atom) {
  let expression;
  try {
    expression = new RegExp(`^(?:${atom.source})$`);
  } catch {
    return null;
  }

  for (const character of ALPHABET) {
    // A candidate must not carry a newline: `.` stops there, which would bound the run for free and
    // make the measurement optimistic about the very pattern it is testing.
    if (character === '\n' || character === '\r') continue;
    try {
      if (expression.test(character)) return character;
    } catch {
      return null;
    }
  }

  return null;
}

/** The literal text an atom contributes to a candidate, or null when it contributes nothing. */
function literalText(atom) {
  if (!atom.literal) return null;
  const text = atom.source.startsWith('\\') ? atom.source[1] : atom.source;
  return text === '\n' || text === '\r' ? null : text;
}

/**
 * A worst-case candidate for a pattern: the input it has to work hardest to REJECT.
 *
 * Built as the pattern's own lead-in literals, then a repeated filler drawn from its first quantified
 * atom and the separator that follows it, and nothing that could complete a match. A pattern that
 * never matches is where backtracking is paid in full — a match returns early.
 *
 * Heuristic, and honest about it: `deriveCandidate` returning null, or returning a candidate the
 * pattern shrugs off, is why {@link screenPatternCost} accepts a declared candidate as well. The
 * derived one is a floor, not a guarantee.
 */
export function deriveCandidate(pattern, bytes) {
  const match = String(pattern ?? '').match(/^\/(.+)\/([gimsuy]*)$/s);
  if (!match) return null;

  const atoms = atomsOf(match[1]);
  const first = atoms.findIndex((atom) => atom.quantified && representative(atom) !== null);
  if (first === -1) return null;

  const lead = atoms
    .slice(0, first)
    .map(literalText)
    .filter((text) => text !== null)
    .join('');

  // The literals between this quantified atom and the next one are the separator that makes the two
  // runs overlap; a candidate without them cannot provoke the re-splitting this exists to find.
  let separator = '';
  for (let i = first + 1; i < atoms.length; i += 1) {
    if (atoms[i].quantified) break;
    const text = literalText(atoms[i]);
    if (text === null) break;
    separator += text;
    if (separator.length >= 3) break;
  }

  const filler = `${representative(atoms[first])}${separator}`;
  if (filler === '') return null;

  return lead + filler.repeat(Math.ceil(Math.max(0, bytes - lead.length) / filler.length));
}

/**
 * The worker body. Compiles the pattern, says so, then measures — in that order, because the parent
 * starts its deadline on the ready message and compiling is not the cost being measured.
 */
const WORKER = `
const { workerData, parentPort } = require('node:worker_threads');
try {
  const expression = new RegExp(workerData.body, workerData.flags);
  // Compiled, and now idle until the parent says go. Starting here instead would hand the regex any
  // time the parent takes to schedule the ready message and arm its timer — runtime nothing measures
  // and nothing bounds.
  parentPort.postMessage({ ready: true });
  parentPort.once('message', () => {
    const started = process.hrtime.bigint();
    const matched = expression.test(workerData.candidate);
    parentPort.postMessage({ elapsed: Number(process.hrtime.bigint() - started) / 1e6, matched });
  });
} catch (error) {
  parentPort.postMessage({ failed: String(error && error.message) });
}
`;

/**
 * How long `pattern` takes to reject `candidate`, or that it did not finish in `timeoutMs`.
 *
 * Runs in a worker the caller can kill. Timing it in this thread would mean waiting for the answer to
 * the question being asked — a pattern over the budget by orders of magnitude holds the process until
 * it is done, and no test timeout can take it back, because a test timeout cannot interrupt
 * synchronous JavaScript either.
 *
 * @returns {Promise<{elapsed: number, matched: boolean, timedOut: false} | {timedOut: true} | null>}
 */
export async function measurePatternCost(pattern, candidate, { timeoutMs = 250 } = {}) {
  const match = String(pattern ?? '').match(/^\/(.+)\/([gimsuy]*)$/s);
  if (!match) return null;

  // Flags are kept as authored. `y` only tries at `lastIndex`, so dropping it turns a sticky
  // expression into a search of the whole candidate and reports a cost the real one does not have;
  // `g` is harmless because every measurement compiles its own expression and nothing is reused.
  const { Worker } = await import('node:worker_threads');
  const worker = new Worker(WORKER, {
    eval: true,
    workerData: { body: match[1], flags: match[2], candidate },
  });

  return await new Promise((resolve) => {
    let deadline = null;
    let settled = false;

    // First answer wins. A worker that measured something then exits normally fires `exit` too, and
    // without this guard that exit resolves the promise as "measured nothing" — the real result loses
    // a race with the worker's own teardown.
    //
    // Termination is awaited before resolving, so a completed call means no measurement of this
    // pattern is still running. Resolving first lets a screening start its next candidate while the
    // previous worker is still being killed, which is a second hot regex on a machine the caller
    // believes is idle.
    const settle = (value) => {
      if (settled) return;
      settled = true;
      if (deadline !== null) clearTimeout(deadline);
      worker.terminate().then(
        () => resolve(value),
        () => resolve(value),
      );
    };

    // A worker that has already exited needs no terminating, and awaiting one that has gone would
    // only defer the answer.
    const settleExited = (value) => {
      if (settled) return;
      settled = true;
      if (deadline !== null) clearTimeout(deadline);
      resolve(value);
    };

    worker.on('message', (message) => {
      if (message.ready) {
        // Armed first, then released: the deadline is running before the regex is, so there is no
        // window in which the pattern is executing unmetered.
        deadline = setTimeout(() => settle({ timedOut: true }), timeoutMs);
        worker.postMessage('start');

        return;
      }
      if (message.failed) {
        settle(null);

        return;
      }
      settle({ elapsed: message.elapsed, matched: message.matched, timedOut: false });
    });
    worker.on('error', () => settle(null));
    // A worker that exits without answering measured nothing; reporting a cost for it would invent one.
    worker.on('exit', () => settleExited(null));
  });
}

/**
 * Build the declared candidate.
 *
 * A plain string is repeated to fill the size. A `{ lead, fill }` pair puts `lead` down ONCE and
 * repeats `fill` after it, which is the shape most of these patterns need: a prefix-anchored pattern
 * has one lead-in and then a long run, and repeating the lead-in instead re-bounds the run at every
 * copy — a candidate that looks large and provokes nothing.
 */
function buildDeclared(candidate, bytes) {
  if (typeof candidate === 'string' && candidate.length > 0) {
    return candidate.repeat(Math.max(1, Math.ceil(bytes / candidate.length))).slice(0, bytes);
  }

  if (candidate && typeof candidate === 'object' && typeof candidate.fill === 'string' && candidate.fill.length > 0) {
    const lead = typeof candidate.lead === 'string' ? candidate.lead : '';
    const room = Math.max(0, bytes - lead.length);
    return lead + candidate.fill.repeat(Math.ceil(room / candidate.fill.length));
  }

  return null;
}

/**
 * Screen one pattern against a size it may really be run at.
 *
 * `candidate` is the worst input a reviewer can think of for this pattern; the derived one is measured
 * alongside it, and the verdict comes from the worse of those that REJECTED. A candidate the pattern
 * matches is excluded from the verdict and reported: a match returns at the first success and pays
 * none of the backtracking a rejection pays, so its timing describes nothing. When no candidate is
 * rejected there is no measurement to draw a verdict from, and this says so rather than passing.
 *
 * A candidate that does not finish inside `timeoutMs` is outside the budget by construction — the
 * deadline is the budget, and the pattern is still running when it expires.
 */
export async function screenPatternCost(pattern, { candidate, bytes = 512 * 1024, budgetMs = 250 } = {}) {
  const inputs = [];
  const declared = buildDeclared(candidate, bytes);
  if (declared !== null) inputs.push({ source: 'declared', input: declared });

  const derived = deriveCandidate(pattern, bytes);
  if (derived !== null) inputs.push({ source: 'derived', input: derived });

  if (inputs.length === 0) {
    return { pattern, screened: false, reason: 'no candidate could be built or declared' };
  }

  const measurements = [];
  for (const { source, input } of inputs) {
    const measured = await measurePatternCost(pattern, input, { timeoutMs: budgetMs });
    if (measured === null) {
      return { pattern, screened: false, reason: `the pattern did not compile or the ${source} measurement failed` };
    }
    measurements.push({ source, bytes: input.length, ...measured });
  }

  const timedOut = measurements.filter((m) => m.timedOut);
  const matched = measurements.filter((m) => !m.timedOut && m.matched);
  const rejected = measurements.filter((m) => !m.timedOut && !m.matched);

  // A candidate still running when the deadline expires is over budget whatever else happened.
  if (timedOut.length > 0) {
    return {
      pattern,
      screened: true,
      within: false,
      budgetMs,
      worst: timedOut[0],
      measurements,
      matched: matched.map((m) => m.source),
    };
  }

  // Any match at all invalidates the screening, not just an all-matching one. A candidate the pattern
  // matches returns at its first success and measures nothing about backtracking — so a reviewer whose
  // declared worst case matches has had nothing screened, and would be told it passed because some
  // other candidate happened to reject. Naming it is the only way that gets fixed.
  if (matched.length > 0) {
    return {
      pattern,
      screened: false,
      reason: `the ${matched.map((m) => m.source).join(' and ')} candidate MATCHED, so it measured a match rather than a rejection`,
      measurements,
      matched: matched.map((m) => m.source),
    };
  }

  if (rejected.length === 0) {
    return { pattern, screened: false, reason: 'no candidate produced a measurement', measurements, matched: [] };
  }

  const worst = rejected.reduce((a, b) => (b.elapsed > a.elapsed ? b : a));

  return {
    pattern,
    screened: true,
    within: worst.elapsed <= budgetMs,
    budgetMs,
    worst,
    measurements,
    matched: matched.map((m) => m.source),
  };
}

/**
 * Every regex a rule carries, with the path of the clause carrying it.
 *
 * A rule's conditions nest — a sub-list under `rules`, a nested `match.match` for a path-scoped or
 * decoded match — and any of them may hold a pattern. Reading `rule_v2[0]` only screens rules whose
 * FIRST condition happens to be a regex, and a rule with a `contains` first and a regex second is
 * covered by nothing while the count of screened rules looks right.
 *
 * @returns {Array<{ruleId: string, path: string, pattern: string}>}
 */
export function regexClausesOf(rule) {
  const found = [];

  const visitMatch = (matchObj, path) => {
    if (!matchObj || typeof matchObj !== 'object') return;
    if (matchObj.type === 'regex' && typeof matchObj.value === 'string') {
      found.push({ ruleId: rule?.id ?? null, path, pattern: matchObj.value });
    }
    // `array_key_value` and the decoding matches carry the real test in a nested `match`.
    if (matchObj.match) visitMatch(matchObj.match, `${path}.match`);
  };

  const visit = (conditions, path, depth) => {
    // The contract's own limit, imported rather than restated. A second constant here that sat below
    // it would let a rule the contract accepts carry a pattern this walk never reaches — screened by
    // nothing, while the count of screened clauses looked right.
    if (!Array.isArray(conditions) || depth > LIMITS.maxNestingDepth) return;
    conditions.forEach((condition, index) => {
      if (!condition || typeof condition !== 'object') return;
      visitMatch(condition.match, `${path}[${index}].match`);
      if (Array.isArray(condition.rules)) visit(condition.rules, `${path}[${index}].rules`, depth + 1);
    });
  };

  visit(rule?.rule_v2, 'rule_v2', 0);

  return found;
}
