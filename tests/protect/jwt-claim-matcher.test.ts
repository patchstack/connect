import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';
import { jwtClaimSpans } from '../../src/protect/engine/engine.js';

/**
 * `jwt_claim_equals` decides on a JWT's decoded payload, and yields the matching token spans so
 * `redact` masks those tokens instead of withholding the whole response.
 *
 * It replaces a rule that masked EVERY JWT in a response body. That rule was wrong in both directions,
 * measured before this change: it masked the Supabase `anon` key — public by design — and it masked a
 * user's own `access_token`, so an app proxying Supabase auth had its login response mangled. A normal
 * login response is the proof that "a JWT in a response" is not inherently a leak.
 *
 * Every key here is SYNTHETIC. Nothing in this path verifies signatures, so a fake signature exercises
 * the same branches a real one would.
 */
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sig = Buffer.from('not-a-real-signature').toString('base64url');
const jwt = (payload: unknown) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.${sig}`;

const REF = 'abcdefghijklmnopqrst';
const SERVICE = jwt({ iss: 'supabase', ref: REF, role: 'service_role', iat: 1600000000, exp: 1900000000 });
const ANON = jwt({ iss: 'supabase', ref: REF, role: 'anon', iat: 1600000000, exp: 1900000000 });
const SESSION = jwt({ iss: `https://${REF}.supabase.co/auth/v1`, sub: 'u1', role: 'authenticated', exp: 1900000000 });

async function screen(body: string, contentType = 'application/json') {
  const p: any = await createProtection({
    rules: { firewall: [], whitelists: [], whitelist_keys: {} },
    mode: 'block',
  });
  const res = await p.screenResponse(
    new Response(body, { status: 200, headers: { 'content-type': contentType } }),
    new Request('https://app.test/', { method: 'GET' })
  );
  return { text: await res.text(), status: res.status };
}

describe('the service_role key is masked, and only it', () => {
  it('masks a service_role key in a JSON body', async () => {
    const { text } = await screen(JSON.stringify({ config: { key: SERVICE } }));
    expect(text).not.toContain(SERVICE);
  });

  it('leaves the anon key alone — it is meant to reach the browser', async () => {
    const body = `<!doctype html><script>window.__SB__={anonKey:"${ANON}"}</script>`;
    const { text } = await screen(body, 'text/html');
    expect(text).toBe(body);
  });

  it("leaves a user's own session token alone", async () => {
    // The case that proves a JWT in a response is not inherently a leak: this IS the login response.
    const body = JSON.stringify({ access_token: SESSION, token_type: 'bearer', user: { id: 'u1' } });
    expect((await screen(body)).text).toBe(body);
  });

  it('masks only the service_role token when both are present', async () => {
    const { text } = await screen(JSON.stringify({ anon: ANON, service: SERVICE }));
    expect(text).toContain(ANON);
    expect(text).not.toContain(SERVICE);
  });
});

describe('redact masks the span rather than withholding the response', () => {
  it('serves the rest of the body, with a 200', async () => {
    // The reason the matcher has to produce spans. A predicate-only matcher leaves `redact` with
    // nothing to mask, so the rule falls back to withholding the WHOLE response — turning a one-token
    // leak into an outage.
    const { text, status } = await screen(JSON.stringify({ greeting: 'hello', key: SERVICE, n: 42 }));
    expect(status).toBe(200);
    expect(text).toContain('hello');
    expect(text).toContain('42');
    expect(text).not.toContain(SERVICE);
  });

  it('masks every copy, and every matching token', async () => {
    const second = jwt({ iss: 'supabase', ref: 'zyxwvutsrqponmlkjihg', role: 'service_role' });
    const { text } = await screen(JSON.stringify({ a: SERVICE, b: SERVICE, c: second }));
    expect(text).not.toContain(SERVICE);
    expect(text).not.toContain(second);
  });
});

describe('only a positive identification matches', () => {
  const cases: Array<[string, string]> = [
    ['a payload that is not base64url at all', 'eyJhbGciOiJIUzI1NiJ9.!!!not-base64!!!.sig'],
    ['a payload that decodes but is not JSON', `${b64({ alg: 'HS256' })}.${Buffer.from('plain text').toString('base64url')}.${sig}`],
    ['a payload that is a JSON array', `${b64({ alg: 'HS256' })}.${b64(['role', 'service_role'])}.${sig}`],
    ['a payload that is a JSON string', `${b64({ alg: 'HS256' })}.${b64('service_role')}.${sig}`],
    ['a payload with no role claim', jwt({ iss: 'supabase', sub: 'u1' })],
    ['a role that is not a string', jwt({ role: ['service_role'] })],
    ['a role that is a different value', jwt({ role: 'anon' })],
    ['a role that merely contains the value', jwt({ role: 'not_service_role_really' })],
    ['two segments rather than three', `${b64({ alg: 'HS256' })}.${b64({ role: 'service_role' })}`],
    // A four-part string is not a JWT, and matching its first three segments would judge the author as
    // though they had written one. Same for a token that is itself a continuation of something longer.
    ['a four-segment continuation', `${SERVICE}.extra`],
    ['a five-segment continuation', `${SERVICE}.a.b`],
    ['a token preceded by another segment', `AAA.${SERVICE}`],
    ['a token glued to a preceding word', `prefix${SERVICE}`],
  ];

  it.each(cases)('does not match: %s', async (_name, token) => {
    const body = JSON.stringify({ token });
    expect((await screen(body)).text).toBe(body);
  });

  it('still matches a token that merely sits next to punctuation', () => {
    // The boundary rejects a CONTINUATION, not any adjacent dot. A leak at the end of a sentence, or in
    // a URL path, is still a leak — rejecting those would have traded one blind spot for another.
    for (const body of [`${SERVICE}.`, `${SERVICE}. next`, `/api/${SERVICE}/x`, `Bearer ${SERVICE}`, `"${SERVICE}"`]) {
      expect(jwtClaimSpans(body, 'role', 'service_role'), `missed in: ${body}`).toEqual([SERVICE]);
    }
  });

  it('does not read the claim off the prototype', () => {
    // Without an own-property check, `constructor` or `toString` would resolve on Object.prototype and
    // the matcher would decide on something the token never said.
    for (const claim of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(jwtClaimSpans(`x ${jwt({ role: 'anon' })} y`, claim, 'service_role')).toEqual([]);
    }
  });

  it('never even considers an oversized payload', () => {
    // Measured: a 9000-char payload encodes to ~12k base64 chars, past the candidate pattern's bound,
    // so it is not a candidate and never reaches the decoder. The bound lives in the pattern; an
    // explicit size re-check would be a branch no input can reach.
    const huge = jwt({ role: 'service_role', pad: 'A'.repeat(9000) });
    expect(jwtClaimSpans(`x ${huge} y`, 'role', 'service_role')).toEqual([]);
  });

  it('does not throw, or fail open, on a payload of null', () => {
    // `hasOwnProperty.call(null, …)` throws, and an exception here would reach the engine's per-rule
    // catch and fail the rule OPEN — so a real leak elsewhere in the body would be served because a
    // neighbouring token decoded to `null`.
    const nullPayload = `${b64({ alg: 'HS256' })}.${Buffer.from('null').toString('base64url')}.${sig}`;
    expect(() => jwtClaimSpans(`x ${nullPayload} y`, 'role', 'service_role')).not.toThrow();
    expect(jwtClaimSpans(`x ${nullPayload} y`, 'role', 'service_role')).toEqual([]);

    // And the leak beside it is still caught, which is what failing open would have cost.
    expect(jwtClaimSpans(`${nullPayload} ${SERVICE}`, 'role', 'service_role')).toEqual([SERVICE]);
  });

  it('does not throw on a numeric payload', () => {
    const numeric = `${b64({ alg: 'HS256' })}.${Buffer.from('1234').toString('base64url')}.${sig}`;
    expect(() => jwtClaimSpans(`x ${numeric} y`, 'role', 'service_role')).not.toThrow();
    expect(jwtClaimSpans(`x ${numeric} y`, 'role', 'service_role')).toEqual([]);
  });

  it('ignores a claim that exists only on a polluted prototype', () => {
    // If something upstream has polluted Object.prototype, a payload carrying no `role` at all would
    // otherwise read one off the prototype and be judged on a value the token never contained.
    (Object.prototype as any).role = 'service_role';
    try {
      const noRole = jwt({ iss: 'supabase', sub: 'u1' });
      expect(jwtClaimSpans(`x ${noRole} y`, 'role', 'service_role')).toEqual([]);
      // The positive case still works, so this is not just a blanket refusal.
      expect(jwtClaimSpans(`x ${SERVICE} y`, 'role', 'service_role')).toEqual([SERVICE]);
    } finally {
      delete (Object.prototype as any).role;
    }
  });

  it('matches an own claim whose name collides with a prototype member', () => {
    // The other half of the own-property check: a token that really does carry `constructor` as a
    // claim must still be decidable, or the guard above would have created a blind spot.
    const odd = jwt({ constructor: 'service_role' });
    expect(jwtClaimSpans(`x ${odd} y`, 'constructor', 'service_role')).toEqual([odd]);
  });
});

describe('detection and masking cannot disagree', () => {
  it('reports exactly what it masks', async () => {
    // Both halves derive from the same `jwtClaimSpans`. If they were computed separately, a token
    // could be reported as redacted while the body still carried it.
    const detections: any[] = [];
    const p: any = await createProtection({
      rules: { firewall: [], whitelists: [], whitelist_keys: {} },
      mode: 'block',
      onDetect: (d: any) => detections.push(d),
    });

    const leaked = await p.screenResponse(
      new Response(JSON.stringify({ key: SERVICE }), { status: 200, headers: { 'content-type': 'application/json' } }),
      new Request('https://app.test/', { method: 'GET' })
    );
    expect(await leaked.text()).not.toContain(SERVICE);
    expect(detections.length).toBeGreaterThan(0);

    detections.length = 0;
    const clean = await p.screenResponse(
      new Response(JSON.stringify({ key: ANON }), { status: 200, headers: { 'content-type': 'application/json' } }),
      new Request('https://app.test/', { method: 'GET' })
    );
    expect(await clean.text()).toContain(ANON);
    expect(detections).toEqual([]);
  });
});
