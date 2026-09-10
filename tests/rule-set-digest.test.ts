import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import {
  COMPARED,
  COMPARISON_VERSION,
  EXCLUDED_FROM_COMPARISON,
  NotCanonical,
  ruleSetDigest,
  setDigest,
} from '../scripts/rule-set-digest.mjs';
import {
  captureProblem,
  NULL_EXEMPT_PROPERTIES,
  NULL_VALUED_PROPERTIES,
  RULE_PROPERTIES,
} from '../src/protect/rules/contract.js';
import { enforceableRuleProblem } from '../src/protect/rules/validate.js';
import { DEFAULT_EGRESS_RULES, DEFAULT_RESPONSE_RULES } from '../src/protect/defaults.js';

/**
 * A digest of the shipped rule set, so agreement with the served copy is mechanical.
 *
 * No digest value of the SHIPPED rule set is asserted here. A snapshot of it would have to be updated
 * every time a rule legitimately changes, and a test that must be edited to keep passing stops
 * describing anything. What is asserted of it is the property: the digest covers exactly the projection
 * the contract licenses, it moves when any part of that projection moves, and it does not move when
 * something outside it does.
 *
 * Fixed values are asserted of a synthetic vector instead, which pins the algorithm without pinning
 * this package's policy — the two obligations are separate, and only one of them changes when a rule
 * does.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shipped = [...DEFAULT_RESPONSE_RULES, ...DEFAULT_EGRESS_RULES];

const COMPARED_FIELDS = COMPARED as readonly string[];

/**
 * A different value for every digested field.
 *
 * One per field, and the completeness case asserts this covers all of them: a table listing some of
 * the projection would establish only that those reach the digest, and a field added later would be
 * exercised by nothing.
 *
 * Every value is one the contract accepts, checked against the contract's own validators below. A
 * fixture the contract would reject exercises the digest with a document that can never be served, so
 * the coverage it reports is of policies nobody can have.
 */
const CHANGED_VALUE: Record<string, unknown> = {
  phase: 'request',
  category: 'info-exposure',
  action: 'block',
  rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'y' } }],
  when: { method: ['POST'] },
  message: 'a different message',
  prefilter: ['ASIA'],
  max_bytes: 4096,
  bypass_limit: true,
  set_headers: { 'x-frame-options': 'DENY' },
  remove_headers: ['x-powered-by'],
  cookie_flags: { secure: true },
  ensure: true,
  capture: { version: 1, raw_chars: 64 },
  // Which map a coordinate belongs to. Compared rather than excluded: two rule sets holding the
  // same coordinates under different scopes differ in what may enforce, which is a policy difference.
  build_scope: 'c'.repeat(64),
};

/**
 * A rule declaring EVERY digested field, for the cases about removing one.
 *
 * Removing a field a rule never declared changes nothing, so a base that declares only some of the
 * projection would pass those cases without establishing anything about the rest.
 */
const fullRule = (extra: Record<string, unknown> = {}) => ({ id: 'r1', title: 'A rule', ...CHANGED_VALUE, ...extra });

const rule = (extra: Record<string, unknown> = {}) => ({
  id: 'r1',
  title: 'A rule',
  phase: 'response',
  category: 'secret-exposure',
  action: 'redact',
  prefilter: ['AKIA'],
  rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'x' } }],
  ...extra,
});

describe('the digest of the shipped rule set', () => {
  it('is built from values that would actually be run', () => {
    // Checked against the validator the runtime itself uses, so a fixture cannot drift into a shape no
    // rule could be served with — which would exercise the digest on documents that do not exist. The
    // property-level checks alone are not enough: they read neither the phase, nor the action
    // vocabulary and its required companions, nor the condition tree, so an invented action passes them.
    const asRule: Record<string, unknown> = fullRule();

    expect(enforceableRuleProblem(asRule)).toBeNull();
    // Separately, because capture governs collection and never protection, so the validator above
    // deliberately does not read it.
    expect(captureProblem(asRule.capture)).toBeNull();
  });

  describe('the canonical form, as an interoperability format', () => {
    /**
     * A rule chosen to exercise what a second implementation gets wrong: nested key ordering, array
     * order, a `/` and a `\` inside an operand, non-ASCII text, control characters, an EMPTY OBJECT, an
     * integer, a boolean, an authored null, and absence.
     *
     * The empty object and the number are here because they were the gap. Each language's own JSON
     * encoder agreed on the rules this package ships and disagreed on these: an empty object is
     * indistinguishable from an empty array to a PHP associative decode, and the two encoders write
     * numbers differently.
     */
    const VECTOR = {
      id: 'kat',
      title: 'excluded from the comparison',
      phase: 'response',
      category: 'secret-exposure',
      action: 'redact',
      message: 'Ärger: 90% — “quoted” / and \\ done\nsecond line\ttabbed',
      prefilter: ['b', 'a'],
      rule_v2: [
        { parameter: 'response.body', match: { type: 'regex', value: '/x\\/y/i' } },
        { parameter: 'response.body', match: { type: 'contains', value: 'z' } },
      ],
      // Numeric-looking keys, which are valid header names and which two languages sort differently
      // unless the form says how: one orders them as text, the other as numbers.
      set_headers: { 'x-b': '2', 'x-a': '1', 10: 'ten', 2: 'two' },
      cookie_flags: {},
      max_bytes: 4096,
      bypass_limit: true,
      capture: null,
      // Absent on purpose: when, remove_headers, ensure.
    };

    /**
     * The canonical TEXT of that rule, written out rather than obtained from the code.
     *
     * This is the second, independent statement of the format, and it is the whole agreement in one
     * string: keys sorted at every depth, arrays left in the order they were written, the excluded
     * properties gone, the stated null kept, absent properties simply not here, an empty object as `{}`,
     * an integer in plain decimal, and only `"`, `\` and the characters below a space escaped — the last
     * as `\u00xx`, not as the short forms, because those would be a second spelling to agree on.
     *
     * The keys `10` and `2` are here because key ORDER is where two languages quietly disagree: one
     * sorts keys as text and the other treats a numeric-looking key as a number, so `10` lands either
     * side of `2` depending on which. As text is what this form says, and this is where it is held to
     * that.
     *
     * If the script's form changes, this literal still hashes to the old value and the case fails.
     */
    const CANONICAL =
      '{"action":"redact",'
      + '"bypass_limit":true,'
      + '"capture":null,'
      + '"category":"secret-exposure",'
      + '"cookie_flags":{},'
      + '"max_bytes":4096,'
      + '"message":"Ärger: 90% — “quoted” / and \\\\ done\\u000asecond line\\u0009tabbed",'
      + '"phase":"response",'
      + '"prefilter":["b","a"],'
      + '"rule_v2":[{"match":{"type":"regex","value":"/x\\\\/y/i"},"parameter":"response.body"},'
      + '{"match":{"type":"contains","value":"z"},"parameter":"response.body"}],'
      + '"set_headers":{"10":"ten","2":"two","x-a":"1","x-b":"2"}}';

    const sha256Head = (text: string) =>
      createHash('sha256').update(text).digest('hex').slice(0, 32);

    it('is a rule that would actually be run', () => {
      // A vector no guard would accept pins the format against documents that cannot exist.
      expect(enforceableRuleProblem(VECTOR)).toBeNull();
      expect(captureProblem(VECTOR.capture)).toBeNull();
    });

    it('digests that rule to a fixed value', () => {
      // Every other case here is relational, and relational properties survive a changed hash, a
      // changed truncation and a changed serialisation. A second implementation has to produce this, so
      // it is pinned twice over: against the form written out above, and against the bytes themselves.
      expect(ruleSetDigest([VECTOR]).rules[0].digest).toBe(sha256Head(CANONICAL));
      expect(sha256Head(CANONICAL)).toBe('c2a4e474866d1cbe69b212143d2a6a62');
    });

    it('sorts numeric-looking keys as text', () => {
      // Where the two languages disagree without being told. One sorts keys as text; the other sees a
      // numeric-looking key as a number and puts `2` before `10`. Asserted on the material rather than
      // only through the vector, so the rule is stated where somebody implementing it will look.
      const digest = ruleSetDigest([{ phase: 'response', set_headers: { 10: 'ten', 2: 'two' } }]).rules[0].digest;
      const asText = createHash('sha256')
        .update('{"phase":"response","set_headers":{"10":"ten","2":"two"}}')
        .digest('hex')
        .slice(0, 32);

      expect(digest).toBe(asText);
    });

    it('tells an empty object from an empty array', () => {
      // The gap version 1 had. To a PHP associative decode these are one value, so a form that leaves
      // them alike lets two different documents digest the same on one side and differently on the
      // other — and `cookie_flags: {}` is a rule somebody may really write.
      const asObject = { phase: 'response', cookie_flags: {} };
      const asArray = { phase: 'response', cookie_flags: [] };

      expect(ruleSetDigest([asObject]).rules[0].digest)
        .not.toBe(ruleSetDigest([asArray as any]).rules[0].digest);
    });

    it('refuses a number it cannot write the same way twice', () => {
      // The shortest text that reads back as a given float is a property of each language's formatter,
      // so this form compares only integers and refuses the rest. Refused, not approximated: a digest
      // is worth comparing only if the other side would produce the same one, and a value written
      // differently there would report drift between documents that agree.
      //
      // `1e21` is the one worth naming. It IS an integer to this language, and it writes itself in
      // exponent form while an implementation holding it as an integer writes the digits — and one
      // converting it to a 64-bit integer gets a different number altogether. So the bound is the safe
      // range, not integrality.
      for (const number of [1e-7, 0.5, -0.5, Infinity, -Infinity, NaN, 1e21, Number.MAX_SAFE_INTEGER + 2]) {
        expect(
          () => ruleSetDigest([{ phase: 'response', max_bytes: number } as any]),
          `${String(number)} was digested`,
        ).toThrow(NotCanonical);
      }

      // And the edge itself is inside, written as digits.
      expect(ruleSetDigest([{ phase: 'response', max_bytes: Number.MAX_SAFE_INTEGER } as any]).rules[0].digest)
        .toBeTypeOf('string');
    });

    it('treats negative zero as zero', () => {
      // One encoder keeps the sign and the other drops it, so the form has to say which. This language
      // drops it already — `String(-0)` is `'0'` — so this case holds here whether or not the script
      // says so, and removing that line does not break it. It is the other implementation that needs
      // the rule, and this is the statement of it that both can be held to.
      expect(ruleSetDigest([{ phase: 'response', max_bytes: -0 } as any]).rules[0].digest)
        .toBe(ruleSetDigest([{ phase: 'response', max_bytes: 0 } as any]).rules[0].digest);
    });

    it('aggregates a fixed set of digests to a fixed value', () => {
      // Independent of the live projection, so a property added to the contract does not send anyone
      // editing a pinned value: what is fixed here is the algorithm, not this package's rule set.
      const material = '{"compared":["action","phase"],"digests":["aaa","bbb"],"version":2}';

      expect(setDigest({ version: 2, compared: ['action', 'phase'], digests: ['bbb', 'aaa'] }))
        .toBe(sha256Head(material));
      expect(sha256Head(material)).toBe('ecd843ffe3a5c9ac50de0d2553cdf71c');
    });

    it('is the version this script reports', () => {
      // The vectors above describe version 2. If the material or its form changes, the version moves
      // with it and these have to be replaced rather than adjusted.
      expect(COMPARISON_VERSION).toBe(2);
    });
  });

  it('covers every shipped rule', () => {
    const report = ruleSetDigest();

    expect(report.count).toBe(shipped.length);
    expect(report.rules.map((entry: any) => entry.id)).toEqual(shipped.map((r: any) => r.id));
  });

  it('gives every shipped rule a distinct digest', () => {
    // Two rules digesting the same would make one of them invisible to a comparison: the set would
    // still match after one was changed into the other.
    const digests = ruleSetDigest().rules.map((entry: any) => entry.digest);

    expect(new Set(digests).size).toBe(digests.length);
  });

  it('moves when any compared field moves', () => {
    // Field by field, because a digest covering most of them reports agreement on the rest. Every
    // digested field appears here, and the completeness case below is what keeps that true.
    const base = ruleSetDigest([rule()]).set;

    for (const [field, value] of Object.entries(CHANGED_VALUE)) {
      expect(ruleSetDigest([rule({ [field]: value })]).set, `${field} does not reach the digest`)
        .not.toBe(base);
    }
  });

  it('exercises every digested field', () => {
    // Otherwise the case above proves only that the fields it happens to name reach the digest, and a
    // field added to the projection would be covered by nothing.
    expect(Object.keys(CHANGED_VALUE).sort()).toEqual([...COMPARED_FIELDS].sort());
  });

  it('moves when a compared field is removed', () => {
    // An absent field is a value, not a reason to leave the field out of the projection.
    const base = ruleSetDigest([fullRule()]).set;

    for (const field of COMPARED_FIELDS) {
      const without: Record<string, unknown> = fullRule();
      delete without[field];

      expect(ruleSetDigest([without as any]).set, `a missing ${field} agrees with a declared one`)
        .not.toBe(base);
    }
  });

  it('does not let a rule declaring nothing agree with a rule declaring a value', () => {
    // Absence must not equal a declaration. Stated as its own case because the removal case above
    // cannot establish it: that one deletes a field whose value was something else, so a projection
    // quietly substituting a default still differs. Only the pair where the substituted default IS the
    // other rule's value distinguishes them.
    for (const [field, value] of Object.entries(CHANGED_VALUE)) {
      const declared: Record<string, unknown> = fullRule({ [field]: value });
      const silent: Record<string, unknown> = fullRule();
      delete silent[field];

      expect(
        ruleSetDigest([silent as any]).set,
        `a rule declaring no ${field} agrees with one declaring ${JSON.stringify(value)}`,
      ).not.toBe(ruleSetDigest([declared as any]).set);
    }
  });

  it('moves the set digest when the projection changes, including for a property no rule declares', () => {
    // The whole point of a set value is that one comparison of it answers the question. A property no
    // rule declares contributes nothing to any rule's digest, so without the projection in the material
    // a comparator that stopped comparing that property would emit the identical set value — and two
    // comparisons made on different terms would report agreement.
    const report = ruleSetDigest();
    const digests = report.rules.map((entry) => entry.digest);

    // Derived, not named: whichever compared properties this package's own rules happen not to declare.
    const undeclared = COMPARED_FIELDS.filter((field) => shipped.every((rule: any) => rule[field] === undefined));

    expect(undeclared.length).toBeGreaterThan(0);
    for (const field of undeclared) {
      expect(
        setDigest({ version: COMPARISON_VERSION, compared: COMPARED_FIELDS.filter((f) => f !== field), digests }),
        `dropping ${field} from the projection leaves the set digest unchanged`,
      ).not.toBe(report.set);
    }
  });

  it('moves the set digest when the comparison version moves', () => {
    // A digest made under one definition of the material must not equal one made under another.
    const report = ruleSetDigest();
    const digests = report.rules.map((entry) => entry.digest);

    expect(setDigest({ version: COMPARISON_VERSION + 1, compared: COMPARED_FIELDS, digests })).not.toBe(report.set);
  });

  it('does not move the set digest when the projection is merely reordered', () => {
    // Two comparators covering the same properties are comparing the same things, whatever order the
    // contract happens to list them in.
    const report = ruleSetDigest();
    const digests = report.rules.map((entry) => entry.digest);

    expect(
      setDigest({ version: COMPARISON_VERSION, compared: [...COMPARED_FIELDS].reverse(), digests }),
    ).toBe(report.set);
  });

  it('compares every contract property that is not explicitly excluded', () => {
    // The projection is derived from the contract rather than listed here, so a property added there is
    // digested by default. This is the check that keeps the two aligned: a new property must be either
    // digested or given a reason for being left out, and until someone decides which, this fails.
    const classified = [...COMPARED_FIELDS, ...Object.keys(EXCLUDED_FROM_COMPARISON)].sort();

    expect(classified).toEqual([...RULE_PROPERTIES].sort());
  });

  it('gives a reason for every exclusion', () => {
    // An exclusion without a reason is indistinguishable from an oversight, and the reason is what a
    // later reader needs in order to disagree with it.
    for (const [field, reason] of Object.entries(EXCLUDED_FROM_COMPARISON)) {
      expect(typeof reason, `${field} has no reason`).toBe('string');
      expect((reason as string).length, `${field}'s reason says nothing`).toBeGreaterThan(20);
    }
  });

  it('moves when any excluded field is not the reason it was excluded', () => {
    // The excluded set has to stay small enough to name. Asserted as a count so widening it is a
    // deliberate edit here rather than a quiet loss of coverage.
    expect(Object.keys(EXCLUDED_FROM_COMPARISON)).toEqual(['id', 'rule_id', 'title', 'source_revision', 'enforcement']);
  });

  it('tells an absent property from one authored as null', () => {
    // The contract refuses a present null for every property but the exempt ones, so of two copies the
    // one authoring `null` can have its rule refused outright while the other's runs on the engine
    // default. Reporting those as equal would report agreement between a rule that runs and one that
    // does not. The premise is the contract's, so if it ever stops refusing null this has to be revisited.
    expect(NULL_VALUED_PROPERTIES).toBe('refused');

    for (const field of COMPARED_FIELDS) {
      const absent = { ...fullRule() };
      delete (absent as Record<string, unknown>)[field];
      const authoredNull = { ...absent, [field]: null };

      expect(ruleSetDigest([authoredNull as any]).set).not.toBe(ruleSetDigest([absent as any]).set);
      // And neither is confused with a stated value.
      expect(ruleSetDigest([authoredNull as any]).set).not.toBe(ruleSetDigest([fullRule()]).set);
    }
  });

  it('records an exempt null as the declaration it is', () => {
    // `capture: null` is legal and means "collect nothing", which is also what an absent `capture`
    // gets. Recording it distinctly can therefore send someone to compare two documents the engine
    // treats alike. That is the tolerable direction: the alternative reports agreement between a
    // document that is accepted and one that is refused.
    expect(NULL_EXEMPT_PROPERTIES).toContain('capture');

    const absent = { ...fullRule() };
    delete (absent as Record<string, unknown>).capture;

    expect(ruleSetDigest([{ ...absent, capture: null } as any]).set).not.toBe(ruleSetDigest([absent as any]).set);
  });

  it('does not move for the id or the title', () => {
    // Both legitimately differ between the two copies — a served document is titled for a human reading
    // a dashboard — so digesting them would report drift on every rename while staying silent on a
    // changed pattern.
    const base = ruleSetDigest([rule()]).set;

    expect(ruleSetDigest([rule({ id: 'a-different-id' })]).set).toBe(base);
    expect(ruleSetDigest([rule({ title: 'A different title' })]).set).toBe(base);
  });

  it('does not move for the order rules are listed in', () => {
    // A set has no order, and two copies listing the same rules differently agree.
    const a = rule({ id: 'a', rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'a' } }] });
    const b = rule({ id: 'b', rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'b' } }] });

    expect(ruleSetDigest([a, b]).set).toBe(ruleSetDigest([b, a]).set);
  });

  it('does not move for the order keys are written in', () => {
    // The same rule typed in a different order is the same rule. Without this, two copies could
    // disagree over nothing but formatting.
    const reordered = {
      rule_v2: [{ match: { value: 'x', type: 'contains' }, parameter: 'response.body' }],
      prefilter: ['AKIA'],
      action: 'redact',
      category: 'secret-exposure',
      phase: 'response',
      title: 'A rule',
      id: 'r1',
    };

    expect(ruleSetDigest([reordered as any]).set).toBe(ruleSetDigest([rule()]).set);
  });

  it('moves when clauses are reordered', () => {
    // Arrays keep their order, unlike keys: `rule_v2` is a sequence, and reordering it can change what a
    // rule does or what it costs to evaluate.
    const clauses = [
      { parameter: 'response.body', match: { type: 'contains', value: 'a' } },
      { parameter: 'response.body', match: { type: 'regex', value: '/b/' } },
    ];

    expect(ruleSetDigest([rule({ rule_v2: clauses })]).set)
      .not.toBe(ruleSetDigest([rule({ rule_v2: [...clauses].reverse() })]).set);
  });

  it('prints its report when run as a command', () => {
    // Running it is how the comparison is made, so a run has to produce the report. A run that decides
    // it was an import exits 0 having printed nothing, which for a tool whose entire output is the
    // thing being compared reads as agreement.
    const out = execFileSync('node', [join(root, 'scripts/rule-set-digest.mjs')], { encoding: 'utf8' });
    const report = JSON.parse(out);

    expect(report.set).toBe(ruleSetDigest().set);
    expect(report.count).toBe(shipped.length);
  });

  it('prints its report when run through a symlink', () => {
    // A run is a run however the file was named. Compared as text, a link's path is not the target's
    // and the script decides it was imported — exiting 0 with no output, which for this tool reads as
    // agreement between the copies rather than as a failure to look.
    const link = join(mkdtempSync(join(tmpdir(), 'rule-set-digest-')), 'linked.mjs');
    symlinkSync(join(root, 'scripts/rule-set-digest.mjs'), link);

    const out = execFileSync('node', [link], { encoding: 'utf8' });

    expect(JSON.parse(out).set).toBe(ruleSetDigest().set);
  });

  it('can be imported without being run', () => {
    // Importing it is how these tests use it, and an import names no script. Resolving a path that was
    // never given would throw, which would make the module unimportable — so the absent case is
    // answered before anything is resolved.
    const out = execFileSync(
      'node',
      ['--input-type=module', '-e', `import('${pathToFileURL(join(root, 'scripts/rule-set-digest.mjs')).href}')
         .then((m) => console.log(JSON.stringify({ imported: typeof m.ruleSetDigest })))`],
      { encoding: 'utf8' },
    );

    // Loaded, and it printed nothing of its own: the report belongs to a run.
    expect(JSON.parse(out.trim())).toEqual({ imported: 'function' });
  });

  it('can be imported by a script node read from stdin', () => {
    // `node --input-type=module -` names its entry `-`, which resolves to nothing. Treating an entry
    // that will not resolve as anything but an import makes the module unimportable that way: a run of
    // a path node cannot resolve never reaches this file, so `-` is always something else importing it.
    const out = execFileSync(
      'node',
      ['--input-type=module', '-'],
      {
        encoding: 'utf8',
        input: `import { ruleSetDigest } from '${pathToFileURL(join(root, 'scripts/rule-set-digest.mjs')).href}';
                console.log(JSON.stringify({ set: ruleSetDigest().set }));`,
      },
    );

    expect(JSON.parse(out.trim()).set).toBe(ruleSetDigest().set);
  });

  it('prints what it digested, for reading when two copies disagree', () => {
    // A digest says "these differ" and nothing else. Whoever has to fix it needs the material — and the
    // material is TEXT, so this prints that text rather than an object re-encoded from it. Printing the
    // object would show something adjacent to what was hashed, which is the difference this exists to
    // settle.
    const out = execFileSync('node', [join(root, 'scripts/rule-set-digest.mjs'), '--canonical'], {
      encoding: 'utf8',
    });
    const lines = out.trimEnd().split('\n');

    expect(lines).toHaveLength(shipped.length);
    for (const line of lines) {
      const [id, material] = line.split('\t');

      expect(shipped.map((rule: any) => rule.id)).toContain(id);
      // The material hashes to the digest the report gives for that rule, which is what makes this the
      // material and not a description of it.
      const digest = createHash('sha256').update(material).digest('hex').slice(0, 32);

      expect(digest).toBe(ruleSetDigest().rules.find((entry: any) => entry.id === id)!.digest);
      // Only compared properties appear, and an unstated one is absent rather than present as a null.
      const stated = Object.keys(JSON.parse(material));

      expect(stated.length).toBeGreaterThan(0);
      expect(stated.every((field) => COMPARED_FIELDS.includes(field))).toBe(true);
    }
  });
});
