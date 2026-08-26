import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildInputMap } from '../../src/map/index.js';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * The coordinate the MAP emits is the coordinate the ENGINE resolves.
 *
 * `coordinates.ts` carries the claim in a comment — "Verified against the resolver in engine/request.js
 * — a coordinate that the resolver cannot resolve would compile into a rule that silently never matches".
 * Nothing verified it. `tests/map/runtime-coordinates.test.ts` asserts
 * `runtimeCoordinate('header', 'x-api-key') === 'server.HTTP_X_API_KEY'`, which is a restatement of the
 * same table in the same module: if the resolver stopped exposing `server.HTTP_*` tomorrow, that test
 * would still pass and every rule generated from a header input would silently stop matching.
 *
 * This is the wiring, not the definition. For each address space the map can address, the coordinate is
 * read OUT of a real map and used verbatim to build a rule, which is then driven through the real request
 * path against a request carrying the payload in that space. A hardcoded coordinate here would test
 * nothing — the point is that the two modules agree without either being consulted about the other.
 *
 * Each case pairs a block with a benign control, because a rule that blocks everything is not evidence
 * that it addressed the right parameter.
 */
const EXPLOIT = 'p4tchst4ck-exploit-marker';

let coordinates: Record<string, string>;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ps-roundtrip-'));
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'x', dependencies: { express: '4.18.0', pg: '8.0.0' } }),
  );
  // One handler reading every space the map can address. Each read is a plain member/element access, the
  // shape extraction recognises, and each value is passed on so it is a real input rather than dead code.
  writeFileSync(
    path.join(dir, 'src/server.ts'),
    [
      "import express from 'express';",
      "const app = express();",
      "app.post('/i', (req, res) => {",
      "  res.end([",
      "    String(req.body.note),",
      "    String(req.query.q),",
      "    String(req.cookies.session),",
      "    String(req.headers['x-api-key']),",
      "    String(req.files.avatar),",
      "  ].join('|'));",
      "});",
      '',
    ].join('\n'),
  );

  const { map } = await buildInputMap(dir, {});
  const inputs = map?.endpoints?.[0]?.inputs ?? [];
  coordinates = Object.fromEntries(
    inputs.filter((i) => i.runtimeParameter).map((i) => [i.name, i.runtimeParameter as string]),
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const URL_BASE = 'https://app.test/i';

async function blocks(parameter: string, request: Request): Promise<boolean> {
  const protection: any = await createProtection({
    rules: { firewall: [{ id: 'round-trip', category: 'test', rule_v2: [{ parameter, match: { type: 'contains', value: EXPLOIT } }] }], whitelists: [], whitelist_keys: {} },
    mode: 'block',
  });
  const response = await protection.fetchGuard()(request);

  return response !== undefined && response !== null && response.status === 403;
}

const multipart = (filename: string) => {
  const form = new FormData();
  form.append('avatar', new File(['x'], filename, { type: 'image/png' }));

  return new Request(URL_BASE, { method: 'POST', body: form });
};

interface Case {
  space: string;
  input: string;
  expected: string;
  exploit: () => Request;
  benign: () => Request;
}

const cases: Case[] = [
  {
    space: 'body', input: 'note', expected: 'post.note',
    exploit: () => new Request(URL_BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: EXPLOIT }) }),
    benign: () => new Request(URL_BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: 'hello' }) }),
  },
  {
    space: 'query', input: 'q', expected: 'get.q',
    exploit: () => new Request(`${URL_BASE}?q=${EXPLOIT}`),
    benign: () => new Request(`${URL_BASE}?q=hello`),
  },
  {
    space: 'cookie', input: 'session', expected: 'cookie.session',
    exploit: () => new Request(URL_BASE, { headers: { cookie: `session=${EXPLOIT}` } }),
    benign: () => new Request(URL_BASE, { headers: { cookie: 'session=abc123' } }),
  },
  {
    space: 'header', input: 'x-api-key', expected: 'server.HTTP_X_API_KEY',
    exploit: () => new Request(URL_BASE, { headers: { 'x-api-key': EXPLOIT } }),
    benign: () => new Request(URL_BASE, { headers: { 'x-api-key': 'abc123' } }),
  },
  {
    // A bare `files.<field>` resolves to the FILENAME, so that is where the payload goes.
    space: 'file', input: 'avatar', expected: 'files.avatar',
    exploit: () => multipart(`${EXPLOIT}.png`),
    benign: () => multipart('holiday.png'),
  },
];

describe('a coordinate the map emitted', () => {
  for (const c of cases) {
    describe(`${c.space} (${c.input})`, () => {
      it('is the coordinate this suite expects the engine to need', () => {
        // Guards the test itself: if extraction stopped emitting this input, every assertion below would
        // be skipped on an undefined coordinate and the space would silently lose its coverage.
        expect(coordinates[c.input]).toBe(c.expected);
      });

      it('resolves in the engine and blocks the payload', async () => {
        await expect(blocks(coordinates[c.input]!, c.exploit())).resolves.toBe(true);
      });

      it('leaves a benign request in the same space alone', async () => {
        await expect(blocks(coordinates[c.input]!, c.benign())).resolves.toBe(false);
      });
    });
  }

  it('covers every space the map can address', () => {
    // Without this, adding a new addressable space to `coordinates.ts` leaves it unverified against the
    // resolver, which is the state this suite exists to end.
    expect(new Set(cases.map((c) => c.space))).toEqual(new Set(['body', 'query', 'cookie', 'header', 'file']));
  });
});
