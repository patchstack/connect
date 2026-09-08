// A digest of the rule set this package compiles in, per rule and over the whole set.
//
// The guard ships rules and the platform serves the same policies as documents it can revise. Both
// copies exist on purpose — one protects an app before it is enrolled, the other can be corrected
// without a release — and they agree only if something checks. This makes that check a comparison of
// two values.
//
//   node scripts/rule-set-digest.mjs             # the digests
//   node scripts/rule-set-digest.mjs --canonical # what was digested, to read when two copies disagree
//
// The comparison is set-to-set on declaration digests rather than rule-to-rule by name, so it needs no
// identifier shared between the copies: two rule sets agree when their digest sets are equal. What is
// compared is a PROJECTION of the contract's properties — the ones the copies are trusted to differ on
// are named in `EXCLUDED_FROM_COMPARISON`, so equal digests mean agreement on everything compared here
// and not identical behaviour.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { RULE_PROPERTIES } from '../src/protect/rules/contract.js';
import { DEFAULT_EGRESS_RULES, DEFAULT_RESPONSE_RULES } from '../src/protect/defaults.js';

/**
 * Contract properties this comparison deliberately leaves out, each because the two copies are MEANT
 * to differ on it.
 *
 * Not a claim that they do not affect behaviour. `enforcement` decides whether a matching rule acts at
 * all, and `title` becomes the block message when a rule declares no `message`. So equal digests mean
 * the two copies agree on everything compared here — a policy projection — and NOT that they behave
 * identically. What they are trusted to differ on has to stay out, or the comparison reports drift on
 * every rename while staying silent on a changed pattern.
 *
 * Stated as exclusions rather than as an inclusion list so a property added to the contract is compared
 * by default: a list of what to include leaves a new property silently outside the comparison, and a
 * comparison that ignores a field reports agreement about it.
 */
export const EXCLUDED_FROM_COMPARISON = Object.freeze({
  id: 'names the rule within one copy; the copies number their rules independently',
  rule_id: 'the same, under the alternate spelling the contract allows',
  title: 'addresses a reader, and the copies address different ones — though it can surface as a block message',
  source_revision: 'identifies a served document, which a compiled rule does not have',
  enforcement: 'decides whether a rule acts, and the served copy observing where the compiled one acts is the point of serving it',
});

/** The fields this comparison covers: the contract's properties, less the ones above. */
export const COMPARED = Object.freeze(
  RULE_PROPERTIES.filter((property) => !(property in EXCLUDED_FROM_COMPARISON)),
);

/**
 * Raised when a value cannot be written in the canonical form, so no digest is produced for it.
 *
 * Positively or not at all. A digest is only worth comparing if the other side would produce the same
 * one, so a value this form cannot pin down is refused rather than digested into something that happens
 * to differ across implementations — which would report drift in documents that agree.
 */
export class NotCanonical extends Error {}

/**
 * The canonical text of a value.
 *
 * Written out here rather than handed to `JSON.stringify`, because the two sides of this comparison are
 * different languages and their encoders disagree on values the rule contract accepts:
 *
 * - an empty object and an empty array are the same value to a PHP associative decode;
 * - `-0` survives one encoder and becomes `0` in the other;
 * - `1e-7` is written `1e-7` by one and `1.0e-7` by the other, and the same for large exponents.
 *
 * None of those is exotic — `cookie_flags: {}` is a valid rule and an operand may be a number — so
 * agreeing on an encoder is not enough. The form below is the agreement:
 *
 * - `null`, `true`, `false` as those three words;
 * - a string in double quotes, escaping only `"`, `\` and the characters below a space, the last as
 *   `\u00xx` in lowercase. Not the short forms, because those are a second spelling to agree on;
 * - a number only when it is a SAFE integer, written in decimal with no exponent and no negative zero.
 *   Anything else is refused: the shortest text that reads back as a given float is a property of each
 *   language's formatter, and this comparison cannot rest on those matching. The bound is not fussiness
 *   — above 2^53 this language writes `1e+21` where another writes the digits, and a conversion to a
 *   64-bit integer produces a different number again;
 * - an array in order, because `rule_v2` is a sequence whose order changes what a rule does;
 * - an object with its keys sorted, because the same rule typed in another order is the same rule. An
 *   empty one is `{}` and stays distinguishable from an empty array.
 */
function canonicalText(value) {
  if (value === null || value === undefined) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';

  if (typeof value === 'number') {
    // SAFE integers, not merely integral ones. `1e21` is an integer to this language and writes itself
    // `1e+21`, in exponent form, while an implementation holding it as an integer writes it out in full —
    // and one converting it to a 64-bit integer gets a different number entirely. Above 2^53 the two
    // sides have no spelling in common, so the form stops there rather than pretending otherwise.
    if (!Number.isSafeInteger(value)) {
      throw new NotCanonical(
        `${String(value)} is not a safe integer, and this form compares only integers it can spell the same way twice`,
      );
    }

    // `-0` and `0` are one value here. `String(-0)` is already `'0'` in this language, so this line
    // changes nothing on this side — it is written because the form has to be stated for whoever
    // implements it elsewhere, and the other encoder keeps the sign.
    return String(value === 0 ? 0 : value);
  }

  if (typeof value === 'string') return canonicalString(value);
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(',')}]`;

  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();

    return `{${keys.map((key) => `${canonicalString(key)}:${canonicalText(value[key])}`).join(',')}}`;
  }

  throw new NotCanonical(`a ${typeof value} has no canonical form here`);
}

/** A string in the one spelling both sides write. */
function canonicalString(value) {
  let out = '"';
  for (const character of String(value)) {
    const code = character.codePointAt(0);
    if (character === '"') out += '\\"';
    else if (character === '\\') out += '\\\\';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += character;
  }

  return `${out}"`;
}

/**
 * What one rule declares, as far as agreement goes: which compared properties it states, and to what.
 *
 * Only the properties a rule STATES appear, so an absent one is absent from the material rather than
 * standing in it as a null. The contract treats an absent property and an authored `null` as different
 * documents — omitting one means "whatever the engine defaults to", while `null` means something
 * upstream produced a value it did not have — and it refuses that null for every property but the ones
 * in `NULL_EXEMPT_PROPERTIES`. So of two copies, the one authoring `null` can have its rule refused
 * outright while the other's runs on the engine default. Filling an absent property in with a null
 * would report those two as agreeing.
 *
 * A property whose value is `undefined` counts as absent, which is how the contract reads it too.
 *
 * Nothing is refused here, so the properties whose null the contract exempts stay comparable: a
 * `capture: null` is a legal declaration and is recorded as one. It can therefore differ from an absent
 * `capture` that the engine treats the same way — an over-report, which sends someone to read two
 * documents, where the reverse would tell them two documents agree when the engine refuses one.
 */
function declarationOf(rule) {
  const stated = COMPARED.filter((field) => rule?.[field] !== undefined);

  // Keys are sorted by the canonical form, so the digest turns on which properties are stated and on
  // what they say, never on the order they were typed in.
  return Object.fromEntries(stated.map((field) => [field, rule[field]]));
}

const digestOf = (value) => createHash('sha256').update(canonicalText(value)).digest('hex').slice(0, 32);

/**
 * What a digest here is a digest OF: this material, in the canonical form below.
 *
 * Part of the material, so a digest made under one definition cannot silently equal one made under
 * another. It moves whenever the material or its form does, and the vectors that pin the format are
 * replaced rather than adjusted when it moves.
 */
export const COMPARISON_VERSION = 2;

/**
 * One value standing for a whole rule set AND for the terms it was compared on.
 *
 * The projection is part of the material, not context around it. An undeclared property contributes
 * nothing to any rule's digest, so with the rule digests alone a comparator that stopped comparing such
 * a property would produce the identical set value — and two comparisons made on different terms would
 * report agreement. Most of the compared properties are declared by no rule this package ships, so that
 * is the normal case rather than an edge of it.
 *
 * Both lists are sorted: a set has no order, and two comparators covering the same properties in a
 * different order are comparing the same things. `version` moves when this material changes shape, so a
 * digest made under one definition cannot silently equal one made under another.
 */
export function setDigest({ version, compared, digests }) {
  return digestOf({ version, compared: [...compared].sort(), digests: [...digests].sort() });
}

export function ruleSetDigest(rules = [...DEFAULT_RESPONSE_RULES, ...DEFAULT_EGRESS_RULES]) {
  const entries = rules.map((rule) => {
    const declaration = declarationOf(rule);

    return { id: rule?.id ?? null, declaration, digest: digestOf(declaration) };
  });

  // Sorted, because a set has no order and two corpora listing the same rules differently agree.
  const digests = entries.map((entry) => entry.digest).sort();

  return {
    version: COMPARISON_VERSION,
    count: entries.length,
    compared: [...COMPARED],
    rules: entries.map(({ id, digest }) => ({ id, digest })),
    set: setDigest({ version: COMPARISON_VERSION, compared: COMPARED, digests }),
  };
}

/**
 * Whether this file was RUN rather than imported.
 *
 * Compared as resolved real paths on both sides. A file URL is percent-encoded where a path is not, and
 * either side may be reached through a symlink or a relative spelling — so any comparison of the two as
 * text answers "imported" for invocations that were runs, and the script then exits 0 having printed
 * nothing. For a tool whose entire output is the thing being compared, that is the failure to avoid.
 *
 * A named entry that will not resolve is an import: node ran something else — `-` for stdin, or a path
 * it could not stat — and that something imported this file, since a run of a path node cannot resolve
 * never reaches any module at all. Resolving this file itself is left to throw, because it is loaded and
 * therefore resolvable, and a failure there is a broken assumption rather than an invocation style.
 */
function invokedDirectly() {
  const self = realpathSync(fileURLToPath(import.meta.url));

  try {
    return realpathSync(process.argv[1] ?? '') === self;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const report = ruleSetDigest();
  const canonicalOnly = process.argv.includes('--canonical');

  if (canonicalOnly) {
    // The material itself, one line per rule, because the material is text: printing a re-encoded object
    // would show something adjacent to what was hashed rather than the thing itself, and the difference
    // between those two is exactly what this flag exists to settle.
    for (const rule of [...DEFAULT_RESPONSE_RULES, ...DEFAULT_EGRESS_RULES]) {
      console.log(`${rule.id}\t${canonicalText(declarationOf(rule))}`);
    }
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}
