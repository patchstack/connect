// The Node flags this package is willing to understand, in one place.
//
// Three callers need the same inventory and would otherwise each keep their own. The runtime check's
// entry resolver reads flags out of a project's start script; the probe decides whether an inherited
// `NODE_OPTIONS` can be carried into the child it launches; the structural parse retains only known-safe
// options in the environment of a `node --check`. A flag classified generously in one of those places
// and strictly in another is a hole, so the classification lives here.
//
// The list is an ALLOWLIST, and deliberately short. An unrecognised flag is refused rather than passed
// on, because the two things that make a flag safe to carry — it does not run code, and its meaning does
// not depend on the token after it — cannot be decided by looking at a name nobody wrote down.

/** `--name=value` and `--name` both name the same flag. */
export const flagName = (token: string): string => token.split('=')[0]!;

/**
 * Flags that take no operand, so the token after one is not its value.
 *
 * This is what makes them safe for a reader that splits on whitespace: nothing about the meaning of the
 * next token depends on them.
 */
export const NO_OPERAND_FLAGS = new Set([
  '--disallow-code-generation-from-strings',
  '--enable-source-maps',
  '--experimental-import-meta-resolve',
  '--experimental-json-modules',
  '--experimental-vm-modules',
  '--frozen-intrinsics',
  '--no-deprecation',
  '--no-warnings',
  '--pending-deprecation',
  '--preserve-symlinks',
  '--preserve-symlinks-main',
  '--throw-deprecation',
  '--trace-deprecation',
  '--trace-exit',
  '--trace-uncaught',
  '--trace-warnings',
  '--use-strict',
  '--zero-fill-buffers',
]);

/**
 * Flags accepted only in their self-contained `--name=value` form.
 *
 * Each one sets a limit or a preference. None of them loads a module, evaluates a string, opens a port,
 * or changes which file Node treats as the program — which is the whole test for being on this list.
 * `--env-file` is deliberately absent: a file it reads can set `NODE_OPTIONS` itself.
 */
export const VALUED_FLAGS = new Set([
  '--dns-result-order',
  '--max-http-header-size',
  '--max-old-space-size',
  '--max-semi-space-size',
  '--stack-size',
  '--title',
  '--unhandled-rejections',
]);

/**
 * Flags refused in every form, including `--name=value`.
 *
 * The first group runs code — a module preloaded, a loader installed, a string evaluated — which for the
 * runtime check means code running before the listener reporter is in place, the one window in which an
 * app could open a listener nothing screened. `--eval` and `--print` also take the program itself out of
 * the file named on the command line, so a resolver that passed one on would report on a file that never
 * ran. The second group opens a debugger port, which is a listener of its own that a verification has no
 * business opening on someone's machine.
 */
export const CODE_LOADING_FLAGS = new Set([
  '--require',
  '-r',
  '--import',
  '--loader',
  '--experimental-loader',
  '--eval',
  '-e',
  '--print',
  '-p',
  '--inspect',
  '--inspect-brk',
  '--inspect-wait',
  '--inspect-port',
  '--debug',
  '--debug-brk',
]);

/** Of those, the ones whose value is the NEXT token, so dropping the flag has to drop its operand too. */
const TAKES_NEXT_TOKEN = new Set(['--require', '-r', '--import', '--loader', '--experimental-loader', '--eval', '-e', '--print', '-p', '--inspect-port']);

/**
 * Split a `NODE_OPTIONS` value the way Node's own parser does: on whitespace, honouring double quotes.
 *
 * Returns null for an unbalanced quote. Node would split such a value somehow, but not necessarily the
 * way this reads it, and a classification of tokens that are not the tokens Node will see is worth
 * nothing.
 */
export function tokenizeNodeOptions(value: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;

  for (const ch of value) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (quoted) return null;
  if (started) tokens.push(current);

  return tokens;
}

export type NodeOptionsVerdict = { kind: 'safe' } | { kind: 'refused'; why: string };

/** Whether every flag in a `NODE_OPTIONS` value is one of the two allowlists above. */
export function classifyNodeOptions(value: string): NodeOptionsVerdict {
  const tokens = tokenizeNodeOptions(value);
  if (tokens === null) return { kind: 'refused', why: 'NODE_OPTIONS has an unbalanced double quote, so this cannot read it the way Node will' };

  for (const token of tokens) {
    const name = flagName(token);
    if (CODE_LOADING_FLAGS.has(name)) {
      return { kind: 'refused', why: `NODE_OPTIONS carries ${name}, which runs code or opens a port before the listener reporter is in place` };
    }
    if (NO_OPERAND_FLAGS.has(token)) continue;
    if (token.includes('=') && VALUED_FLAGS.has(name)) continue;

    return { kind: 'refused', why: `NODE_OPTIONS carries ${name}, which this does not recognise well enough to say what it does` };
  }

  return { kind: 'safe' };
}

/**
 * The known-safe part of the same value, for a child that must not evaluate anything.
 *
 * Unlike the classification above this keeps going rather than refusing: the caller is a structural
 * parse whose answer is useful even when the environment carries something odd. Only the two explicit
 * allowlists survive. That also drops compact or future code-loading forms this package does not know by
 * name; keeping an unknown flag would make the claim that the child only parses depend on what a newer
 * Node assigns that flag to mean. A value that cannot be tokenised is dropped whole.
 */
export function withoutCodeLoading(value: string | undefined): string {
  if (value === undefined || value.trim() === '') return '';
  const tokens = tokenizeNodeOptions(value);
  if (tokens === null) return '';

  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const name = flagName(token);
    if (CODE_LOADING_FLAGS.has(name)) {
      if (!token.includes('=') && TAKES_NEXT_TOKEN.has(name)) i++; // its value is the next token
      continue;
    }
    if (NO_OPERAND_FLAGS.has(token) || (token.includes('=') && VALUED_FLAGS.has(name))) kept.push(token);
  }

  // Re-quoted on the way out, so a kept path with a space survives the round trip. A token cannot
  // contain a double quote: the tokeniser consumes those.
  return kept.map((token) => (/\s/.test(token) ? `"${token}"` : token)).join(' ');
}
