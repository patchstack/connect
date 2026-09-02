import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';
// @ts-expect-error -- plain ESM runtime module
import { hardensWithoutBody } from '../../src/protect/response-hardening.js';
// @ts-expect-error -- plain ESM runtime module
import { readRuleParameters } from '../../src/protect/rule-parameters.js';
// @ts-expect-error -- plain ESM runtime module
import { LIMITS } from '../../src/protect/rules/contract.js';

/**
 * Header hardening on a response the guard could not screen.
 *
 * The screening cap exists because buffering a hostile body costs memory. A header does not become
 * expensive because the body beside it is large, so hardening applies to a response whose body was never
 * read: over the cap, binary, a live stream, a failed read.
 *
 * The case that carries the most weight is the cookie. A `harden-cookie` rule and an image response that
 * also sets a session cookie is a response nobody thinks of as carrying one, and the cookie still has to
 * go out with `HttpOnly` and `Secure`.
 */

const emptyBundle = { firewall: [], whitelists: [], whitelist_keys: {} };
/** Matches every response, and reads nothing but the status. */
const anyResponse = [{ parameter: 'response.status', match: { type: 'isset' } }];

const setFrameOptions = {
  phase: 'response',
  action: 'set-header',
  ensure: true,
  set_headers: { 'x-frame-options': 'DENY' },
  rule_v2: anyResponse,
};

const guard = (rule: unknown, mode = 'block') =>
  createProtection({ rules: emptyBundle, responseRules: [rule], mode }) as Promise<any>;

/** The four ways a response reaches the guard without a readable body. */
const unscreenable = {
  'a body over the cap': () =>
    new Response('x'.repeat(2 * 1024 * 1024), { headers: { 'content-type': 'application/json' } }),
  'a binary body': () =>
    new Response(new Uint8Array([0, 1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
  'a live stream': () =>
    new Response('data: hello\n\n', { headers: { 'content-type': 'text/event-stream' } }),
  'a declared length over the cap': () =>
    new Response('{}', {
      headers: { 'content-type': 'application/json', 'content-length': String(50 * 1024 * 1024) },
    }),
};

describe('a response the guard could not screen', () => {
  it.each(Object.entries(unscreenable))('is still hardened: %s', async (_label, make) => {
    const p = await guard(setFrameOptions);
    const out = await p.screenResponse(make());

    expect(out.headers.get('x-frame-options')).toBe('DENY');
  });

  it('keeps the body it was never able to read', async () => {
    // The point of not screening is that the body is not touched. Hardening must add a header and hand
    // the same bytes on, not read the body to rebuild it — that would defeat the cap that sent it here.
    const p = await guard(setFrameOptions);
    const out = await p.screenResponse(
      new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'image/png' } }),
    );

    expect(out.headers.get('x-frame-options')).toBe('DENY');
    expect(new Uint8Array(await out.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('hardens a cookie on a response that carries no readable body', async () => {
    // The case that matters most: the cookie is in the headers, and the body being an image has nothing
    // to do with whether it should be `HttpOnly`.
    const p = await guard({
      phase: 'response',
      action: 'harden-cookie',
      cookie_flags: { httpOnly: true, secure: true, sameSite: 'Lax' },
      rule_v2: anyResponse,
    });
    const out = await p.screenResponse(
      new Response(new Uint8Array([1]), {
        headers: { 'content-type': 'image/png', 'set-cookie': 'sid=abc; Path=/' },
      }),
    );

    expect(out.headers.get('set-cookie')).toContain('HttpOnly');
    expect(out.headers.get('set-cookie')).toContain('Secure');
  });

  it('strips a header it was told to strip', async () => {
    const p = await guard({
      phase: 'response',
      action: 'remove-header',
      remove_headers: ['access-control-allow-origin'],
      rule_v2: anyResponse,
    });
    const out = await p.screenResponse(
      new Response(new Uint8Array([1]), {
        headers: { 'content-type': 'image/png', 'access-control-allow-origin': '*' },
      }),
    );

    expect(out.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('what it still will not do without a body', () => {
  it('leaves a rule that reads the body alone, rather than deciding it on an empty one', async () => {
    // `not_contains` is why this is a whitelist rather than a best effort: against a body that was never
    // read it matches everything, so a rule keyed that way would fire on every unscreenable response. The
    // body it asks about is unknown, so it does not apply.
    const p = await guard({
      phase: 'response',
      action: 'set-header',
      set_headers: { 'x-should-not-appear': 'yes' },
      rule_v2: [{ parameter: 'response.body', match: { type: 'not_contains', value: 'a-string-not-present' } }],
    });

    const unscreened = await p.screenResponse(
      new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }),
    );
    expect(unscreened.headers.get('x-should-not-appear')).toBeNull();

    // And on a body it CAN read, the same rule applies normally — so this is about the reading, not
    // about the rule being unwelcome.
    const screened = await p.screenResponse(new Response('{}', { headers: { 'content-type': 'application/json' } }));
    expect(screened.headers.get('x-should-not-appear')).toBe('yes');
  });

  it('does not redact or withhold on a body it never read', async () => {
    // Only header actions are eligible. A rule that masks a span has nothing to mask here, and one that
    // withholds the response would turn a body the guard chose not to screen into a blocked request.
    const p = await guard({
      phase: 'response',
      category: 'secret',
      action: 'redact',
      rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'sk_live_' } }],
    });
    const out = await p.screenResponse(
      new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }),
    );

    expect(out.status).toBe(200);
  });

  it('observes a dry-run rule instead of hardening', async () => {
    // "Detect until justified" holds here too: a hardening rule in dry-run must not rewrite headers on
    // the no-body path either, or the cap becomes a way to get enforcement a rule was not granted.
    const p = await guard(setFrameOptions, 'dry-run');
    const out = await p.screenResponse(
      new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }),
    );

    expect(out.headers.get('x-frame-options')).toBeNull();
  });

  it('passes through something that is not a response at all', async () => {
    const p = await guard(setFrameOptions);

    await expect(p.screenResponse(undefined)).resolves.toBeUndefined();
  });
});

describe('a rule that matched but changed nothing', () => {
  const original = () =>
    new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'image/png', 'content-length': '3', 'x-frame-options': 'DENY' },
    });

  it.each([
    [
      'harden-cookie with no cookie to harden',
      { phase: 'response', action: 'harden-cookie', cookie_flags: { httpOnly: true }, rule_v2: anyResponse },
    ],
    [
      'remove-header for a header that is not there',
      { phase: 'response', action: 'remove-header', remove_headers: ['x-absent'], rule_v2: anyResponse },
    ],
    [
      'ensure where the header already exists',
      { phase: 'response', action: 'set-header', ensure: true, set_headers: { 'x-frame-options': 'SAMEORIGIN' }, rule_v2: anyResponse },
    ],
  ])('hands back the response it was given: %s', async (_label, rule) => {
    const p = await guard(rule);
    const input = original();
    const out = await p.screenResponse(input);

    // The same object, not an equivalent one: rebuilding drops `Content-Length` and loses `url`,
    // `redirected` and `type`, on a stream or binary body the guard chose not to touch.
    expect(out).toBe(input);
    expect(out.headers.get('content-length')).toBe('3');
  });

  it('sets a header a rule deliberately empties', async () => {
    // Presence and value are separate questions. A header that was absent and is now set is a change
    // whatever it is set to — including the empty string, which is a rule doing something. Folding
    // absence into `''` discards exactly that rule.
    const p = await guard({
      phase: 'response',
      action: 'set-header',
      set_headers: { 'x-example': '' },
      rule_v2: anyResponse,
    });
    const input = new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } });

    const out = await p.screenResponse(input);

    expect(out).not.toBe(input);
    expect(out.headers.get('x-example')).toBe('');
  });

  it.each(['', 'undefined', 'null', '0'])('sets an absent header to %o, whatever it stringifies to', async (value) => {
    // Presence is asked before value, not derived from it. Comparing an absent header by stringifying it
    // makes it equal to a real header whose value happens to be that string, and the mutation is then
    // dropped for the one value that collides.
    const p = await guard({
      phase: 'response',
      action: 'set-header',
      set_headers: { 'x-example': value },
      rule_v2: anyResponse,
    });
    const input = new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } });

    const out = await p.screenResponse(input);

    expect(out).not.toBe(input);
    expect(out.headers.get('x-example')).toBe(value);
  });

  it('leaves a header that is already the empty value it would be set to', async () => {
    // The other side of the same distinction: present and equal is not a change, however empty.
    const p = await guard({
      phase: 'response',
      action: 'set-header',
      set_headers: { 'x-example': '' },
      rule_v2: anyResponse,
    });
    const input = new Response(new Uint8Array([1]), {
      headers: { 'content-type': 'image/png', 'x-example': '' },
    });

    const out = await p.screenResponse(input);

    expect(out).toBe(input);
  });

  it('still rebuilds when a header really changes', async () => {
    // The control, so the check above cannot be satisfied by never hardening anything.
    const p = await guard({
      phase: 'response',
      action: 'set-header',
      set_headers: { 'x-frame-options': 'SAMEORIGIN' },
      rule_v2: anyResponse,
    });
    const input = original();
    const out = await p.screenResponse(input);

    expect(out).not.toBe(input);
    expect(out.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  it('counts hardening one cookie among several as a change', async () => {
    const p = await guard({
      phase: 'response',
      action: 'harden-cookie',
      cookie_flags: { httpOnly: true },
      rule_v2: anyResponse,
    });
    const headers = new Headers({ 'content-type': 'image/png' });
    headers.append('set-cookie', 'a=1; HttpOnly');
    headers.append('set-cookie', 'b=2');
    const input = new Response(new Uint8Array([1]), { headers });

    const out = await p.screenResponse(input);

    expect(out).not.toBe(input);
    expect(out.headers.getSetCookie().join(' | ')).toContain('b=2; HttpOnly');
  });
});

describe('the assumption the filter does not rely on', () => {
  it.each([
    ['not_contains', { type: 'not_contains', value: 'a-string-not-present' }],
    ['isset', { type: 'isset' }],
    ['equals the empty string', { type: 'equals', value: '' }],
  ])('an absent body does not match %s', async (_label, match) => {
    // The engine reads an unread body as ABSENT, so a body rule cannot match on the no-body path even
    // without the eligibility filter. That is a property of the resolver rather than a stated guarantee,
    // which is why the filter does not lean on it: were `isset` on an empty string to change, or a new
    // match type to treat absence as a match, body rules would begin firing on responses nobody read.
    //
    // Asserted through the engine rather than the filter, so it fails on a change to the engine.
    const detections: unknown[] = [];
    const p = (await createProtection({
      rules: emptyBundle,
      mode: 'block',
      responseRules: [
        { phase: 'response', action: 'set-header', set_headers: { 'x-fired': 'yes' }, rule_v2: [{ parameter: 'response.body', match }] },
      ],
      onDetect: (d: unknown) => detections.push(d),
    })) as any;

    const out = await p.screenResponse(new Response('', { headers: { 'content-type': 'application/json' } }));

    expect(out.headers.get('x-fired')).toBeNull();
    expect(detections).toHaveLength(0);
  });
});

describe('which rules qualify', () => {
  it.each([
    ['status only', { action: 'set-header', rule_v2: anyResponse }, true],
    ['a response header', { action: 'remove-header', rule_v2: [{ parameter: 'response.header.x', match: { type: 'isset' } }] }, true],
    ['all response headers', { action: 'harden-cookie', rule_v2: [{ parameter: 'response.headers', match: { type: 'isset' } }] }, true],
    ['a parameterless origin match', { action: 'set-header', rule_v2: [{ match: { type: 'cors_reflected' } }] }, true],
    ['the response body', { action: 'set-header', rule_v2: [{ parameter: 'response.body', match: { type: 'isset' } }] }, false],
    ['a list including the body', { action: 'set-header', rule_v2: [{ parameter: ['response.status', 'response.body'], match: { type: 'isset' } }] }, false],
    ['the raw source', { action: 'set-header', rule_v2: [{ parameter: 'raw', match: { type: 'isset' } }] }, false],
    ['a redacting action', { action: 'redact', rule_v2: anyResponse }, false],
    ['a blocking action', { action: 'block', rule_v2: anyResponse }, false],
  ])('%s: %o', (_label, rule, expected) => {
    expect(hardensWithoutBody(rule)).toBe(expected);
  });

  it('is ineligible when the walk could not see the whole rule', () => {
    // `responseRules` are not checked against the contract, so a rule nested past its bound is reachable
    // here. The walk stops at the bound, and a list missing a body condition looks exactly like a rule
    // that reads no body.
    //
    // The shape that matters: a header-only condition at the top and a body condition below the bound.
    // Judged on the visible half alone this is header-only.
    let deep: Record<string, unknown> = {
      parameter: 'response.body',
      match: { type: 'contains', value: 'secret' },
    };
    for (let i = 0; i < LIMITS.maxNestingDepth + 2; i++) {
      deep = { parameter: 'rules', rules: [deep] };
    }

    const rule = {
      action: 'set-header',
      set_headers: { 'x-frame-options': 'DENY' },
      rule_v2: [{ parameter: 'response.status', match: { type: 'isset' } }, deep],
    };

    // The walk itself reports what it could not see.
    expect(readRuleParameters(rule).complete).toBe(false);
    expect(readRuleParameters(rule).parameters).not.toContain('response.body');
    // And eligibility refuses an incomplete answer rather than reading it as an empty one.
    expect(hardensWithoutBody(rule)).toBe(false);
  });

  it('is eligible when the same shape stays inside the bound', () => {
    // The control: nesting is not itself disqualifying, and a deep header-only rule still qualifies.
    let deep: Record<string, unknown> = {
      parameter: 'response.header.x-test',
      match: { type: 'isset' },
    };
    for (let i = 0; i < LIMITS.maxNestingDepth - 2; i++) {
      deep = { parameter: 'rules', rules: [deep] };
    }

    const rule = { action: 'set-header', set_headers: { 'x-frame-options': 'DENY' }, rule_v2: [deep] };

    expect(readRuleParameters(rule).complete).toBe(true);
    expect(hardensWithoutBody(rule)).toBe(true);
  });

  it('stops where the contract says a rule ends', () => {
    // The bound is the contract's, not a second copy: a walk that stopped later would accept a rule
    // validation rejects, and one that stopped earlier would call a valid rule incomplete.
    let deep: Record<string, unknown> = { parameter: 'get.q', match: { type: 'isset' } };
    for (let i = 0; i < LIMITS.maxNestingDepth; i++) deep = { parameter: 'rules', rules: [deep] };

    expect(readRuleParameters({ rule_v2: [deep] }).complete).toBe(true);

    expect(readRuleParameters({ rule_v2: [{ parameter: 'rules', rules: [deep] }] }).complete).toBe(false);
  });

  it('is not fooled by a body parameter written as a list', () => {
    // The list form is why the two parameter walkers had to become one. Reading only the string form,
    // this rule looks like it reads nothing — and would then be applied on a body nobody read.
    expect(
      hardensWithoutBody({
        action: 'set-header',
        rule_v2: [{ parameter: ['response.body'], match: { type: 'contains', value: 'x' } }],
      }),
    ).toBe(false);
  });
});
