import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';
import { safeRegExp } from '../../src/protect/engine/engine.js';
import { DEFAULT_RESPONSE_RULES } from '../../src/protect/defaults.js';

/**
 * Supabase's newer key format is an opaque string rather than a JWT, so none of the shipped secret
 * rules matched it: measured, a `sb_secret_` key was served through a screened response untouched.
 *
 * Supabase documents `sb_secret_` as full access, bypassing Row Level Security, backend-only, while
 * `sb_publishable_` is intended for public clients — so the two prefixes must be treated as opposites,
 * not as one family. Both key systems are live simultaneously (new keys are added alongside the legacy
 * `anon` / `service_role` JWTs without disabling them), so this covers a different half of the problem
 * from the JWT rules rather than replacing them.
 *
 * Every key in this file is SYNTHETIC.
 */
// Supabase's documented grammar: 22 base64url characters, `_`, then an 8-character base64url checksum.
const RANDOM = 'Xk9Lm2Qp7Rt4Vw8ZaB3cD6';
const CHECKSUM = 'eF7hJ2kM';
const SECRET = `sb_secret_${RANDOM}_${CHECKSUM}`;
const PUBLISHABLE = `sb_publishable_${RANDOM}_${CHECKSUM}`;

async function screen(body: string, contentType = 'application/json'): Promise<string> {
  const p: any = await createProtection({
    rules: { firewall: [], whitelists: [], whitelist_keys: {} },
    mode: 'block',
  });
  const out = await p.screenResponse(
    new Response(body, { status: 200, headers: { 'content-type': contentType } }),
    new Request('https://app.test/', { method: 'GET' })
  );
  return out.text();
}

describe('the Supabase secret key does not leave the app', () => {
  it('masks it in a JSON body', async () => {
    const out = await screen(JSON.stringify({ config: { key: SECRET } }));
    expect(out).not.toContain(SECRET);
  });

  it('masks it in HTML and in a script body', async () => {
    expect(await screen(`<script>const k="${SECRET}"</script>`, 'text/html')).not.toContain(SECRET);
    expect(await screen(`export const K="${SECRET}";`, 'application/javascript')).not.toContain(SECRET);
  });

  it('masks the WHOLE key, not a prefix of it', async () => {
    // "The key is not present verbatim" is also true when only its leading run was masked, so assert
    // that no run of it long enough to matter survives from either end.
    const out = await screen(JSON.stringify({ key: SECRET }));
    const body = SECRET.slice('sb_secret_'.length);
    for (let take = 8; take <= body.length; take++) {
      expect(out, `a ${take}-char run of the key survived`).not.toContain(body.slice(0, take));
      expect(out, `a ${take}-char tail of the key survived`).not.toContain(body.slice(-take));
    }
  });

  it('masks it whatever the delimiter around it, and leaves that delimiter alone', async () => {
    // Both halves matter. Redaction masks the offending span and leaves the response otherwise intact,
    // so a rule that destroys the field after the key is not doing its job — and "the secret is gone"
    // is true of that broken behaviour too, which is why each case names what must survive.
    const cases: Array<[string, string[]]> = [
      [`{"k":"${SECRET}"}`, ['{"k":"', '"}']],
      [`k=${SECRET}&next=1`, ['k=', '&next=1']],
      [`a=${SECRET}&b=2&c=3`, ['&b=2&c=3']],
      [`url?token=${SECRET}#frag`, ['url?token=', '#frag']],
      [`key: ${SECRET}\nother: 1`, ['key: ', '\nother: 1']],
      [`<div data-k='${SECRET}'>x</div>`, ["'>x</div>"]],
      [`[${SECRET}]`, ['[', ']']],
      [`fn(${SECRET});`, ['fn(', ');']],
      [`x=${SECRET}==`, ['==']],
      [`${SECRET}|next`, ['|next']],
    ];

    for (const [body, survivors] of cases) {
      const out = await screen(body, 'text/plain');
      expect(out, `not masked in: ${body}`).not.toContain(SECRET);
      for (const survivor of survivors) {
        expect(out, `masking ate ${JSON.stringify(survivor)} in: ${body}`).toContain(survivor);
      }
    }
  });
});

describe('the publishable key is not a secret', () => {
  it('leaves it untouched — it is meant to reach the browser', async () => {
    // The negative control. A rule that masked every `sb_` prefix would pass every test above while
    // breaking any app that ships its publishable key, which is what that key is for.
    const body = JSON.stringify({ supabaseKey: PUBLISHABLE });
    expect(await screen(body)).toBe(body);
  });

  it('leaves a publishable key alone even beside a secret one', async () => {
    const out = await screen(JSON.stringify({ pub: PUBLISHABLE, secret: SECRET }));
    expect(out).toContain(PUBLISHABLE);
    expect(out).not.toContain(SECRET);
  });
});

describe('only the documented grammar is a key', () => {
  // 22 base64url characters, `_`, 8-character checksum. Exactness is what keeps the mask off the
  // response around the key and off a partially-matched one, so each way of departing from the grammar
  // is a case here.
  const notKeys: Array<[string, string]> = [
    ['21 random characters', `sb_secret_${RANDOM.slice(0, -1)}_${CHECKSUM}`],
    ['23 random characters', `sb_secret_${RANDOM}7_${CHECKSUM}`],
    ['7-character checksum', `sb_secret_${RANDOM}_${CHECKSUM.slice(0, -1)}`],
    ['9-character checksum', `sb_secret_${RANDOM}_${CHECKSUM}X`],
    ['a dash where the separator belongs', `sb_secret_${RANDOM}-${CHECKSUM}`],
    ['no separator at all', `sb_secret_${RANDOM}X${CHECKSUM}`],
    ['a checksum character outside base64url', `sb_secret_${RANDOM}_${CHECKSUM.slice(0, -1)}!`],
    ['a longer run of key characters', `${SECRET}ABCDEF`],
  ];

  it.each(notKeys)('does not fire on %s', async (_name, value) => {
    const body = JSON.stringify({ k: value });
    expect(await screen(body)).toBe(body);
  });

  it('fires on a valid key beside URL and query syntax, leaving that syntax intact', async () => {
    for (const [body, survivors] of [
      [`https://app.test/cb?token=${SECRET}&next=%2Fhome`, ['?token=', '&next=%2Fhome']],
      [`https://app.test/${SECRET}/refresh`, ['https://app.test/', '/refresh']],
      [`{"a":1,"key":"${SECRET}","b":2}`, ['"a":1', '"b":2']],
    ] as Array<[string, string[]]>) {
      const out = await screen(body, 'text/plain');
      expect(out, `not masked in: ${body}`).not.toContain(SECRET);
      for (const survivor of survivors) {
        expect(out, `masking ate ${JSON.stringify(survivor)}`).toContain(survivor);
      }
    }
  });
});

describe('the rule does not fire on things that merely look like it', () => {
  it('ignores the bare prefix, as it appears in prose and documentation', async () => {
    for (const body of ['use sb_secret_ from the dashboard', JSON.stringify({ hint: 'sb_secret_<your key>' })]) {
      expect(await screen(body, 'text/plain')).toBe(body);
    }
  });

  it('is a pattern the engine will actually run', () => {
    // A rule whose regex the ReDoS guard rejects is a rule that never fires — the same defect as the
    // inline-flag patterns in the seeded templates. Assert compilation through the guard the engine uses.
    const rule = DEFAULT_RESPONSE_RULES.find((r: any) => r.id === 'resp-supabase-secret-key');
    expect(rule).toBeDefined();
    expect(safeRegExp((rule as any).rule_v2[0].match.value)).not.toBeNull();
  });

  it('is anchored by a prefilter, so a body without the prefix is never regex-scanned', () => {
    const rule: any = DEFAULT_RESPONSE_RULES.find((r: any) => r.id === 'resp-supabase-secret-key');
    expect(rule.prefilter).toEqual(['sb_secret_']);
  });
});
