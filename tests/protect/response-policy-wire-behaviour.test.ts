import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';
import { DEFAULT_RESPONSE_RULES } from '../../src/protect/defaults.js';

/**
 * What each response policy leaves on the wire.
 *
 * `redact` masks the span a pattern matched, so the pattern's match has to BE the whole disclosure.
 * That holds for a credential with a grammar — prefix, alphabet, length — and not for a disclosure a
 * pattern can identify but not delimit: a trace, a database error, an exception dump, a private key
 * and a connection URI in free text.
 *
 * So the assertions here are about the response a client receives, named field by field. "The sample
 * is no longer present verbatim" is satisfied by masking one character of it, and by a body that was
 * never screened at all.
 *
 * Every credential is SYNTHETIC and assembled from parts, because a literal in a provider's live-key
 * shape is what secret scanning exists to find.
 */
const key = (...parts: string[]) => parts.join('');
const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.c2ln`;

const policy = (id: string) => {
  const rule = (DEFAULT_RESPONSE_RULES as any[]).find((candidate) => candidate.id === id);
  if (!rule) throw new Error(`no shipped policy named ${id}`);

  return rule;
};

/** Screen one body through one policy and report what the client would receive. */
async function wire(id: string, body: string, contentType = 'application/json') {
  const fired: string[] = [];
  const p: any = await createProtection({
    rules: { firewall: [], whitelists: [], whitelist_keys: {} },
    mode: 'block',
    responseRules: [policy(id)],
    onDetect: (event: any) => fired.push(String(event.rule?.id)),
  });
  try {
    const out = await p.screenResponse(
      new Response(body, { status: 200, headers: { 'content-type': contentType } }),
      new Request('https://app.test/', { method: 'GET' }),
    );

    return { matched: fired.length > 0, status: out.status, body: await out.text() };
  } finally {
    // The guard's documented lifecycle: a caller that made one releases it. Nothing here depends on
    // reporting, so leaving it out passes today — and would keep passing while leaking a timer if
    // reporting ever became part of what these guards start.
    await p.stop();
  }
}

const json = (value: unknown) => JSON.stringify(value);

describe('a credential with a grammar is masked, and the page still serves', () => {
  const atomic: Array<{ id: string; secret: string }> = [
    { id: 'resp-aws-access-key', secret: key('AKIA', 'IOSFODNN7EXAMPLE') },
    { id: 'resp-gcp-api-key', secret: key('AIza', 'SyD-1234567890abcdefghijklmnopqrstu') },
    { id: 'resp-vendor-api-key', secret: key('sk_', 'live_', '4eC39HqLyjWDarjtT1zdp7dc') },
    { id: 'resp-supabase-secret-key', secret: key('sb_', 'secret_', 'Xk9Lm2Qp7Rt4Vw8ZaB3cD6', '_', 'eF7hJ2kM') },
    { id: 'resp-supabase-service-role-key', secret: jwt({ role: 'service_role', iss: 'supabase' }) },
  ];

  it.each(atomic.map((c) => [c.id, c] as const))('%s', async (_id, testCase) => {
    const result = await wire(testCase.id, json({ note: 'keep me', secret: testCase.secret, also: 'keep me too' }));

    expect(result.matched, 'the policy did not fire').toBe(true);
    expect(result.status, 'the page was withheld rather than masked').toBe(200);

    // The whole credential, not a prefix of it: a mask covering its leading run still serves the rest.
    for (let take = 8; take <= testCase.secret.length; take++) {
      expect(result.body, `a ${take}-character run survived`).not.toContain(testCase.secret.slice(0, take));
      expect(result.body, `a ${take}-character tail survived`).not.toContain(testCase.secret.slice(-take));
    }

    // And the response around it is still the response.
    expect(result.body).toContain('keep me');
    expect(result.body).toContain('keep me too');
    expect(() => JSON.parse(result.body)).not.toThrow();
  });
});

describe('a private key is withheld', () => {
  const cases: Array<[string, string]> = [
    ['a complete PEM block', '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34keymaterial\n-----END RSA PRIVATE KEY-----'],
    ['CRLF line endings', '-----BEGIN RSA PRIVATE KEY-----\r\nMIIBOgIBAAJBAKj34keymaterial\r\n-----END RSA PRIVATE KEY-----'],
    ['no footer at all', '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34keymaterialtruncated'],
    ['an unlisted key type', '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIBOgIBAAJBAKj34keymaterial'],
    ['a bare marker', '-----BEGIN PRIVATE KEY-----'],
    // The label carries words AFTER `PRIVATE KEY`, which is the real ASCII-armored PGP form.
    ['a PGP private key block', '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQdGBGKkeymaterial\n-----END PGP PRIVATE KEY BLOCK-----'],
    ['a hyphenated unlisted label', '-----BEGIN X-CUSTOM-V2 PRIVATE KEY-----\nAAAAkeymaterial'],
    // The longest label the pattern accepts on either side: 32 characters.
    [
      'a label at the accepted boundary',
      `-----BEGIN ${'A'.repeat(32)}PRIVATE KEY${'B'.repeat(32)}-----\nMIIBkeymaterial`,
    ],
  ];

  it.each(cases)('%s', async (_why, pem) => {
    const result = await wire('resp-private-key', json({ pem }));

    expect(result.matched, 'the policy did not fire').toBe(true);
    expect(result.status, 'the key was served with the page').toBe(500);
    expect(result.body).not.toContain('keymaterial');
    expect(result.body).not.toContain('BEGIN');
    expect(result.body).toContain('withheld by Patchstack');
  });

  it.each([
    ['prose about private keys', 'Paste your private key into the field below. Private keys are never uploaded.'],
    ['a heading without a BEGIN line', 'Section 4: PRIVATE KEY handling'],
    ['a public key', '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq'],
    ['a certificate', '-----BEGIN CERTIFICATE-----\nMIIDXTCCAkWg'],
  ])('leaves %s alone', async (_why, text) => {
    const body = json({ help: text });
    const result = await wire('resp-private-key', body);

    expect(result.matched).toBe(false);
    expect(result.body).toBe(body);
  });

  it('does not match a label longer than the pattern accepts', () => {
    // Stated as a limitation rather than a guarantee: past 32 label characters this policy does not
    // fire, so a key behind such a label is served. `prefilter` still names `PRIVATE KEY`, so a wider
    // bound is a pattern change and nothing else.
    const pattern = policy('resp-private-key').rule_v2[0].match.value as string;

    expect(pattern).toContain('{0,32}');
    expect(new RegExp(pattern.slice(1, -1)).test(`-----BEGIN ${'A'.repeat(33)}PRIVATE KEY-----`)).toBe(false);
  });
});

describe('a credential-bearing database URL is withheld', () => {
  // The credentials are the first half of the disclosure; the host, port, database name and query are
  // the rest, and a URI's own grammar admits commas, parentheses and semicolons, so no end-of-URI
  // character class delimits one in free text. The response is therefore withheld rather than partly
  // rewritten.
  it.each([
    ['plain text', 'postgres://user:password@db.internal:5432/app?sslmode=require', 'text/plain'],
    ['inside JSON', json({ dsn: 'postgres://user:password@db.internal:5432/app?sslmode=require' }), 'application/json'],
    ['in prose inside parentheses', 'connect via (postgres://user:password@db.internal:5432/app) today', 'text/plain'],
    ['in prose before a comma', 'use postgres://user:password@db.internal:5432/app, then retry', 'text/plain'],
    ['a mongodb+srv URI', 'mongodb+srv://user:password@db.internal/app', 'text/plain'],
    ['twice in one body', 'first postgres://u1:p1@host-one/db1 second mysql://u2:p2@host-two/db2 end', 'text/plain'],
    // Every character below is legal raw in userinfo, so each of these is an ordinary DSN. A class
    // narrow enough to exclude them is a rule that stays silent on a live credential.
    ['a password holding a raw colon', json({ dsn: 'postgres://user:p:ss@db.internal/app' }), 'application/json'],
    ['a password holding several raw colons', json({ dsn: 'postgres://user:a:b:c:d@db.internal/app' }), 'application/json'],
    // A username cannot hold a raw colon — the first one is the separator — so it carries `%3A`.
    ['a username holding a percent-encoded colon', json({ dsn: 'postgres://user%3Aname:pw@db.internal/app' }), 'application/json'],
    ['a password holding a raw semicolon', json({ dsn: 'postgres://user:p;ss@db.internal/app' }), 'application/json'],
    ['a password holding a raw comma', json({ dsn: 'postgres://user:p,ss@db.internal/app' }), 'application/json'],
    ['a password holding raw parentheses', json({ dsn: 'postgres://user:p(1)ss@db.internal/app' }), 'application/json'],
    ['a password holding raw sub-delimiters', json({ dsn: "postgres://user:p!$&'*+=@db.internal/app" }), 'application/json'],
    ['percent-encoded credentials', json({ dsn: 'postgres://user%40corp:p%40ss%21@db.internal/app' }), 'application/json'],
    // Punctuation-joined text that parses as a credential URI: username `db.internal;contact`,
    // password `admin`, host `example.com`. Nothing distinguishes it from a leak, so it is withheld.
    ['text that parses as a credential URI', 'docs at postgres://db.internal;contact:admin@example.com', 'text/plain'],
  ] as Array<[string, string, string]>)('%s', async (_why, body, type) => {
    const result = await wire('resp-db-connection-string', body, type);

    expect(result.matched, 'the policy did not fire').toBe(true);
    expect(result.status, 'the URI was served with the page').toBe(500);
    expect(result.body).toBe(json({ error: 'Response withheld by Patchstack (sensitive data detected)' }));

    for (const residue of ['db.internal', '5432', 'sslmode', 'password', 'host-one', 'host-two']) {
      if (body.includes(residue)) {
        expect(result.body, `"${residue}" survived`).not.toContain(residue);
      }
    }
  });

  it('leaves a URL carrying no credentials alone', async () => {
    const body = json({ dsn: 'postgres://db.internal:5432/app' });
    const result = await wire('resp-db-connection-string', body);

    expect(result.matched).toBe(false);
    expect(result.body).toBe(body);
  });

  it('keeps the user/password separator unambiguous', () => {
    // The first raw colon separates username from password, so the username class must not admit one.
    // Asserted on the class contents, since that is the property — a colon anywhere inside the
    // username class makes the separator ambiguous, wherever in the class it sits. The engine's
    // expression guard accepts either form, so it does not cover this.
    const pattern = policy('resp-db-connection-string').rule_v2[0].match.value as string;
    const classes = pattern.match(/\[[^\]]*\]/g) ?? [];

    expect(classes, 'expected a username class and a password class').toHaveLength(2);

    const [username, password] = classes.map((cls) => cls.slice(1, -1));
    expect(username, 'a colon in the username class makes the separator ambiguous').not.toContain(':');
    expect(password, 'a password admits raw colons, and must still match').toContain(':');
  });

  it('screens a cap-sized adversarial candidate within the bound', () => {
    // A body of `a:a:a:…` with no `@` satisfies `prefilter` and reaches the regex. At the default
    // screening cap it has to complete well inside a request — and the cap is not the bound, since
    // `max_bytes` raises it and `bypass_limit` removes it.
    const pattern = policy('resp-db-connection-string').rule_v2[0].match.value as string;
    const expression = new RegExp(pattern.slice(1, pattern.lastIndexOf('/')), 'i');
    const body = `postgres://${'a:'.repeat((512 * 1024) / 2)}`;

    const started = process.hrtime.bigint();
    expect(expression.test(body)).toBe(false);
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

    expect(elapsed, `a 512KB candidate took ${elapsed.toFixed(1)}ms`).toBeLessThan(1000);
  });

  it('leaves the sentence around a public URL intact', async () => {
    const body = 'connect via (postgres://db.internal:5432/app) today, then retry';
    const result = await wire('resp-db-connection-string', body, 'text/plain');

    expect(result.matched).toBe(false);
    expect(result.body).toBe(body);
  });

  // A credential-free URL and a `:`/`@` elsewhere in the same body. Each of these carries a JSON
  // delimiter between the two, and a delimiter is outside the userinfo grammar — so a candidate cannot
  // run past it to reach the punctuation of an unrelated value and withhold a response that discloses
  // nothing.
  //
  // Only bodies whose separator is genuinely outside the grammar belong here. A body joined by a
  // semicolon, a comma or parentheses parses as a credential URI and is asserted above as a
  // disclosure; pinning one of those as safe would tell the rule to ignore a real one.
  it.each([
    [
      'a docs URL beside an email in another field',
      json({ docs: 'postgres://db.internal', contact: 'user@example.com' }),
      'application/json',
    ],
    [
      'a scheme in one field and a credential-shaped value in another',
      json({ a: 'postgres://user', b: 'password@example.com' }),
      'application/json',
    ],
    [
      'a docs URL and a mail address in one array',
      json({ links: ['redis://cache.internal', 'admin:root@example.com'] }),
      'application/json',
    ],
    [
      'a scheme and an address in one quoted string',
      json({ note: 'see postgres://db.internal, then mail user@example.com' }),
      'application/json',
    ],
    // Whitespace is outside the grammar too, so ordinary prose separates safely without a quote.
    ['prose separated by whitespace', 'see postgres://db.internal, then mail user@example.com', 'text/plain'],
  ] as Array<[string, string, string]>)('does not bridge %s', async (_why, body, type) => {
    const result = await wire('resp-db-connection-string', body, type);

    expect(result.matched, 'the policy fired on a body carrying no credentials').toBe(false);
    expect(result.status).toBe(200);
    expect(result.body).toBe(body);
  });

  it('still matches credentials carrying percent-encoded characters', async () => {
    // The other side of a positive grammar: a password whose special characters are percent-encoded,
    // which is how a URI carries them, must still be recognised.
    const body = json({ dsn: 'postgres://user%40corp:p%40ss%21@db.internal/app' });
    const result = await wire('resp-db-connection-string', body);

    expect(result.matched, 'the policy did not fire').toBe(true);
    expect(result.status).toBe(500);
    expect(result.body).not.toContain('db.internal');
  });
});

describe('a diagnostic disclosure is withheld, whole', () => {
  const cases: Array<{ id: string; why: string; body: string; type: string; residues: string[] }> = [
    {
      id: 'resp-stack-trace',
      why: 'a Node trace in a JSON error response',
      body: json({ error: 'TypeError: bad\n    at handler (/srv/app/index.js:42:15)\n    at next (/srv/app/router.js:9:3)' }),
      type: 'application/json',
      residues: ['index.js', 'router.js', '42:15', 'srv/app', 'TypeError'],
    },
    {
      id: 'resp-stack-trace',
      why: 'a Node trace in a text response',
      body: 'TypeError: bad\n    at handler (/srv/app/index.js:42:15)',
      type: 'text/plain',
      residues: ['index.js', '42:15', 'srv/app', 'TypeError'],
    },
    {
      id: 'resp-sql-error',
      why: 'a constraint violation',
      body: json({ error: 'SQLSTATE[23000]: duplicate key value violates unique constraint "users_email_unique"' }),
      type: 'application/json',
      residues: ['users_email_unique', 'duplicate key', 'SQLSTATE'],
    },
    {
      id: 'resp-exception-trace',
      why: 'a Python traceback',
      body: json({ error: 'Traceback (most recent call last):\n  File "app.py", line 42, in handler\n    raise ValueError("boom")' }),
      type: 'application/json',
      residues: ['app.py', 'line 42', 'ValueError', 'Traceback'],
    },
  ];

  it.each(cases.map((c) => [`${c.id}: ${c.why}`, c] as const))('%s', async (_label, testCase) => {
    const result = await wire(testCase.id, testCase.body, testCase.type);

    expect(result.matched, 'the policy did not fire').toBe(true);
    expect(result.status, 'the disclosure was served with the page').toBe(500);

    // Nothing of the disclosure: not the message, the file, the line, the query or a trailing frame.
    for (const residue of testCase.residues) {
      expect(result.body, `"${residue}" survived`).not.toContain(residue);
    }

    expect(result.body).toContain('withheld by Patchstack');
  });

  it.each([
    ['resp-stack-trace', json({ note: 'The meeting starts at 10:00 (room 4)' })],
    ['resp-sql-error', json({ error: 'The request could not be completed' })],
    ['resp-exception-trace', json({ note: 'System.out.println was called during startup' })],
  ] as Array<[string, string]>)('%s serves an ordinary response untouched', async (id, body) => {
    const result = await wire(id, body);

    expect(result.matched).toBe(false);
    expect(result.status).toBe(200);
    expect(result.body).toBe(body);
  });
});
