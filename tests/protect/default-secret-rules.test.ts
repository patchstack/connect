import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

// The default response ruleset ships vendor API-key redaction, so a leaked provider token is masked
// out of the box (no per-app rule authoring). Prefix-anchored + high-signal → low false-positive.
//
// NOTE: sample tokens are assembled from split fragments at runtime so no contiguous secret-shaped
// literal appears in this source file (which would trip secret-scanning push protection). The
// assembled string still matches the default rule's regex.

const textResp = (body: string) =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });

const body = (len: number) => 'x'.repeat(len);
const SAMPLES: Record<string, string> = {
  stripe: 'sk_' + 'live_' + body(24),
  github: 'gh' + 'p_' + body(36),
  githubPat: 'github' + '_pat_' + body(62),
  gitlab: 'gl' + 'pat-' + body(24),
  slack: 'xox' + 'b-' + '123456789012-' + body(12),
  anthropic: 'sk-' + 'ant-' + body(30),
  googleOAuth: 'ya' + '29.' + body(40),
  npm: 'np' + 'm_' + body(36),
};

describe('default response rules — vendor API-key redaction', () => {
  for (const [name, token] of Object.entries(SAMPLES)) {
    it(`masks a leaked ${name} token by default`, async () => {
      const p: any = await createProtection({ mode: 'block' }); // default response rules
      const out = await p.screenResponse(textResp(JSON.stringify({ config: token })));
      const masked = await out.text();
      expect(masked.includes(token)).toBe(false);
      expect(masked.includes('[REDACTED]')).toBe(true);
    });
  }

  it('leaves an ordinary response untouched (no false positive)', async () => {
    const p: any = await createProtection({ mode: 'block' });
    const clean = JSON.stringify({ user: 'ada@example.com', note: 'the quick brown fox', id: 42 });
    const out = await p.screenResponse(textResp(clean));
    expect(await out.text()).toBe(clean);
  });
});
