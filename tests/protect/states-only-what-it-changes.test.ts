import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';
import { derivePlan, permitsAnything } from '../../src/protect/capture-plan.js';
import { DEFAULT_EGRESS_RULES, DEFAULT_RESPONSE_RULES } from '../../src/protect/defaults.js';
import { ACTION_PROPERTIES } from '../../src/protect/rules/contract.js';

/**
 * A shipped policy states only what it changes.
 *
 * Some properties have a value that restates what the engine does anyway. `bypass_limit: false` is the
 * cap already in force; `ensure: false` is the header behaviour already in force; `capture: null`
 * authorises the collection already permitted, which is none. Stating one is not a statement about
 * behaviour — and the engine reads a rule that states it exactly as it reads a rule that does not.
 *
 * The cost is that it is still a difference. Two copies of one policy, one stating a default and one
 * omitting it, are textually different documents that behave identically — so anything comparing the
 * two reports a disagreement that no behaviour follows from, and whoever reads the report goes looking
 * for a difference that is not there. The contract already draws this line for authored nulls, which
 * it refuses outright: absent means "whatever the engine defaults to", and saying it out loud adds
 * nothing to say.
 *
 * So each claim below is proved rather than asserted: the pair of rules is run, and the outcomes are
 * identical. A list of properties someone believed to be defaults would be worth nothing.
 */
const shipped = [...DEFAULT_RESPONSE_RULES, ...DEFAULT_EGRESS_RULES];

/**
 * The engine's own default for each flag `cookie_flags` carries, and the cap it screens a response at.
 *
 * Read from the engine's behaviour, not invented: `hardenCookie` defaults each flag to these, comparing
 * `sameSite` without regard to case, and `responseScreenCap` raises the cap only for a value strictly
 * greater than its default.
 */
const COOKIE_DEFAULTS: Record<string, unknown> = { httpOnly: true, secure: true, sameSite: 'Lax' };
const DEFAULT_SCREEN_CAP = 512 * 1024;

/**
 * The phases in which a property is read at all, or null where it is read wherever it appears.
 *
 * A property stated outside those phases says nothing WHATEVER its value: no code path reads it. That is
 * a different reason from the value being the default, and it applies to values that would otherwise be
 * statements — `max_bytes` above the cap on an egress rule raises no cap, because the cap is computed
 * over the response rules alone.
 *
 * Derived from the contract for the properties an action defaults, since the contract already says which
 * phases each action runs in. The two the response screening cap reads belong to no action, so they are
 * named here with that as the reason.
 */
function phasesThatRead(property: string): string[] | null {
  const fromActions = Object.values(ACTION_PROPERTIES)
    .filter((action: any) => action.defaulted.includes(property))
    .flatMap((action: any) => [...action.phases]);

  if (fromActions.length > 0) return [...new Set(fromActions)];
  // Read by the response screening cap, which is computed over the response rules only.
  if (property === 'bypass_limit' || property === 'max_bytes') return ['response'];

  // `capture` is read through the capture plan, which asks the same question of a rule in any phase.
  return null;
}

/**
 * Whether a stated value says anything the engine does not already do.
 *
 * A PREDICATE, not a list of values. Enumerating them cannot be complete: `cookie_flags` says nothing
 * for any subset of its flags whose members equal their defaults — that is eight objects before casing,
 * and `sameSite` is compared case-insensitively — and `max_bytes` says nothing for every value at or
 * below the cap it would have to exceed to raise it. A list also compares by serialised text, so it
 * answers differently for the same object written in another key order.
 *
 * Each arm is the engine's own condition, read from the code that acts on the property.
 */
function saysNothing(property: string, value: unknown, phase: string): boolean {
  // Nothing reads it in this phase, so nothing follows from any value it could hold.
  const phases = phasesThatRead(property);
  if (phases !== null && !phases.includes(phase)) return true;

  switch (property) {
    // `bypass_limit: true` removes the cap; the engine tests for exactly that, so anything else is the
    // cap already in force.
    case 'bypass_limit':
      return value !== true;
    // `ensure: true` defers to a header already present; the engine tests for exactly that.
    case 'ensure':
      return value !== true;
    // `capture: null` asks for no collection, which is what an absent capture already grants.
    case 'capture':
      return value === null;
    // Every flag stated has to equal its default. An unknown key is a statement — the engine ignores it,
    // but a document carrying one is not a document saying nothing, it is one saying something wrong.
    case 'cookie_flags':
      return (
        value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
        && Object.entries(value as Record<string, unknown>).every(([flag, stated]) => {
          if (!(flag in COOKIE_DEFAULTS)) return false;
          const expected = COOKIE_DEFAULTS[flag];

          // `sameSite` is matched without regard to case, so `lax` and `Lax` are the same statement.
          return typeof expected === 'string' && typeof stated === 'string'
            ? stated.toLowerCase() === expected.toLowerCase()
            : stated === expected;
        })
      );
    // Only a value ABOVE the default raises the cap, so anything at or below it is the cap in force. The
    // property is read on the response phase alone, so it says nothing anywhere else whatever its value.
    case 'max_bytes':
      return Number.isFinite(Number(value)) && Number(value) <= DEFAULT_SCREEN_CAP;
    default:
      return false;
  }
}

/** The properties `saysNothing` has an arm for. Named so completeness can be checked against the contract. */
const PROPERTIES_WITH_A_DEFAULT = ['bypass_limit', 'capture', 'cookie_flags', 'ensure', 'max_bytes'];

/** One value per property that says nothing, for the behavioural pairs below. */
const SAYS_NOTHING: Record<string, unknown> = {
  bypass_limit: false,
  ensure: false,
  capture: null,
  cookie_flags: {},
  max_bytes: DEFAULT_SCREEN_CAP,
};

const SECRET = 'AKIAIOSFODNN7EXAMPLE';

/** A response rule that fires on the sample below, so a change in screening is visible as a change in it. */
const firesOnTheSample = (extra: Record<string, unknown> = {}) => ({
  id: 'probe',
  phase: 'response',
  category: 'secret-exposure',
  action: 'redact',
  prefilter: ['AKIA'],
  rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/AKIA[0-9A-Z]{16}/' } }],
  ...extra,
});

async function screen(
  rule: Record<string, unknown>,
  body: string,
  headers: Record<string, string> = {},
) {
  const fired: string[] = [];
  const p: any = await createProtection({
    rules: { firewall: [], whitelists: [], whitelist_keys: {} },
    mode: 'block',
    responseRules: [rule],
    onDetect: (event: any) => fired.push(String(event.rule?.id)),
  });
  const out = await p.screenResponse(
    new Response(JSON.stringify({ field: body }), {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers },
    }),
    new Request('https://app.test/', { method: 'GET' }),
  );

  return {
    fired: fired.length > 0,
    status: out.status,
    probe: out.headers.get('x-probe'),
    cookie: out.headers.get('set-cookie'),
    body: await out.text(),
  };
}

describe('a shipped policy states only what it changes', () => {
  it('states no property whose value restates the engine default', () => {
    const stated: string[] = [];

    for (const rule of shipped) {
      const phase = (rule as any).phase ?? 'request';

      for (const property of PROPERTIES_WITH_A_DEFAULT) {
        if (!(property in rule)) continue;
        const declared = (rule as Record<string, unknown>)[property];

        if (saysNothing(property, declared, phase)) {
          stated.push(`${rule.id} states ${property} as ${JSON.stringify(declared)}`);
        }
      }
    }

    expect(stated).toEqual([]);
  });

  it('recognises every form of cookie_flags that says nothing', () => {
    // Eight subsets before casing, which is why this is a predicate and not a list. Generated rather
    // than written out, so a flag added to the engine's defaults is covered without anyone extending a
    // table — and a flag stated at something OTHER than its default is a statement, which the second
    // half checks so the predicate cannot be one that simply says yes.
    const flags = Object.keys(COOKIE_DEFAULTS);
    const subsets: Array<Record<string, unknown>> = [];
    for (let mask = 0; mask < 2 ** flags.length; mask++) {
      const subset: Record<string, unknown> = {};
      flags.forEach((flag, index) => {
        if (mask & (1 << index)) subset[flag] = COOKIE_DEFAULTS[flag];
      });
      subsets.push(subset);
    }

    expect(subsets).toHaveLength(8);
    for (const subset of subsets) {
      expect(saysNothing('cookie_flags', subset, 'response'), `${JSON.stringify(subset)} was read as a statement`)
        .toBe(true);
    }

    // Casing, since the engine matches `sameSite` without regard to it.
    expect(saysNothing('cookie_flags', { sameSite: 'lax' }, 'response')).toBe(true);
    expect(saysNothing('cookie_flags', { sameSite: 'LAX' }, 'response')).toBe(true);

    // And things that DO say something.
    for (const stated of [{ httpOnly: false }, { sameSite: 'Strict' }, { secure: false }, { unknown: true }]) {
      expect(saysNothing('cookie_flags', stated, 'response'), `${JSON.stringify(stated)} was read as saying nothing`)
        .toBe(false);
    }
  });

  it('recognises a property stated in a phase that never reads it', () => {
    // A different reason from the value being the default, and it applies to values that WOULD be
    // statements: the response screening cap is computed over the response rules alone, so `max_bytes`
    // above the cap on an egress rule raises nothing, and `bypass_limit: true` there removes nothing.
    //
    // Without this the invariant has a hole exactly the shape of a rule nobody would notice: it states
    // something, the something is inert, and the check reads it as a real statement.
    for (const phase of ['request', 'egress']) {
      expect(saysNothing('max_bytes', 4 * 1024 * 1024, phase), `max_bytes was read in ${phase}`).toBe(true);
      expect(saysNothing('bypass_limit', true, phase), `bypass_limit was read in ${phase}`).toBe(true);
      expect(saysNothing('ensure', true, phase), `ensure was read in ${phase}`).toBe(true);
      expect(saysNothing('cookie_flags', { sameSite: 'Strict' }, phase)).toBe(true);
    }

    // And in the phase that does read them, the same values are statements — or this would hold for a
    // predicate that simply says yes.
    expect(saysNothing('max_bytes', 4 * 1024 * 1024, 'response')).toBe(false);
    expect(saysNothing('bypass_limit', true, 'response')).toBe(false);
    expect(saysNothing('ensure', true, 'response')).toBe(false);
    expect(saysNothing('cookie_flags', { sameSite: 'Strict' }, 'response')).toBe(false);

    // `capture` is the exception: the capture plan asks the same question of a rule in any phase, so it
    // is never inert for want of a reader.
    expect(saysNothing('capture', { version: 1, raw_chars: 64 }, 'egress')).toBe(false);
  });

  it('leaves the response cap alone when an egress rule asks for more', async () => {
    // The behavioural half of the phase rule. The cap is computed over the response rules, so a
    // `max_bytes` on a rule in another phase raises nothing — and the body it would have admitted stays
    // unscreened.
    const overTheCap = `${'x'.repeat(600 * 1024)}${SECRET}`;
    const fired: string[] = [];
    const p: any = await createProtection({
      rules: { firewall: [], whitelists: [], whitelist_keys: {} },
      mode: 'block',
      responseRules: [firesOnTheSample()],
      egressRules: [{
        id: 'egress-asking-for-more',
        phase: 'egress',
        category: 'ssrf',
        action: 'block',
        max_bytes: 4 * 1024 * 1024,
        rule_v2: [{ parameter: 'egress.host', match: { type: 'internal_host' } }],
      }],
      onDetect: (event: any) => fired.push(String(event.rule?.id)),
    });

    const out = await p.screenResponse(
      new Response(JSON.stringify({ field: overTheCap }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      new Request('https://app.test/', { method: 'GET' }),
    );

    // Unscreened, exactly as it would be with no `max_bytes` anywhere: the egress rule's value was
    // never read.
    expect(fired).toEqual([]);
    expect(await out.text()).toContain(SECRET);
  });

  it('recognises every max_bytes that cannot raise the cap', () => {
    // Only a value ABOVE the default raises it, so every value at or below says nothing — which is most
    // of them, and none of which a list would have caught.
    for (const value of [0, 1, 1024, DEFAULT_SCREEN_CAP - 1, DEFAULT_SCREEN_CAP]) {
      expect(saysNothing('max_bytes', value, 'response'), `${value} was read as a statement`).toBe(true);
    }

    for (const value of [DEFAULT_SCREEN_CAP + 1, 2 * DEFAULT_SCREEN_CAP]) {
      expect(saysNothing('max_bytes', value, 'response'), `${value} was read as saying nothing`).toBe(false);
    }
  });

  it('covers every property the contract itself calls defaulted', () => {
    // Derived from the contract rather than listed by hand. The contract names, per action, the
    // properties whose absence it fills in — so those are exactly the ones that can be stated to no
    // effect, and a property added there would otherwise be covered by nothing while this file claimed
    // to be about all of them.
    const defaulted = new Set(
      Object.values(ACTION_PROPERTIES).flatMap((action: any) => [...action.defaulted]),
    );

    for (const property of defaulted) {
      expect(PROPERTIES_WITH_A_DEFAULT, `${property} is defaulted by the contract`).toContain(property);
    }

    // The three extras are rule-level rather than action-level, so the contract does not list them among
    // an action's defaults — and each is proved below rather than asserted here.
    expect([...PROPERTIES_WITH_A_DEFAULT].sort())
      .toEqual(['bypass_limit', 'capture', 'cookie_flags', 'ensure', 'max_bytes']);

    // Every one has an arm. A property named here with no arm would read as saying something whatever
    // it stated, which is the failure that looks like success: the shipped-set case above would pass.
    for (const property of PROPERTIES_WITH_A_DEFAULT) {
      expect(saysNothing(property, SAYS_NOTHING[property], 'response'), `${property} has no arm`).toBe(true);
    }
  });

  it('screens a large body the same whether or not bypass_limit says false', async () => {
    // The cap is what `bypass_limit` moves, so the pair has to be run on a body big enough for the cap
    // to matter. On a small body both screen, and the property would look like a default it is not.
    const overTheCap = `${'x'.repeat(600 * 1024)}${SECRET}`;

    const stated = await screen(firesOnTheSample({ bypass_limit: SAYS_NOTHING.bypass_limit }), overTheCap);
    const silent = await screen(firesOnTheSample(), overTheCap);

    expect(stated).toEqual(silent);
    // And the pair is a real test of the cap: a body this size is passed through unscreened, so the
    // secret survives. `bypass_limit: true` is what changes that, which the case below shows.
    expect(silent.fired).toBe(false);
    expect(silent.body).toContain(SECRET);
  });

  it('screens that same body differently when bypass_limit says true', async () => {
    // The control for the pair above: if `true` behaved like `false`, the equality there would hold
    // for a property the engine ignores entirely, and would prove nothing about `false` being the
    // default.
    const overTheCap = `${'x'.repeat(600 * 1024)}${SECRET}`;

    const raised = await screen(firesOnTheSample({ bypass_limit: true }), overTheCap);

    expect(raised.fired).toBe(true);
    expect(raised.body).not.toContain(SECRET);
  });

  it('sets the same header whether or not ensure says false', async () => {
    // `ensure` decides what happens to a header that is ALREADY there, so the pair has to be run on a
    // response that carries one. With no such header both rules simply set it, and the property would
    // look like a default because nothing consulted it.
    const withHeader = (extra: Record<string, unknown>) =>
      firesOnTheSample({ action: 'set-header', set_headers: { 'x-probe': 'from-the-rule' }, ...extra });
    const alreadySet = { 'x-probe': 'from-the-app' };

    const stated = await screen(withHeader({ ensure: SAYS_NOTHING.ensure }), SECRET, alreadySet);
    const silent = await screen(withHeader({}), SECRET, alreadySet);

    expect(stated).toEqual(silent);
    // And the pair is a real test of it: neither defers to the app's header.
    expect(silent.probe).toBe('from-the-rule');
  });

  it('leaves that header alone when ensure says true', async () => {
    // The control for the pair above: if `true` behaved like `false`, the equality there would hold
    // for a property nothing reads, and would say nothing about `false` being the default.
    const raised = await screen(
      firesOnTheSample({ action: 'set-header', set_headers: { 'x-probe': 'from-the-rule' }, ensure: true }),
      SECRET,
      { 'x-probe': 'from-the-app' },
    );

    expect(raised.probe).toBe('from-the-app');
  });

  it('hardens a cookie the same whether or not cookie_flags says the defaults', async () => {
    // Every flag this property carries has a default, so an empty object, one naming a single flag at
    // its default, and the whole default set spelled out all leave the engine doing what it does with no
    // property at all. Run on a response that actually sets a cookie, since a response without one is
    // hardened identically whatever the flags say — which is how a property nothing read would look
    // like a default.
    const withCookie = (extra: Record<string, unknown>) =>
      firesOnTheSample({ action: 'harden-cookie', ...extra });
    const setsCookie = { 'set-cookie': 'sid=abc; Path=/' };

    const silent = await screen(withCookie({}), SECRET, setsCookie);

    // Every form the predicate calls a non-statement, run for real rather than three chosen by hand.
    const forms: Array<Record<string, unknown>> = [
      {}, { httpOnly: true }, { secure: true }, { sameSite: 'Lax' }, { sameSite: 'lax' },
      { httpOnly: true, secure: true }, { httpOnly: true, secure: true, sameSite: 'Lax' },
    ];

    for (const value of forms) {
      const stated = await screen(withCookie({ cookie_flags: value }), SECRET, setsCookie);

      expect(stated, `cookie_flags: ${JSON.stringify(value)} changed the outcome`).toEqual(silent);
    }

    // And the pair is a real test of it: the defaults are actually applied, so there was something for a
    // restated one to agree with.
    expect(silent.cookie).toContain('HttpOnly');
    expect(silent.cookie).toContain('Secure');
    expect(silent.cookie).toContain('SameSite=Lax');
  });

  it('hardens it differently when cookie_flags says something else', async () => {
    // The control. Without it the equality above would hold for a property the engine ignores entirely,
    // and would say nothing about those values being the defaults.
    const raised = await screen(
      firesOnTheSample({ action: 'harden-cookie', cookie_flags: { httpOnly: false, sameSite: 'Strict' } }),
      SECRET,
      { 'set-cookie': 'sid=abc; Path=/' },
    );

    expect(raised.cookie).not.toContain('HttpOnly');
    expect(raised.cookie).toContain('SameSite=Strict');
  });

  it('screens a body the same whether or not max_bytes states a smaller cap', async () => {
    // Only a value ABOVE the default raises the cap, so a smaller one says nothing — and a body between
    // that value and the default is where saying nothing and lowering the cap look different. Stating the
    // cap itself would prove less: it is the same number either way, so nothing could tell the two apart.
    const withinTheCap = `${'x'.repeat(100 * 1024)}${SECRET}`;

    const stated = await screen(firesOnTheSample({ max_bytes: 1024 }), withinTheCap);
    const silent = await screen(firesOnTheSample(), withinTheCap);

    expect(stated).toEqual(silent);
    // And both screened, so there was something for the pair to agree about: a rule that LOWERED the cap
    // to 1024 would have passed this body through untouched.
    expect(silent.fired).toBe(true);
    expect(silent.body).not.toContain(SECRET);
  });

  it('screens that body when max_bytes raises the cap above it', async () => {
    // The control. Without it the equality above would hold for a property the engine ignores entirely.
    const overTheCap = `${'x'.repeat(600 * 1024)}${SECRET}`;

    const raised = await screen(firesOnTheSample({ max_bytes: 1024 * 1024 }), overTheCap);

    expect(raised.fired).toBe(true);
    expect(raised.body).not.toContain(SECRET);
  });

  it('permits the same collection whether or not capture says null', () => {
    // `capture: null` is the one the contract does NOT refuse, because it authorises collection rather
    // than protection and asks for none — which is what an absent capture already grants.
    const stated = derivePlan(firesOnTheSample({ capture: SAYS_NOTHING.capture }));
    const silent = derivePlan(firesOnTheSample());

    expect(permitsAnything(stated)).toBe(permitsAnything(silent));
    expect(permitsAnything(silent)).toBe(false);
    expect(stated).toEqual(silent);
  });
});
