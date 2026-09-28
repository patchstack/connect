import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * The response the client receives is framed by what went out first: the status line and headers,
 * including `Content-Length`. The response phase can replace or rewrite the body at `end`, so those
 * have to describe the body that is actually sent — whether the application let Node write the head
 * implicitly or called `writeHead` itself.
 *
 * Driven over a real socket with two requests on one keep-alive connection, where each response's
 * framing has to be exactly right for the next one to be read.
 */

const emptyBundle = { firewall: [], whitelists: [], whitelist_keys: {} };
const SECRET = 'AKIAABCDEFGHIJKLMNOP';
const STACK = 'Error: boom\n    at handler (/srv/app/server.js:12:9)\n    at Layer.handle (/srv/app/node_modules/express/lib/router/layer.js:95:5)';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function serve(handler: Handler): Promise<number> {
  const protection = await createProtection({ rules: emptyBundle, mode: 'block', onError: () => {} });
  const guard = protection.node({ screenResponses: true });
  const server = createServer((req, res) => guard(req, res, () => handler(req, res)));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));

  return (server.address() as { port: number }).port;
}

interface Parsed {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Send `count` requests down one connection and split the raw bytes by each response's own framing. */
async function exchange(port: number, count: number): Promise<{ responses: Parsed[]; trailing: string }> {
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    let sent = 0;
    let quiet: NodeJS.Timeout | undefined;
    const next = () => {
      sent += 1;
      socket.write(`GET /r${sent} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: ${sent === count ? 'close' : 'keep-alive'}\r\n\r\n`);
    };
    socket.on('connect', next);
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      // One request at a time: the next one goes once the connection has been quiet for a moment, so
      // every byte that arrived before it belongs to the response for the current request.
      clearTimeout(quiet);
      if (sent < count) quiet = setTimeout(next, 100);
    });
    socket.on('end', () => resolve(Buffer.concat(chunks)));
    socket.on('error', reject);
    setTimeout(() => {
      socket.destroy();
      resolve(Buffer.concat(chunks));
    }, 3_000);
  });

  const responses: Parsed[] = [];
  let rest = raw.toString('latin1');
  while (rest.startsWith('HTTP/1.1 ')) {
    const headEnd = rest.indexOf('\r\n\r\n');
    if (headEnd === -1) break;
    const [statusLine, ...lines] = rest.slice(0, headEnd).split('\r\n');
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const at = line.indexOf(':');
      headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
    rest = rest.slice(headEnd + 4);
    let body: string;
    if (headers['content-length'] !== undefined) {
      const length = Number(headers['content-length']);
      body = rest.slice(0, length);
      rest = rest.slice(length);
    } else if (headers['transfer-encoding'] === 'chunked') {
      body = '';
      for (;;) {
        const lineEnd = rest.indexOf('\r\n');
        const size = parseInt(rest.slice(0, lineEnd), 16);
        rest = rest.slice(lineEnd + 2);
        if (!size) {
          rest = rest.slice(2);
          break;
        }
        body += rest.slice(0, size);
        rest = rest.slice(size + 2);
      }
    } else {
      body = rest;
      rest = '';
    }
    responses.push({ status: Number(statusLine!.split(' ')[1]), headers, body });
  }

  return { responses, trailing: rest };
}

/** Everything one request on its own connection produced, however it ended. */
function rawExchange(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1', () => socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
    let raw = '';
    socket.on('data', (chunk) => (raw += chunk.toString('latin1')));
    socket.on('close', () => resolve(raw));
    socket.on('error', () => resolve(raw));
  });
}

describe('the head describes the body that is sent', () => {
  it('when the application calls writeHead with a length and the body is withheld', async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(STACK) });
      res.end(STACK);
    });
    const { responses, trailing } = await exchange(port, 2);

    expect(trailing).toBe('');
    expect(responses).toHaveLength(2);
    for (const response of responses) {
      expect(response.body).not.toContain('/srv/app');
      expect(response.status).toBe(500);
    }
  });

  it('when the application calls writeHead with a length and the body is redacted', async () => {
    const payload = JSON.stringify({ k: SECRET });
    const port = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    });
    const { responses, trailing } = await exchange(port, 2);

    expect(trailing).toBe('');
    expect(responses).toHaveLength(2);
    for (const response of responses) {
      expect(response.body).not.toContain(SECRET);
      expect(response.status).toBe(200);
      expect(() => JSON.parse(response.body)).not.toThrow();
    }
  });

  it('when the application calls writeHead with no headers at all', async () => {
    const payload = JSON.stringify({ k: SECRET });
    const port = await serve((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.writeHead(201);
      res.end(payload);
    });
    const { responses, trailing } = await exchange(port, 2);

    expect(trailing).toBe('');
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    for (const response of responses) expect(response.body).not.toContain(SECRET);
  });

  it('when the application sets a length with setHeader and lets Node write the head', async () => {
    const payload = JSON.stringify({ k: SECRET });
    const port = await serve((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('content-length', Buffer.byteLength(payload));
      res.end(payload);
    });
    const { responses, trailing } = await exchange(port, 2);

    expect(trailing).toBe('');
    expect(responses).toHaveLength(2);
    for (const response of responses) expect(response.body).not.toContain(SECRET);
  });

  it('leaves an unchanged response exactly as the application wrote it', async () => {
    const payload = JSON.stringify({ ok: true });
    const port = await serve((_req, res) => {
      res.writeHead(202, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-app': 'kept' });
      res.end(payload);
    });
    const { responses, trailing } = await exchange(port, 2);

    expect(trailing).toBe('');
    expect(responses).toEqual([
      expect.objectContaining({ status: 202, body: payload, headers: expect.objectContaining({ 'x-app': 'kept', 'content-length': String(payload.length) }) }),
      expect.objectContaining({ status: 202, body: payload }),
    ]);
  });

  it('when the application flushes a head with a length, and the body would change', async () => {
    // The flush is honoured — the head goes when the application asks — and the length it declared
    // cannot describe a redacted body. The response is cut off rather than sent as the original.
    const payload = JSON.stringify({ k: SECRET });
    const port = await serve((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('content-length', Buffer.byteLength(payload));
      res.flushHeaders();
      res.end(payload);
    });
    const raw = await rawExchange(port);

    expect(raw).toMatch(/^HTTP\/1\.1 200/);
    expect(raw).not.toContain(SECRET);
  });

  it('when the application flushes a chunked head, the body is still redacted', async () => {
    const payload = JSON.stringify({ k: SECRET });
    const port = await serve((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.flushHeaders();
      res.end(payload);
    });
    const { responses, trailing } = await exchange(port, 2);

    expect(trailing).toBe('');
    expect(responses).toHaveLength(2);
    for (const response of responses) {
      expect(response.body).toContain('[REDACTED]');
      expect(response.body).not.toContain(SECRET);
    }
  });

  it('passes a body too large to screen through with the head the application gave it', async () => {
    const payload = 'x'.repeat(600 * 1024);
    const port = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': payload.length, 'x-app': 'kept' });
      res.write(payload.slice(0, 300 * 1024));
      res.end(payload.slice(300 * 1024));
    });
    const { responses, trailing } = await exchange(port, 2);

    expect(trailing).toBe('');
    expect(responses).toHaveLength(2);
    for (const response of responses) {
      expect(response.body.length).toBe(payload.length);
      expect(response.headers['x-app']).toBe('kept');
    }
  });

  it('when the application chose chunked framing and the body is withheld', async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' });
      res.end(STACK);
    });
    const { responses, trailing } = await exchange(port, 2);

    expect(trailing).toBe('');
    expect(responses).toHaveLength(2);
    for (const response of responses) {
      expect(response.status).toBe(500);
      expect(response.body).not.toContain('/srv/app');
      // One framing, not two.
      expect(response.headers['transfer-encoding'] === undefined || response.headers['content-length'] === undefined).toBe(true);
    }
  });

  it('when the application chose chunked framing and the body is redacted', async () => {
    const payload = JSON.stringify({ k: SECRET });
    const port = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' });
      res.end(payload);
    });
    const { responses, trailing } = await exchange(port, 2);

    expect(trailing).toBe('');
    for (const response of responses) {
      expect(response.body).not.toContain(SECRET);
      expect(response.headers['transfer-encoding'] === undefined || response.headers['content-length'] === undefined).toBe(true);
    }
  });

  it('when the application declared both a length and a transfer coding, the redacted body gets one', async () => {
    const payload = JSON.stringify({ k: SECRET });
    const port = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'transfer-encoding': 'chunked' });
      res.end(payload);
    });
    const { responses, trailing } = await exchange(port, 2);

    expect(trailing).toBe('');
    expect(responses).toHaveLength(2);
    for (const response of responses) {
      expect(response.body).not.toContain(SECRET);
      expect(response.headers['transfer-encoding']).toBeUndefined();
      expect(response.headers['content-length']).toBe(String(Buffer.byteLength(response.body)));
    }
  });

  it('keeps writeHead chainable', async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('plain');
    });
    const { responses } = await exchange(port, 1);

    expect(responses).toEqual([expect.objectContaining({ status: 200, body: 'plain' })]);
  });
});

describe('a body that changes after the head has already gone', () => {
  /** The accessors the response phase uses, with the head already on the wire. */
  function sentRes(chunked: boolean) {
    const written: string[] = [];
    let destroyed = false;

    return {
      statusCode: 200,
      headersSent: true,
      chunkedEncoding: chunked,
      getHeader: (name: string) => (name === 'content-type' ? 'application/json' : undefined),
      getHeaders: () => ({ 'content-type': 'application/json' }),
      setHeader() {
        throw new Error('ERR_HTTP_HEADERS_SENT');
      },
      removeHeader() {
        throw new Error('ERR_HTTP_HEADERS_SENT');
      },
      writeHead() {
        throw new Error('ERR_HTTP_HEADERS_SENT');
      },
      write(chunk: unknown) {
        written.push(String(chunk));

        return true;
      },
      end(chunk?: unknown) {
        if (chunk !== undefined && typeof chunk !== 'function') written.push(String(chunk));

        return this;
      },
      destroy() {
        destroyed = true;
      },
      get written() {
        return written.join('');
      },
      get destroyed() {
        return destroyed;
      },
    };
  }

  async function respond(res: ReturnType<typeof sentRes>, body: string, extra: Record<string, unknown> = {}) {
    const protection = await createProtection({ rules: emptyBundle, mode: 'block', onError: () => {}, ...extra });
    const req = { method: 'GET', url: '/', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    await new Promise<void>((resolve) => {
      protection.express({ screenResponses: true })(req as never, res as never, () => {
        (res as unknown as { end(b: string): void }).end(body);
        resolve();
      });
    });
  }

  it('is cut off rather than sent under a length it does not have', async () => {
    const res = sentRes(false);
    await respond(res, JSON.stringify({ k: SECRET }));

    expect(res.destroyed).toBe(true);
    expect(res.written).not.toContain(SECRET);
  });

  it('is still redacted when the response is chunked and no length was promised', async () => {
    const res = sentRes(true);
    await respond(res, JSON.stringify({ k: SECRET }));

    expect(res.destroyed).toBe(false);
    expect(res.written).toContain('[REDACTED]');
    expect(res.written).not.toContain(SECRET);
  });

  it('says so when a header value cannot follow a head that has gone', async () => {
    const skips: Array<{ phase: string; reason: string }> = [];
    const res = sentRes(true);
    await respond(res, JSON.stringify({ k: SECRET }), {
      rules: {
        ...emptyBundle,
        firewall: [
          {
            id: 1,
            phase: 'response',
            action: 'set-header',
            set_headers: { 'x-screened': 'yes' },
            // Reads the body, so it is answered at `end` rather than before the head is sent.
            rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'AKIA' } }],
          },
        ],
      },
      onSkip: (skip: { phase: string; reason: string }) => skips.push(skip),
    });

    expect(res.written).not.toContain(SECRET);
    expect(skips).toContainEqual(expect.objectContaining({ phase: 'response', reason: 'headers-sent' }));
  });

  it('is cut off when it would be withheld, because the status already went out', async () => {
    const res = sentRes(true);
    await respond(res, STACK);

    expect(res.destroyed).toBe(true);
    expect(res.written).not.toContain('/srv/app');
  });
});

describe('a held head looks like a sent one', () => {
  // The same handler behind the guard and without it must be indistinguishable to the handler itself,
  // and produce the same response when nothing in it needs screening.
  const scenarios: Record<string, Handler> = {
    'the state writeHead leaves behind': (_req, res) => {
      res.writeHead(201, 'Made', { 'content-type': 'application/json' });
      res.end(JSON.stringify({ headersSent: res.headersSent, statusCode: res.statusCode, statusMessage: res.statusMessage }));
    },
    'a second writeHead': (_req, res) => {
      res.writeHead(201, { 'content-type': 'text/plain' });
      try {
        res.writeHead(202);
        res.end('second accepted');
      } catch (err) {
        res.end(`threw ${(err as NodeJS.ErrnoException).code}`);
      }
    },
    'setHeader after writeHead': (_req, res) => {
      res.writeHead(201, { 'content-type': 'text/plain' });
      try {
        res.setHeader('x-late', '1');
        res.end('accepted');
      } catch (err) {
        res.end(`threw ${(err as NodeJS.ErrnoException).code}`);
      }
    },
    'removeHeader after writeHead': (_req, res) => {
      res.setHeader('x-early', '1');
      res.writeHead(201, { 'content-type': 'text/plain' });
      try {
        res.removeHeader('x-early');
        res.end('accepted');
      } catch (err) {
        res.end(`threw ${(err as NodeJS.ErrnoException).code}`);
      }
    },
    'the reason phrase writeHead supplies by default': (_req, res) => {
      res.writeHead(201);
      res.end(String(res.statusMessage));
    },
    'an invalid status': (_req, res) => {
      try {
        res.writeHead(42);
        res.end('accepted');
      } catch (err) {
        res.statusCode = 200;
        res.end(`threw ${(err as NodeJS.ErrnoException).code}`);
      }
    },
    'an invalid header value': (_req, res) => {
      try {
        res.writeHead(200, { 'x-bad': 'a\nb' });
        res.end('accepted');
      } catch (err) {
        res.statusCode = 200;
        res.end(`threw ${(err as NodeJS.ErrnoException).code}`);
      }
    },
    'the header state writeHead leaves behind': (_req, res) => {
      res.setHeader('x-choice', 'before');
      res.setHeader('X-Kept', 'kept');
      res.writeHead(201, { 'x-choice': 'after', 'content-type': 'application/json' });
      res.end(JSON.stringify({ choice: res.getHeader('x-choice'), kept: res.getHeader('x-kept'), names: res.getHeaderNames().sort() }));
    },
    'writeHead headers with nothing set before': (_req, res) => {
      res.writeHead(201, { 'x-choice': 'after' });
      res.end(JSON.stringify({ choice: res.getHeader('x-choice') ?? null, names: res.getHeaderNames() }));
    },
    'a reason phrase set before writeHead': (_req, res) => {
      res.statusMessage = 'Mine';
      res.writeHead(201);
      res.end(String(res.statusMessage));
    },
    'writeHead then flushHeaders': (_req, res) => {
      res.writeHead(201, { 'content-type': 'text/plain' });
      res.flushHeaders();
      res.end('after flush');
    },
  };

  async function plain(handler: Handler): Promise<number> {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const previous = close;
    close = async () => {
      await previous?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };

    return (server.address() as { port: number }).port;
  }

  it.each(Object.keys(scenarios))('%s', async (name) => {
    const handler = scenarios[name]!;
    const [guarded] = (await exchange(await serve(handler), 1)).responses;
    const [unguarded] = (await exchange(await plain(handler), 1)).responses;

    expect(guarded).toBeDefined();
    expect({ status: guarded!.status, body: guarded!.body }).toEqual({ status: unguarded!.status, body: unguarded!.body });
    // What went out on the wire too, apart from the headers Node adds per response.
    const sent = (r: Parsed) => Object.fromEntries(Object.entries(r.headers).filter(([k]) => !['date', 'connection', 'keep-alive', 'transfer-encoding', 'content-length'].includes(k)));
    expect(sent(guarded!)).toEqual(sent(unguarded!));
  });
});

describe('an explicit flush', () => {
  it('sends the head when the application asks, not when the body ends', async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.flushHeaders();
      setTimeout(() => res.end('later'), 400);
    });
    const startedAt = Date.now();
    const firstByte = await new Promise<number>((resolve) => {
      const socket = connect(port, '127.0.0.1', () => socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
      socket.once('data', () => {
        resolve(Date.now() - startedAt);
        socket.destroy();
      });
    });

    expect(firstByte).toBeLessThan(300);
  });
});
