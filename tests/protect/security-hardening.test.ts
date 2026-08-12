import { describe, it, expect } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';
import { RuleEngine, _testExports } from '../../src/protect/engine/engine.js';

// Regression coverage for the input-canonicalization / evasion hardening pass. Each block pins a
// concrete bypass that was reproducible against the engine, plus the false-positive/functional
// controls that must keep working.

const mk = (rules: any[]) => createProtection({ mode: 'block', rules: { firewall: rules, whitelists: [], whitelist_keys: {} } as any });
const jreq = (body: any, ct = 'application/json', url = 'https://app.com/x') =>
  new Request(url, { method: 'POST', headers: { 'content-type': ct }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const blocks = async (p: any, req: Request) => (await p.fetch(() => new Response('ok'))(req)).status === 403;

describe('SSRF: internal_host canonicalization', () => {
  const { isInternalHost } = _testExports as any;
  const internal = [
    '::1', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001',
    '0:0:0:0:0:ffff:7f00:1', '::ffff:7f00:1', '::ffff:127.0.0.1',
    '127.0.0.1', '169.254.169.254', '100.100.100.200',
    '2130706433', '0x7f000001', '0177.0.0.1', '127.1', '127.0.0.1.',
    '0.0.0.0', '0', '10.0.0.5', '192.168.1.1', '172.16.0.1',
    'fe80::1', 'fc00::1', 'fd12::1', 'fe80::1%eth0', 'localhost',
  ];
  const external = [
    'example.com', 'fcm.googleapis.com', 'fd-cdn.example.net', 'api.stripe.com',
    '8.8.8.8', '1.1.1.1', '93.184.216.34', 'beef', 'cafe.babe',
    '100.63.255.255', '101.0.0.1', '172.32.0.1',
  ];
  it.each(internal)('classifies %s as internal', (h) => expect(isInternalHost(h)).toBe(true));
  it.each(external)('classifies %s as external (no false positive)', (h) => expect(isInternalHost(h)).toBe(false));

  it('blocks an egress rule against an expanded-IPv6-loopback literal', () => {
    const eng = new RuleEngine({ firewall: [{ rule_v2: [{ parameter: 'egress.host', match: { type: 'internal_host' } }] }] });
    expect(eng.evaluate({ _egress: { host: '0:0:0:0:0:0:0:1', url: 'x', method: 'GET' } } as any).blocked).toBe(true);
  });
});

describe('request: structured-value evasion', () => {
  it('matches a payload nested deeper than the scalar rule expects', async () => {
    const p = await mk([{ id: 'x', rule_v2: [{ parameter: 'post.data', match: { type: 'contains', value: '<script' } }] }]);
    expect(await blocks(p, jreq({ data: { a: { b: '<script>x</script>' } } }))).toBe(true); // depth 2
    expect(await blocks(p, jreq({ data: { a: '<script>x</script>' } }))).toBe(true); // depth 1 control
  });
  it('matches a payload inside an array of objects', async () => {
    const p = await mk([{ id: 'i', rule_v2: [{ parameter: 'post.items', match: { type: 'contains', value: '<script' } }] }]);
    expect(await blocks(p, jreq({ items: [{ v: '<script>x</script>' }] }))).toBe(true);
  });
  it('matches within a sane depth and never crashes on a pathologically deep value', async () => {
    const p = await mk([{ id: 'd', rule_v2: [{ parameter: 'post.q', match: { type: 'contains', value: 'evil' } }] }]);
    // A realistically-nested payload is found.
    let mid: any = 'evil';
    for (let i = 0; i < 100; i++) mid = [mid];
    expect(await blocks(p, jreq({ q: mid }))).toBe(true);
    // A pathologically-deep value must not throw/hang (the RangeError fail-open) — the request just
    // completes. (Nothing real nests this deep, and the app couldn't traverse it either.)
    let deep: any = 'evil';
    for (let i = 0; i < 10000; i++) deep = [deep];
    await expect(blocks(p, jreq({ q: deep }))).resolves.toBeTypeOf('boolean');
  });
});

describe('request: normalizer no longer deletes payload spans', () => {
  it('matches a payload after a leading # (was deleted by comment-stripping)', async () => {
    const p = await mk([{ id: 'x', rule_v2: [{ parameter: 'post.c', match: { type: 'contains', value: '<script' } }] }]);
    expect(await blocks(p, jreq({ c: '#<script>alert(1)</script>' }))).toBe(true);
  });
});

describe('request: content-type parsing', () => {
  const types = ['application/json', 'application/vnd.api+json', 'application/ld+json', 'text/plain', 'application/csp-report'];
  it.each(types)('populates post.* for a JSON body sent as %s', async (ct) => {
    const p = await mk([{ id: 'r', rule_v2: [{ parameter: 'post.role', match: { type: 'contains', value: 'admin' } }] }]);
    expect(await blocks(p, jreq({ role: 'admin' }, ct))).toBe(true);
  });
});

describe('request: body cap is not skipped by a declared Content-Length', () => {
  it('scans the prefix even when Content-Length is declared huge', async () => {
    const p = await mk([{ id: 'pp', rule_v2: [{ parameter: 'raw', match: { type: 'contains', value: '__proto__' } }] }]);
    const req = new Request('https://app.com/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '9999999' },
      body: '{"__proto__":{"x":1}}',
    });
    expect(await blocks(p, req)).toBe(true);
  });
});

describe('engine: ReDoS guard catches nested quantified subgroups', () => {
  const { safeRegExp } = _testExports as any;
  it('rejects ((ab)+)+ and deeper nestings', () => {
    expect(safeRegExp('/((ab)+)+$/')).toBeNull();
    expect(safeRegExp('/(((ab)+)+)+$/')).toBeNull();
    expect(safeRegExp('/((a|b)+)+$/')).toBeNull();
  });
  it('keeps a genuinely safe pattern', () => {
    expect(safeRegExp('/sk_live_[0-9A-Za-z]{16}/')).not.toBeNull();
    expect(safeRegExp('/AKIA[0-9A-Z]{16}/')).not.toBeNull();
  });
});

describe('origin checks', () => {
  it('cross_origin flags a present-but-opaque Origin: null (and normalizes default ports)', () => {
    const eng = new RuleEngine({ firewall: [{ when: { method: ['POST'] }, rule_v2: [{ match: { type: 'cross_origin' } }] }] });
    const cx = (origin?: string) => eng.evaluate({
      method: 'POST', url: '/t', originalUrl: '/t', query: {}, body: {}, _rawBody: '',
      headers: { host: 'app.com:443', ...(origin !== undefined ? { origin } : {}) },
    } as any).blocked;
    expect(cx('null')).toBe(true); // opaque origin (sandboxed iframe)
    expect(cx('https://evil.com')).toBe(true); // ordinary cross-origin
    expect(cx('https://app.com')).toBe(false); // same host, default port elided → not cross-origin
    expect(cx(undefined)).toBe(false); // truly absent → lenient
  });

  it('off_origin flags protocol-relative and backslash redirects', () => {
    const eng = new RuleEngine({ firewall: [{ action: 'block', rule_v2: [{ match: { type: 'off_origin' } }] }] });
    const off = (loc: string) => eng.evaluate({
      method: 'GET', url: '/r', originalUrl: '/r', query: {}, body: {}, _rawBody: '',
      headers: { host: 'app.com' }, _response: { status: 302, headers: { location: loc } },
    } as any).blocked;
    expect(off('//evil.com/x')).toBe(true);
    expect(off('/\\evil.com')).toBe(true);
    expect(off('https://evil.com/x')).toBe(true);
    expect(off('/safe-path')).toBe(false); // relative → same origin
  });

  it('cors_reflected flags ACAO: null + credentials', () => {
    const eng = new RuleEngine({ firewall: [{ action: 'block', rule_v2: [{ match: { type: 'cors_reflected' } }] }] });
    const blocked = eng.evaluate({
      method: 'GET', url: '/x', originalUrl: '/x', query: {}, body: {}, _rawBody: '', headers: {},
      _response: { status: 200, headers: { 'access-control-allow-credentials': 'true', 'access-control-allow-origin': 'null' } },
    } as any).blocked;
    expect(blocked).toBe(true);
  });
});

describe('response: content-type screening', () => {
  const AWS = 'AKIA' + 'IOSFODNN7' + 'EXAMPLE';
  const served = async (contentType: string) => {
    const p = await createProtection({ mode: 'block' });
    const resp = new Response(JSON.stringify({ apiKey: AWS }), { status: 200, headers: { 'content-type': contentType } });
    const out = await p.screenResponse(resp, new Request('https://app.com/x'));
    return (await out.text()).includes(AWS);
  };
  it('screens a body whose CT merely contains "event-stream" as a parameter', async () => {
    expect(await served('application/json; profile="event-stream"')).toBe(false);
  });
  it('still passes a real text/event-stream through unbuffered', async () => {
    expect(await served('text/event-stream')).toBe(true);
  });
  it('screens a textual octet-stream export', async () => {
    expect(await served('application/octet-stream')).toBe(false);
  });
});

describe('response: mutation-carrying redactor fails closed', () => {
  it('blocks (does not serve) when a redact rule decodes the body before matching', async () => {
    const secret = 'sk_live_' + '0123456789abcdefXYZ';
    const b64 = Buffer.from(JSON.stringify({ token: secret })).toString('base64');
    const p = await createProtection({
      mode: 'block',
      responseRules: [{ phase: 'response', action: 'redact', rule_v2: [{ parameter: 'response.body', mutations: ['base64_decode'], match: { type: 'contains', value: 'sk_live_' } }] }] as any,
    });
    const out = await p.screenResponse(new Response(b64, { status: 200, headers: { 'content-type': 'text/plain' } }), new Request('https://app.com/x'));
    expect(out.status).toBe(500); // withheld, not served with a no-op mask
    expect((await out.text()).includes(secret)).toBe(false);
  });
});
