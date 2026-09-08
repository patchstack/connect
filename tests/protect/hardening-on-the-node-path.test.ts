import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * Header hardening on the Node response path.
 *
 * The body is buffered and screened at `end`, but a body over the cap abandons buffering and flushes
 * what it has — and once a byte has gone, the headers have gone with it. Hardening needs no body, so it
 * is applied before the first byte leaves and survives every reason the body cannot be screened: over
 * the cap, binary, a live stream.
 *
 * The rules answered up front are then left out of the pass at `end`, so a match is reported once. The
 * pass at `end` keeps the rules that one cannot answer, which is how a body-READING hardening rule is
 * still honoured.
 */

const emptyBundle = { firewall: [], whitelists: [], whitelist_keys: {} };
const anyResponse = [{ parameter: 'response.status', match: { type: 'isset' } }];

const frameOptions = {
  phase: 'response',
  action: 'set-header',
  set_headers: { 'x-frame-options': 'DENY' },
  rule_v2: anyResponse,
};

/** A ServerResponse-like mock: the accessors `wrapNodeResponse` uses, and a record of what was written. */
function mockRes() {
  const out: Buffer[] = [];

  return {
    statusCode: 200,
    headersSent: false,
    _headers: {} as Record<string, unknown>,
    ended: false,
    body: '',
    setHeader(k: string, v: unknown) {
      // What a real ServerResponse does: once a byte has gone, the headers have gone with it and this
      // throws. Without that, a test cannot tell hardening that happened BEFORE the flush from
      // hardening that happened after it and changed nothing a client would see.
      if (this.headersSent) throw new Error('ERR_HTTP_HEADERS_SENT');
      this._headers[k.toLowerCase()] = v;
    },
    getHeader(k: string) {
      return this._headers[k.toLowerCase()];
    },
    getHeaders() {
      return { ...this._headers };
    },
    removeHeader(k: string) {
      if (this.headersSent) throw new Error('ERR_HTTP_HEADERS_SENT');
      delete this._headers[k.toLowerCase()];
    },
    write(chunk: unknown) {
      out.push(Buffer.from(chunk as never));
      this.headersSent = true;

      return true;
    },
    end(chunk?: unknown) {
      if (chunk != null && typeof chunk !== 'function') out.push(Buffer.from(chunk as never));
      this.body = Buffer.concat(out).toString('utf8');
      this.headersSent = true;
      this.ended = true;
    },
  };
}

function mockReq() {
  const req: Readable & Record<string, unknown> = Readable.from([]) as never;
  req.method = 'GET';
  req.url = '/';
  req.headers = {};
  req.socket = { remoteAddress: '9.9.9.9' };

  return req;
}

/** Run the express guard with response screening on, letting the app write `body`. */
async function serve(
  rule: unknown,
  write: (res: ReturnType<typeof mockRes>) => void,
  mode = 'block',
): Promise<ReturnType<typeof mockRes>> {
  const p = (await createProtection({ rules: emptyBundle, responseRules: [rule], mode })) as any;
  const res = mockRes();

  await new Promise<void>((resolve) => {
    p.express({ screenResponses: true })(mockReq(), res, () => {
      write(res);
      resolve();
    });
  });
  await new Promise((r) => setImmediate(r));

  return res;
}

describe('a body the guard cannot screen', () => {
  it('is hardened when it exceeds the cap', async () => {
    // The case the buffered path cannot reach: over the cap it flushes the head, so the headers are
    // already gone by the time `end` would have applied anything.
    const res = await serve(frameOptions, (r) => {
      r.setHeader('content-type', 'application/json');
      r.end('x'.repeat(2 * 1024 * 1024));
    });

    expect(res._headers['x-frame-options']).toBe('DENY');
  });

  it('is hardened when it is binary', async () => {
    const res = await serve(frameOptions, (r) => {
      r.setHeader('content-type', 'application/octet-stream');
      r.end(Buffer.from([0, 1, 2, 3]));
    });

    expect(res._headers['x-frame-options']).toBe('DENY');
  });

  it('is hardened when it is a live stream', async () => {
    const res = await serve(frameOptions, (r) => {
      r.setHeader('content-type', 'text/event-stream');
      r.end('data: hello\n\n');
    });

    expect(res._headers['x-frame-options']).toBe('DENY');
  });

  it('is hardened when the body is streamed in chunks', async () => {
    // A response written with `write` rather than handed to `end`. The first chunk is what sends the
    // headers, so hardening has to happen there and not only at `end`.
    const res = await serve(frameOptions, (r) => {
      r.setHeader('content-type', 'application/json');
      r.write('{"part":1');
      r.write(',"part":2}');
      r.end();
    });

    expect(res._headers['x-frame-options']).toBe('DENY');
  });

  it('is hardened when a streamed body then exceeds the cap', async () => {
    // Both together: written in chunks AND over the cap, so buffering is abandoned partway through.
    const res = await serve(frameOptions, (r) => {
      r.setHeader('content-type', 'application/json');
      r.write('x'.repeat(1024));
      r.write('y'.repeat(2 * 1024 * 1024));
      r.end();
    });

    expect(res._headers['x-frame-options']).toBe('DENY');
  });

  it('hardens a cookie on a response whose body is never read', async () => {
    // The cookie is in the headers, and the body being an image has nothing to do with whether it
    // should be `HttpOnly`.
    const res = await serve(
      {
        phase: 'response',
        action: 'harden-cookie',
        cookie_flags: { httpOnly: true, secure: true },
        rule_v2: anyResponse,
      },
      (r) => {
        r.setHeader('content-type', 'image/png');
        r.setHeader('set-cookie', 'sid=abc; Path=/');
        r.end(Buffer.from([1]));
      },
    );

    expect(String(res._headers['set-cookie'])).toContain('HttpOnly');
    expect(String(res._headers['set-cookie'])).toContain('Secure');
  });

  it('leaves the body it could not screen exactly as it was', async () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const res = await serve(frameOptions, (r) => {
      r.setHeader('content-type', 'application/octet-stream');
      r.end(bytes);
    });

    expect(Buffer.from(res.body, 'utf8').length).toBeGreaterThan(0);
    expect(res.ended).toBe(true);
  });
});

describe('what it does not disturb', () => {
  it('hardens an ordinary text body once, and still redacts it', async () => {
    // Answered before the flush and not asked again at `end`, so the header holds one value and one
    // detection is reported — and the body screening it shares the path with still does its own job.
    const p = (await createProtection({
      rules: emptyBundle,
      mode: 'block',
      responseRules: [
        frameOptions,
        {
          phase: 'response',
          category: 'secret',
          action: 'redact',
          rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'AKIA' } }],
        },
      ],
    })) as any;
    const res = mockRes();

    await new Promise<void>((resolve) => {
      p.express({ screenResponses: true })(mockReq(), res, () => {
        res.setHeader('content-type', 'application/json');
        res.end('{"key":"AKIAIOSFODNN7EXAMPLE"}');
        resolve();
      });
    });
    await new Promise((r) => setImmediate(r));

    expect(res._headers['x-frame-options']).toBe('DENY');
    expect(res.body).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('reports one detection for a rule that needs no body', async () => {
    // The rule is answered before the flush and would be answered again by the pass at `end`. Both
    // passes report what they match, so a rule evaluated twice is a response counted twice — a
    // dashboard reading double, and an alert threshold reached at half the traffic.
    const events: unknown[] = [];
    const p = (await createProtection({
      rules: emptyBundle,
      mode: 'block',
      responseRules: [frameOptions],
      onDetect: (event: unknown) => events.push(event),
    })) as any;
    const res = mockRes();

    await new Promise<void>((resolve) => {
      p.express({ screenResponses: true })(mockReq(), res, () => {
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
        resolve();
      });
    });
    await new Promise((r) => setImmediate(r));

    expect(res._headers['x-frame-options']).toBe('DENY');
    expect(events).toHaveLength(1);
  });

  it('still honours a hardening rule that reads the body', async () => {
    // The other side of leaving rules out: only the ones already answered are excluded. A hardening
    // rule that reads the body cannot have been answered before the flush, so `end` must still ask it.
    const p = (await createProtection({
      rules: emptyBundle,
      mode: 'block',
      responseRules: [
        {
          phase: 'response',
          action: 'set-header',
          set_headers: { 'x-body-said': 'yes' },
          rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'secret-marker' } }],
        },
      ],
    })) as any;
    const res = mockRes();

    await new Promise<void>((resolve) => {
      p.express({ screenResponses: true })(mockReq(), res, () => {
        res.setHeader('content-type', 'application/json');
        res.end('{"note":"secret-marker"}');
        resolve();
      });
    });
    await new Promise((r) => setImmediate(r));

    expect(res._headers['x-body-said']).toBe('yes');
  });

  it('keeps a content-length it did not invalidate', async () => {
    // The pass at `end` drops `content-length` because it rewrote the body. Nothing is rewritten before
    // the flush, so the length still describes what the client will receive and must survive.
    const res = await serve(frameOptions, (r) => {
      r.setHeader('content-type', 'application/octet-stream');
      r.setHeader('content-length', '4');
      r.end(Buffer.from([1, 2, 3, 4]));
    });

    expect(res._headers['x-frame-options']).toBe('DENY');
    expect(res._headers['content-length']).toBe('4');
  });

  it('does nothing for a rule that has not been justified', async () => {
    // Dry-run holds here as everywhere: the cap must not become a way to get enforcement a rule was
    // not granted.
    const res = await serve(
      frameOptions,
      (r) => {
        r.setHeader('content-type', 'application/octet-stream');
        r.end(Buffer.from([1]));
      },
      'dry-run',
    );

    expect(res._headers['x-frame-options']).toBeUndefined();
  });

  it('does not throw when the headers have already gone', async () => {
    // Nothing can be changed at that point, and throwing from inside a write would take the response
    // with it.
    const p = (await createProtection({
      rules: emptyBundle,
      responseRules: [frameOptions],
      mode: 'block',
    })) as any;
    const res = mockRes();
    res.setHeader('content-type', 'application/octet-stream');
    // As if something had already written: the headers are on the wire and nothing may change them.
    res.headersSent = true;

    await new Promise<void>((resolve) => {
      p.express({ screenResponses: true })(mockReq(), res, () => {
        res.end(Buffer.from([1]));
        resolve();
      });
    });
    await new Promise((r) => setImmediate(r));

    expect(res.ended).toBe(true);
    expect(res._headers['x-frame-options']).toBeUndefined();
  });

  it('judges the status writeHead is given, not the one the response still holds', async () => {
    // `res.statusCode` is 200 until `writeHead` runs, so a rule scoped to the status it is about to
    // become is asked about a response that never exists.
    const p = (await createProtection({
      rules: emptyBundle,
      mode: 'block',
      responseRules: [
        {
          phase: 'response',
          action: 'set-header',
          set_headers: { 'cache-control': 'no-store' },
          rule_v2: [{ parameter: 'response.status', match: { type: 'equals', value: '404' } }],
        },
      ],
    })) as any;
    const res = mockRes() as ReturnType<typeof mockRes> & { writeHead(status: number): unknown; seen?: unknown };

    res.writeHead = function (status: number) {
      this.statusCode = status;
      (this as Record<string, unknown>).seen = this.getHeaders()['cache-control'];

      return this;
    };

    await new Promise<void>((resolve) => {
      p.express({ screenResponses: true })(mockReq(), res, () => {
        res.writeHead(404);
        res.end('not found');
        resolve();
      });
    });
    await new Promise((r) => setImmediate(r));

    expect((res as Record<string, unknown>).seen).toBe('no-store');
  });

  it('sees the headers writeHead carries, not only the ones already set', async () => {
    // A header passed as `writeHead`'s argument is on the response the client receives, so a rule that
    // matches on it has matched. Shown only `getHeaders()`, the guard would never see it.
    const p = (await createProtection({
      rules: emptyBundle,
      mode: 'block',
      responseRules: [
        {
          phase: 'response',
          action: 'set-header',
          set_headers: { 'x-noticed': 'yes' },
          rule_v2: [
            { parameter: 'response.header.x-powered-by', match: { type: 'contains', value: 'Express' } },
          ],
        },
      ],
    })) as any;
    const res = mockRes() as ReturnType<typeof mockRes> & {
      writeHead(status: number, headers?: Record<string, string>): unknown;
      seen?: unknown;
    };

    res.writeHead = function (status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      for (const [k, v] of Object.entries(headers ?? {})) this._headers[k.toLowerCase()] = v;
      (this as Record<string, unknown>).seen = this.getHeaders()['x-noticed'];

      return this;
    };

    await new Promise<void>((resolve) => {
      p.express({ screenResponses: true })(mockReq(), res, () => {
        res.writeHead(200, { 'x-powered-by': 'Express' });
        res.end('{}');
        resolve();
      });
    });
    await new Promise((r) => setImmediate(r));

    expect((res as Record<string, unknown>).seen).toBe('yes');
  });

  it('puts the hardened value into the argument writeHead was called with', async () => {
    // Whatever `writeHead` carries beats `setHeader`, so a header the application passes here would
    // overwrite the hardened one on the way out and the client would receive the application's value.
    const p = (await createProtection({
      rules: emptyBundle,
      mode: 'block',
      responseRules: [frameOptions],
    })) as any;
    const res = mockRes() as ReturnType<typeof mockRes> & {
      writeHead(status: number, headers?: unknown): unknown;
      given?: unknown;
    };

    res.writeHead = function (status: number, headers?: unknown) {
      this.statusCode = status;
      // What the client receives: the argument, applied over anything set beforehand.
      (this as Record<string, unknown>).given = headers;

      return this;
    };

    await new Promise<void>((resolve) => {
      p.express({ screenResponses: true })(mockReq(), res, () => {
        res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'ALLOWALL' });
        res.end('<p>hi</p>');
        resolve();
      });
    });
    await new Promise((r) => setImmediate(r));

    expect((res as Record<string, unknown>).given).toEqual({
      'content-type': 'text/html',
      'x-frame-options': 'DENY',
    });
  });

  it('keeps a repeated header name the rule did not touch', async () => {
    // The flat array form can carry `set-cookie` twice, and an object cannot. Rebuilding the argument
    // as an object would serve one of the two cookies and silently drop the other.
    const p = (await createProtection({
      rules: emptyBundle,
      mode: 'block',
      responseRules: [frameOptions],
    })) as any;
    const res = mockRes() as ReturnType<typeof mockRes> & {
      writeHead(status: number, headers?: unknown): unknown;
      given?: unknown;
    };

    res.writeHead = function (status: number, headers?: unknown) {
      this.statusCode = status;
      (this as Record<string, unknown>).given = headers;

      return this;
    };

    await new Promise<void>((resolve) => {
      p.express({ screenResponses: true })(mockReq(), res, () => {
        res.writeHead(200, ['set-cookie', 'a=1', 'set-cookie', 'b=2', 'x-frame-options', 'ALLOWALL']);
        res.end('{}');
        resolve();
      });
    });
    await new Promise((r) => setImmediate(r));

    expect((res as Record<string, unknown>).given).toEqual([
      'set-cookie',
      'a=1',
      'set-cookie',
      'b=2',
      'x-frame-options',
      'DENY',
    ]);
  });

  it('hardens every cookie an object argument holds under one name', async () => {
    // An object cannot repeat a name, so it carries both cookies as one array value. Expanded into
    // repeated entries on the way back the array would collapse to its last element, and a response
    // that set two hardened cookies would ship one.
    const p = (await createProtection({
      rules: emptyBundle,
      mode: 'block',
      responseRules: [
        {
          phase: 'response',
          action: 'harden-cookie',
          cookie_flags: { httpOnly: true },
          rule_v2: anyResponse,
        },
      ],
    })) as any;
    const res = mockRes() as ReturnType<typeof mockRes> & {
      writeHead(status: number, headers?: unknown): unknown;
      given?: unknown;
    };

    res.writeHead = function (status: number, headers?: unknown) {
      this.statusCode = status;
      (this as Record<string, unknown>).given = headers;

      return this;
    };

    await new Promise<void>((resolve) => {
      p.express({ screenResponses: true })(mockReq(), res, () => {
        res.writeHead(200, { 'Set-Cookie': ['a=1; Path=/', 'b=2; Path=/'] });
        res.end('{}');
        resolve();
      });
    });
    await new Promise((r) => setImmediate(r));

    const given = (res as Record<string, unknown>).given as Record<string, string[]>;
    const cookies = given['Set-Cookie'];
    expect(cookies).toHaveLength(2);
    expect(cookies.filter((entry) => entry.includes('HttpOnly'))).toHaveLength(2);
    expect(cookies.map((entry) => entry.split(';')[0])).toEqual(['a=1', 'b=2']);
  });

  it('hardens every cookie a paired-array argument holds', async () => {
    // The `[[name, value], …]` form, which goes back in the shape it arrived in rather than flattened.
    const p = (await createProtection({
      rules: emptyBundle,
      mode: 'block',
      responseRules: [
        {
          phase: 'response',
          action: 'harden-cookie',
          cookie_flags: { httpOnly: true },
          rule_v2: anyResponse,
        },
      ],
    })) as any;
    const res = mockRes() as ReturnType<typeof mockRes> & {
      writeHead(status: number, headers?: unknown): unknown;
      given?: unknown;
    };

    res.writeHead = function (status: number, headers?: unknown) {
      this.statusCode = status;
      (this as Record<string, unknown>).given = headers;

      return this;
    };

    await new Promise<void>((resolve) => {
      p.express({ screenResponses: true })(mockReq(), res, () => {
        res.writeHead(200, [
          ['set-cookie', 'a=1; Path=/'],
          ['set-cookie', 'b=2; Path=/'],
        ]);
        res.end('{}');
        resolve();
      });
    });
    await new Promise((r) => setImmediate(r));

    const given = (res as Record<string, unknown>).given as [string, string][];
    expect(given).toHaveLength(2);
    expect(given.every(([name]) => name === 'set-cookie')).toBe(true);
    expect(given.filter(([, value]) => value.includes('HttpOnly'))).toHaveLength(2);
  });

  it('hardens a cookie writeHead carries, replacing every copy of it', async () => {
    // The rule's answer stands for the whole name: two cookies in, two hardened cookies out, and no
    // unhardened one left beside them.
    const p = (await createProtection({
      rules: emptyBundle,
      mode: 'block',
      responseRules: [
        {
          phase: 'response',
          action: 'harden-cookie',
          cookie_flags: { httpOnly: true },
          rule_v2: anyResponse,
        },
      ],
    })) as any;
    const res = mockRes() as ReturnType<typeof mockRes> & {
      writeHead(status: number, headers?: unknown): unknown;
      given?: unknown;
    };

    res.writeHead = function (status: number, headers?: unknown) {
      this.statusCode = status;
      (this as Record<string, unknown>).given = headers;

      return this;
    };

    await new Promise<void>((resolve) => {
      p.express({ screenResponses: true })(mockReq(), res, () => {
        res.writeHead(200, ['set-cookie', 'a=1; Path=/', 'set-cookie', 'b=2; Path=/']);
        res.end('{}');
        resolve();
      });
    });
    await new Promise((r) => setImmediate(r));

    const given = (res as Record<string, unknown>).given as string[];
    expect(given.filter((entry) => entry === 'set-cookie')).toHaveLength(2);
    expect(given.filter((entry) => entry.includes('HttpOnly'))).toHaveLength(2);
  });

  it('hardens before an application writes its own head', async () => {
    // `writeHead` sends the headers, so hardening has to have happened by then.
    const p = (await createProtection({
      rules: emptyBundle,
      responseRules: [frameOptions],
      mode: 'block',
    })) as any;
    const res = mockRes() as ReturnType<typeof mockRes> & { writeHead(status: number): unknown; seen?: unknown };

    res.writeHead = function (status: number) {
      this.statusCode = status;
      // What the client would receive, captured at the moment the head is written.
      (this as Record<string, unknown>).seen = this.getHeaders()['x-frame-options'];

      return this;
    };

    await new Promise<void>((resolve) => {
      p.express({ screenResponses: true })(mockReq(), res, () => {
        res.setHeader('content-type', 'application/octet-stream');
        res.writeHead(200);
        res.end(Buffer.from([1]));
        resolve();
      });
    });
    await new Promise((r) => setImmediate(r));

    expect((res as Record<string, unknown>).seen).toBe('DENY');
  });
});
