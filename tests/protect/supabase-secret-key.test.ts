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
const SECRET = 'sb_secret_' + 'Xk9Lm2Qp7Rt4Vw8Z' + 'aB3cD6eF';
const PUBLISHABLE = 'sb_publishable_' + 'Yj8Kn1Po6Qs3Uv7Y' + 'zA2bC5dE';

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
    // The failure that would look like success. Supabase does not document the key alphabet, so a
    // character class that guessed too narrowly would stop at the first unexpected character and mask
    // only the leading part — serving the remainder while the log says "redacted". Assert that no
    // substring long enough to matter survives.
    const out = await screen(JSON.stringify({ key: SECRET }));
    const suffix = SECRET.slice('sb_secret_'.length);
    for (let take = 8; take <= suffix.length; take++) {
      expect(out, `a ${take}-char run of the key survived`).not.toContain(suffix.slice(0, take));
      expect(out, `a ${take}-char tail of the key survived`).not.toContain(suffix.slice(-take));
    }
  });

  it('masks it whatever the delimiter around it', async () => {
    for (const body of [
      `{"k":"${SECRET}"}`,
      `k=${SECRET}&next=1`,
      `key: ${SECRET}\nother: 1`,
      `<div data-k='${SECRET}'>x</div>`,
      `[${SECRET}]`,
      `fn(${SECRET});`,
    ]) {
      expect(await screen(body, 'text/plain'), `not masked in: ${body}`).not.toContain(SECRET);
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
