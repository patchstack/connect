import { describe, expect, it } from 'vitest';
import { RuleEngine } from '../../src/protect/engine/engine.js';
import { createProtection } from '../../src/protect/runtime.js';

// A `when.path` scope is what makes a generated per-endpoint rule safe to ship: it is the difference
// between shielding one vulnerable handler and inspecting the whole app. So the scope has to cover the
// requests that REACH that handler, and nothing else.
//
// The reference points below are measured, not assumed — raw sockets against Express 4.22, Express 5.2
// and Fastify 5, each with one handler registered on `/api/fetch`:
//
//     /api/fetch/      runs the handler on Express      404 on Fastify
//     /API/fetch       runs the handler on Express      404 on Fastify
//     /api/%66etch     404 on Express                   runs the handler on Fastify
//     /api//fetch      404 on both
//     /api/./fetch     404 on both
//     /api%2Ffetch     404 on both
//
// and, for the glob form, with one handler on `/admin/*`: `/admin/` runs it, `/admin` does not.

const RULE = (when: any) => ({
  id: 'scoped',
  title: 'scoped',
  when,
  rule_v2: [{ parameter: 'get.payload', match: { type: 'contains', value: 'boom' } }],
});

/** Does a rule scoped to `when` fire on this request? Asked through `evaluate`, the entry point the
 *  runtime uses — the scope is only worth what the caller applies, not what a helper computes. */
function fires(when: any, path: string, method = 'GET'): boolean {
  const url = `${path}?payload=boom`;
  return new RuleEngine({ firewall: [RULE(when)] }).evaluate({
    method,
    url,
    originalUrl: url,
    query: { payload: 'boom' },
    body: {},
    headers: { host: 'app.test' },
  }).blocked;
}

describe('when.path — the scope covers the endpoint it names', () => {
  it('fires on the path exactly as written', () => {
    expect(fires({ path: '/api/fetch' }, '/api/fetch')).toBe(true);
  });

  it('fires on the request forms that reach the same handler', () => {
    // Each of these runs the /api/fetch handler on a stock router, which makes each of them the
    // endpoint the scope names — coverage here is what makes a per-endpoint rule worth generating.
    expect(fires({ path: '/api/fetch' }, '/api/fetch/')).toBe(true); // trailing slash — Express
    expect(fires({ path: '/api/fetch' }, '/API/fetch')).toBe(true); // case — Express
    expect(fires({ path: '/api/fetch' }, '/api/%66etch')).toBe(true); // percent-encoded — Fastify
    expect(fires({ path: '/api/fetch' }, '/API/Fetch/')).toBe(true); // and in combination
  });

  it('does not fire on a different endpoint that merely contains the path', () => {
    // The shape this replaces — `contains` on server.REQUEST_URI — blocked every one of these.
    expect(fires({ path: '/api/fetch' }, '/api/fetchAll')).toBe(false); // sibling sharing the prefix
    expect(fires({ path: '/api/fetch' }, '/v2/api/fetch')).toBe(false); // mounted elsewhere
    expect(fires({ path: '/api/fetch' }, '/api/fetch/deep')).toBe(false); // below it, a different route
    expect(fires({ path: '/api/fetch' }, '/profile')).toBe(false);
  });

  it('is not satisfied by the path appearing in the query string', () => {
    // `?next=/api/fetch` is ordinary application traffic (a redirect target). Under a URI-substring
    // scope it dragged an unrelated endpoint into a blocking rule, which any third party could trigger.
    const url = '/profile?next=/api/fetch&payload=boom';
    const verdict = new RuleEngine({ firewall: [RULE({ path: '/api/fetch' })] }).evaluate({
      method: 'GET',
      url,
      originalUrl: url,
      query: { next: '/api/fetch', payload: 'boom' },
      body: {},
      headers: { host: 'app.test' },
    });
    expect(verdict.blocked).toBe(false);
  });

  it('keeps the payload condition doing the work, not the scope', () => {
    // The negative control. Without it, a scope that matched everything would pass every test above.
    const url = '/api/fetch?payload=harmless';
    expect(
      new RuleEngine({ firewall: [RULE({ path: '/api/fetch' })] }).evaluate({
        method: 'GET',
        url,
        originalUrl: url,
        query: { payload: 'harmless' },
        body: {},
        headers: { host: 'app.test' },
      }).blocked
    ).toBe(false);
  });

  it('leaves the root path comparable', () => {
    expect(fires({ path: '/' }, '/')).toBe(true);
    expect(fires({ path: '/' }, '/anything')).toBe(false);
  });

  it('neither loses nor widens the scope on a malformed escape', () => {
    // `%zz` is not a decodable escape. It must not throw its way into a dropped scope (the rule would
    // apply app-wide) nor decode into something that matches (the rule would cover a request no router
    // resolves). The target is compared as it stands.
    expect(fires({ path: '/api/fetch' }, '/api/fetch%zz')).toBe(false);
    expect(fires({ path: '/api/fetch%zz' }, '/api/fetch%zz')).toBe(true);
  });
});

describe('when.path — a path with a trailing slash is a path, not a regex', () => {
  it('scopes `/admin/` to /admin and nothing else', () => {
    // Slashes delimit the regex form and EVERY path starts with one, so `/admin/` used to compile to
    // the unanchored regex /admin/ and scope the rule to every path containing "admin".
    expect(fires({ path: '/admin/' }, '/admin')).toBe(true);
    expect(fires({ path: '/admin/' }, '/admin/')).toBe(true);
    expect(fires({ path: '/admin/' }, '/xadminy')).toBe(false);
    expect(fires({ path: '/admin/' }, '/admin/users')).toBe(false);
    expect(fires({ path: '/admin/' }, '/api/admin')).toBe(false);
  });

  it('reads a directory-shaped scope the same way with or without the slash', () => {
    for (const request of ['/api/v1', '/api/v1/', '/api/v1/users', '/other/api/v1']) {
      expect(fires({ path: '/api/v1/' }, request)).toBe(fires({ path: '/api/v1' }, request));
    }
  });

  it('still honours a pattern that actually uses regex syntax', () => {
    expect(fires({ path: '/^\\/admin(\\/|$)/' }, '/admin/users')).toBe(true);
    expect(fires({ path: '/^\\/admin(\\/|$)/' }, '/xadminy')).toBe(false);
    expect(fires({ path: '/(users|orders)/' }, '/api/orders')).toBe(true);
  });

  it('matches an author-written pattern against the target as it arrived', () => {
    // The escape hatch stays exact: the author chose the pattern and its flags, so the subject is not
    // folded underneath them. A case-insensitive scope is spelled with the `i` flag.
    expect(fires({ path: '/^\\/Admin$/' }, '/Admin')).toBe(true);
    expect(fires({ path: '/^\\/Admin$/' }, '/admin')).toBe(false);
    expect(fires({ path: '/^\\/Admin$/i' }, '/admin')).toBe(true);
  });
});

describe('when.path — the glob form', () => {
  it('covers the subtree and the bare directory that reaches the same handler', () => {
    // Measured: `/admin/` runs an Express handler registered at `/admin/*`.
    expect(fires({ path: '/admin/*' }, '/admin/users')).toBe(true);
    expect(fires({ path: '/admin/*' }, '/admin/')).toBe(true);
    expect(fires({ path: '/admin/*' }, '/ADMIN/users')).toBe(true);
  });

  it('does not spill onto a sibling that shares the prefix', () => {
    expect(fires({ path: '/admin/*' }, '/administrator/x')).toBe(false);
    expect(fires({ path: '/admin/*' }, '/xadminy')).toBe(false);
  });
});

describe('when.method — the scope the generated rule already knew', () => {
  it('fires only on the named method', () => {
    expect(fires({ path: '/api/import', method: 'POST' }, '/api/import', 'POST')).toBe(true);
    expect(fires({ path: '/api/import', method: 'POST' }, '/api/import', 'GET')).toBe(false);
    expect(fires({ path: '/api/import', method: ['POST', 'PUT'] }, '/api/import', 'PUT')).toBe(true);
  });
});

describe('the response phase scopes on the same reading', () => {
  it('folds the path there too', async () => {
    // Same helper, but reached through a different caller — worth asserting rather than assuming, since
    // a fold applied in one phase and not the other would redact on /admin and serve on /admin/.
    const rule = {
      phase: 'response',
      category: 'x',
      action: 'redact',
      when: { path: '/admin' },
      rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'topsecret' } }],
    };
    const p: any = await createProtection({
      rules: { firewall: [], whitelists: [], whitelist_keys: {} },
      responseRules: [rule],
      mode: 'block',
    });
    const body = () => new Response('x topsecret y', { status: 200, headers: { 'content-type': 'text/plain' } });
    const masked = await p.screenResponse(body(), new Request('https://app.test/ADMIN/', { method: 'GET' }));
    expect(/topsecret/.test(await masked.text())).toBe(false);
    const untouched = await p.screenResponse(body(), new Request('https://app.test/public', { method: 'GET' }));
    expect(/topsecret/.test(await untouched.text())).toBe(true);
  });
});
