import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProtection } from '../../src/protect/runtime.js';

// The authored rule SHAPES, exercised through the real guard.
//
// `rule-corpus.test.ts` proves the engine can express one canonical rule per vulnerability class. This is a
// different claim about a different artifact: these are the shapes as authored for production, in full — the
// AND-ed gadget spellings, the mutations, the extra carriers — and the question here is whether the engine
// executes them as written.
//
// That question has a specific failure mode behind it. A rule the engine silently rejects, or one whose
// match never fires, is indistinguishable from protection: it is present in the bundle, it appears in the
// dashboard, and it blocks nothing. Four rules in this set were inert at some point for exactly that kind of
// reason — an inline-flag regex, a phase left at the default, a parameter source that does not exist. So
// every shape is run against a real payload, and every payload is paired with a benign request, because a
// rule that blocks the attack and also blocks ordinary traffic has mitigated nothing either.
//
// The fixture is payload shapes only. Which advisories a shape covers, the affected version ranges, and the
// authoring notes stay out of this repository: that mapping is the product, and it is maintained where the
// advisories are triaged.

const FIXTURE = join(import.meta.dirname, 'fixtures', 'rule-shapes.json');
const { shapes } = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  shapes: Record<string, { title: string; category: string; phase?: string; rule_v2: any[]; why: string; falsePositiveRisk: string }>;
};

const shape = (id: string) => {
  const found = shapes[id];
  expect(found, `${id} must be in the shape fixture`).toBeDefined();
  return found;
};

/** A guard carrying ONE shape, so nothing can pass or fail because of a sibling rule. */
const guardFor = async (id: string, opts: Record<string, unknown> = {}) => {
  const s = shape(id);
  const entry = { id: `shape:${id}`, title: s.title, category: s.category, rule_v2: s.rule_v2, ...(s.phase ? { phase: s.phase } : {}) };
  const p: any = await createProtection({ rules: { firewall: [entry] }, mode: 'block', ...opts });
  return p.fetchGuard();
};

/**
 * Send a body VERBATIM. Necessary for the gadget cases: `{ __proto__: {…} }` written as a JavaScript object
 * literal sets the prototype instead of creating a key, so `JSON.stringify` emits `{}` — a test built that
 * way sends no gadget at all while appearing to.
 */
const raw = (body: string, path = '/api/save', type = 'application/json') =>
  new Request(`https://app.example.com${path}`, { method: 'POST', headers: { 'content-type': type }, body });
const post = (body: unknown, path = '/api/save') => raw(JSON.stringify(body), path);
const get = (query: string, headers: Record<string, string> = {}) =>
  new Request(`https://app.example.com/api/items?${query}`, { method: 'GET', headers });

describe('the gadget must appear literally in the request', () => {
  const ID = 'prototype-pollution-gadget';

  it('blocks the literal gadget in a JSON body', async () => {
    const guard = await guardFor(ID);
    const body = '{"settings":{"__proto__":{"polluted":true}}}';
    expect(body, 'the gadget must be on the wire, not swallowed by an object literal').toContain('__proto__');

    const res = await guard(raw(body));

    expect(res, 'a body carrying the gadget must not reach the vulnerable merge').not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it('blocks the gadget when the key is nested inside an array', async () => {
    const guard = await guardFor(ID);

    expect(await guard(post({ patches: [{ path: 'a' }, { path: '__proto__.isAdmin' }] }))).not.toBeNull();
  });

  it('blocks the constructor/prototype spelling, which needs no __proto__ at all', async () => {
    const guard = await guardFor(ID);

    const res = await guard(post({ key: 'constructor', sub: 'prototype', value: 1 }));

    expect(res, 'the second spelling is the one a __proto__-only rule misses').not.toBeNull();
  });

  it('blocks the gadget arriving in the query string', async () => {
    // Not every consumer of a polluted merge reads a JSON body — argv and query-string parsers take the
    // same gadget through a different carrier.
    const guard = await guardFor(ID);

    expect(await guard(get('__proto__[isAdmin]=1'))).not.toBeNull();
  });

  it('blocks a percent-encoded gadget', async () => {
    const guard = await guardFor(ID);

    const res = await guard(get('%5f%5fproto%5f%5f[x]=1'));

    expect(res, 'the urldecode mutation must see through the encoding').not.toBeNull();
  });

  it('passes an ordinary settings update', async () => {
    const guard = await guardFor(ID);

    expect(await guard(post({ settings: { theme: 'dark', locale: 'en-GB', notify: true } }))).toBeNull();
  });

  it('passes a body that mentions only one half of the constructor spelling', async () => {
    // `constructor` alone is an ordinary English word that appears in real content. The rule ANDs the two
    // halves precisely so this does not become a false positive.
    const guard = await guardFor(ID);

    expect(await guard(post({ bio: 'I am the constructor of small wooden boats.' }))).toBeNull();
  });

  it('passes a query string with ordinary bracket syntax', async () => {
    const guard = await guardFor(ID);

    expect(await guard(get('filter[status]=open&sort[created]=desc'))).toBeNull();
  });
});

describe('an internal-only header is the whole exploit', () => {
  const ID = 'internal-subrequest-header';

  it('blocks a request carrying the header', async () => {
    const guard = await guardFor(ID);

    const res = await guard(get('page=1', { 'x-middleware-subrequest': 'middleware' }));

    expect(res, 'presence of the header IS the bypass').not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it('blocks it whatever the value, including empty', async () => {
    // The reason presence is matched rather than a value pattern: an empty header is as effective as a
    // crafted one, and a value regex would pass it while looking specific.
    for (const value of ['', 'src/middleware', 'middleware:middleware:middleware', 'x']) {
      const guard = await guardFor(ID);

      const res = await guard(get('page=1', { 'x-middleware-subrequest': value }));

      expect(res, `value ${JSON.stringify(value)} must not slip through`).not.toBeNull();
    }
  });

  it('passes an identical request without the header', async () => {
    const guard = await guardFor(ID);

    expect(await guard(get('page=1'))).toBeNull();
  });

  it('passes a request whose body merely mentions the header name', async () => {
    // A support form or a docs page discussing the advisory must not be blocked: the rule reads the header,
    // not the text of the request.
    const guard = await guardFor(ID);

    expect(await guard(post({ message: 'is x-middleware-subrequest patched in our version?' }))).toBeNull();
  });
});

describe('a fixed marker is what makes a payload executable', () => {
  const ID = 'serialized-function-marker';
  const PAYLOAD = '{"rce":"_$$ND_FUNC$$_function(){require(\'child_process\').exec(\'id\')}()"}';

  it('blocks the payload in a body', async () => {
    const guard = await guardFor(ID);

    const res = await guard(raw(PAYLOAD, '/api/state'));

    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it('blocks it when transported in a cookie', async () => {
    const guard = await guardFor(ID);

    const res = await guard(get('x=1', { cookie: `profile=${encodeURIComponent(PAYLOAD)}` }));

    expect(res, 'a deserialized session value commonly arrives in a cookie').not.toBeNull();
  });

  it('blocks a base64-transported payload', async () => {
    const guard = await guardFor(ID);
    const encoded = Buffer.from(PAYLOAD).toString('base64');
    expect(encoded.includes('_$$ND_FUNC$$_'), 'the marker must be hidden by the encoding').toBe(false);

    const res = await guard(raw(encoded, '/api/state', 'text/plain'));

    expect(res, 'the base64_decode mutation must see the marker').not.toBeNull();
  });

  it('passes an ordinary serialized object', async () => {
    const guard = await guardFor(ID);

    expect(await guard(post({ user: { id: 7, name: 'Ada' }, ts: 1755000000 }))).toBeNull();
  });

  it('passes a body containing plain JavaScript function source', async () => {
    // A code-sharing app posting `function(){}` is not this attack; the marker is what makes it one.
    const guard = await guardFor(ID);

    expect(await guard(post({ snippet: 'function(){ return 1 }' }))).toBeNull();
  });
});

describe('template option names in request data are the attack, not a heuristic', () => {
  const ID = 'template-option-injection';

  it('blocks the documented option vector', async () => {
    const guard = await guardFor(ID);

    const res = await guard(get('settings[view options][outputFunctionName]=x;process.mainModule.require(\'child_process\').execSync(\'id\');s'));

    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it('blocks the sibling option keys that reach the same compile', async () => {
    for (const key of ['escapeFunction', 'localsName']) {
      const guard = await guardFor(ID);

      expect(await guard(post({ options: { [key]: 'payload' } })), `${key} is the same injection`).not.toBeNull();
    }
  });

  it('passes an ordinary render request', async () => {
    const guard = await guardFor(ID);

    expect(await guard(get('template=invoice&locale=en&currency=EUR'))).toBeNull();
  });

  it('passes a body with the app’s own option-shaped fields', async () => {
    const guard = await guardFor(ID);

    const res = await guard(post({ options: { format: 'pdf', pageSize: 'A4', outputName: 'invoice.pdf' } }));

    expect(res, 'outputName is not outputFunctionName — no prefix collision').toBeNull();
  });
});

describe('when the destination is the only chokepoint', () => {
  const ID = 'internal-destination-egress';

  /** Install the egress guard with only this shape, exercise it, then restore fetch. */
  const withEgress = async (opts: Record<string, unknown>, fn: (f: typeof fetch) => Promise<void>) => {
    const s = shape(ID);
    const entry = { id: `shape:${ID}`, title: s.title, category: s.category, phase: s.phase, rule_v2: s.rule_v2 };
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('stub')) as any;
    const p: any = await createProtection({
      rules: { firewall: [entry] },
      mode: 'block',
      egress: true,
      // No resolver, so nothing here waits on one. The guard screens a hostname by resolving it, and
      // these destinations are either literal IPs — which never reach a resolver — or names that do not
      // exist, so a live lookup adds a round trip to every case and decides none of them. With this off
      // the guard builds no resolver at all, and the hostname and address rules these tests are about
      // still apply.
      //
      // What the screen does with an address it resolves is `egress-dns.test.ts`, which builds the guard
      // directly and injects the addresses it is asking about.
      screenDns: false,
      ...opts,
    });
    try {
      await fn(globalThis.fetch);
    } finally {
      p.uninstallEgress?.();
      globalThis.fetch = original;
    }
  };
  const blocked = async (f: typeof fetch, url: string) => {
    try {
      await f(url);
      return false;
    } catch (e) {
      return /Patchstack blocked/.test(String(e));
    }
  };

  it('is authored as an egress rule, not a request rule', () => {
    // The redirect is the point: a request-phase check on the app's own URL field runs before the redirect
    // exists, so only the outbound call can see the final destination.
    expect(shape(ID).phase).toBe('egress');
  });

  it('fires under its own id once the built-in default is suppressed', async () => {
    // Worth pinning on its own. In ordinary operation the BUILT-IN internal-address egress rule matches
    // first, so this shape contributes attribution rather than protection — and if it were inert, the
    // blocking assertions below would be the default's work while appearing to prove this rule.
    const hits: string[] = [];

    await withEgress({ allowHosts: [], egressRules: [], onDetect: (d: any) => hits.push(d.rule?.id) },
      async (f) => { expect(await blocked(f, 'http://169.254.169.254/')).toBe(true); });

    expect(hits).toContain(`shape:${ID}`);
  });

  it('blocks an outbound call to the link-local metadata address', async () => {
    await withEgress({ allowHosts: [] }, async (f) => {
      expect(await blocked(f, 'http://169.254.169.254/latest/meta-data/')).toBe(true);
    });
  });

  it('blocks loopback and private-range destinations', async () => {
    await withEgress({ allowHosts: [] }, async (f) => {
      for (const url of ['http://127.0.0.1:6379/', 'http://10.0.0.5/admin', 'http://192.168.1.1/']) {
        expect(await blocked(f, url), url).toBe(true);
      }
    });
  });

  it('allows an ordinary third-party API call', async () => {
    await withEgress({ allowHosts: [] }, async (f) => {
      expect(await blocked(f, 'https://api.stripe.example/v1/charges')).toBe(false);
    });
  });

  it('allows an internal destination the deployment declared', async () => {
    // The false-positive answer for an app that genuinely calls an internal service.
    await withEgress({ allowHosts: ['internal.svc.test'] }, async (f) => {
      expect(await blocked(f, 'http://internal.svc.test/health')).toBe(false);
    });
  });
});

describe('every shape is in a form the engine executes, and reviewable', () => {
  const walk = (rules: any[], visit: (r: any) => void) => {
    for (const r of rules) {
      visit(r);
      if (Array.isArray(r.rules)) walk(r.rules, visit);
    }
  };
  const allRules = () => Object.values(shapes).flatMap((s) => s.rule_v2);

  it('uses only /pattern/flags regexes — the inline-flag form is rejected and silently inert', () => {
    walk(allRules(), (r) => {
      if (r.match?.type !== 'regex') return;
      expect(r.match.value, `regex must be delimited: ${r.match.value}`).toMatch(/^\/.*\/[a-z]*$/s);
      expect(r.match.value, 'PCRE inline flags are not supported').not.toMatch(/^\/?\(\?[a-z]+\)/);
    });
  });

  it('names only parameter sources the engine understands', () => {
    const known = /^(raw|all|get|post|cookie|files|server|response|egress|rules)(\.|$)/;

    walk(allRules(), (r) => {
      expect(r.parameter, `unknown source: ${r.parameter}`).toMatch(known);
    });
  });

  it('declares a phase whenever it screens something other than the request', () => {
    // The default is `request`. A shape that reads `egress.*` while defaulting to the request phase never
    // runs — and reports as shipped protection.
    for (const [id, s] of Object.entries(shapes)) {
      if (JSON.stringify(s.rule_v2).includes('"egress.')) {
        expect(s.phase, `${id} screens egress but does not declare the phase`).toBe('egress');
      }
    }
  });

  it('carries a stated reason and a false-positive assessment', () => {
    // A shape with no false-positive analysis is not reviewable: the benign cases above are only meaningful
    // against a claim about what the rule is expected to let through.
    for (const [id, s] of Object.entries(shapes)) {
      expect(s.why.length, `${id} must say why the shape is the anchor`).toBeGreaterThan(80);
      expect(s.falsePositiveRisk.length, `${id} must assess its false positives`).toBeGreaterThan(20);
    }
  });

  it('carries no advisory identifiers, version ranges, or coverage mapping', () => {
    // The boundary, asserted rather than trusted to review: this repository is public, and which advisories
    // are covered — with which affected ranges — is not a payload shape.
    const text = readFileSync(FIXTURE, 'utf8');

    expect(text).not.toMatch(/CVE-\d{4}-\d+/);
    expect(text).not.toMatch(/GHSA-[0-9a-z-]+/i);
    expect(text).not.toMatch(/affected[_-]?range/i);
    expect(text).not.toMatch(/"(introduced|fixed|last_affected)"/);
  });
});
