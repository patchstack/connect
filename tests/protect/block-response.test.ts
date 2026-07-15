import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';
import { renderBlockPage } from '../../src/protect/block-page.js';

// A blocked REQUEST returns the branded "Access Denied" HTML page to a browser navigation, and
// masked JSON to an XHR/fetch. Neither surface exposes the WAF narrative or the rule title.

const rules = {
  firewall: [
    {
      id: 'demo-lfi',
      title: 'Path traversal in a file parameter',
      category: 'lfi',
      rule_v2: [{ parameter: ['get.file'], mutations: ['urldecode'], match: { type: 'contains', value: '..' } }],
    },
  ],
  whitelists: [],
  whitelist_keys: {},
};

const blockedReq = (headers: Record<string, string>) =>
  new Request('https://app.demo/read?file=../../etc/passwd', { headers });

describe('request block response', () => {
  it('serves the HTML block page for a top-level navigation (Sec-Fetch-Dest: document)', async () => {
    const p = await createProtection({ rules, mode: 'block' });
    const res: any = await p.fetchGuard()(blockedReq({ 'sec-fetch-dest': 'document' }));
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Access Denied');
    expect(html).toContain('This request has been blocked by Patchstack');
    expect(/WAF/i.test(html)).toBe(false); // no WAF narrative
    expect(html).toContain('demo-lfi'); // opaque reference code
  });

  it('falls back to the HTML page via Accept: text/html when Sec-Fetch-Dest is absent', async () => {
    const p = await createProtection({ rules, mode: 'block' });
    const res: any = await p.fetchGuard()(blockedReq({ accept: 'text/html,application/xhtml+xml' }));
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('serves masked JSON to an XHR/fetch (generic message, no WAF narrative, keeps opaque rule id)', async () => {
    const p = await createProtection({ rules, mode: 'block' });
    const res: any = await p.fetchGuard()(blockedReq({ 'sec-fetch-dest': 'empty', accept: 'application/json' }));
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body.error).toBe('This request has been blocked by Patchstack.');
    expect(/WAF/i.test(JSON.stringify(body))).toBe(false);
    expect(body.rule).toBe('demo-lfi'); // machine-readable id retained
  });

  it('renderBlockPage escapes the URL (no reflected XSS)', () => {
    const html = renderBlockPage({ url: 'https://app/?x="><script>alert(1)</script>', code: 'demo-lfi' });
    expect(html.includes('<script>alert(1)')).toBe(false);
    expect(html).toContain('&lt;script&gt;alert(1)');
  });
});
