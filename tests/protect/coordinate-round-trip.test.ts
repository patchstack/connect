import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildInputMap } from '../../src/map/index.js';
import { createProtection } from '../../src/protect/runtime.js';
import { INPUT_SOURCES } from '../../src/map/capabilities.js';
import { runtimeCoordinate } from '../../src/map/coordinates.js';

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

// Hand-built rather than `new FormData()` + `new File()`: global `File` only exists from Node 20, and
// this package supports 18 — the convenient version passed locally and failed one matrix leg with
// `File is not defined`, which is a test silently covering less than it claims on the oldest runtime it
// is meant to protect. The wire format is stable and short enough to write out.
const BOUNDARY = '----psFieldBoundary7MA4YWxkTrZu0gW';
const multipart = (filename: string) => {
  const body = [
    `--${BOUNDARY}`,
    `Content-Disposition: form-data; name="avatar"; filename="${filename}"`,
    'Content-Type: image/png',
    '',
    'x',
    `--${BOUNDARY}--`,
    '',
  ].join('\r\n');

  return new Request(URL_BASE, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    body,
  });
};

interface Case {
  /** The `InputSource` this case drives, so coverage can be compared against the vocabulary. */
  source: (typeof INPUT_SOURCES)[number];
  input: string;
  expected: string;
  exploit: () => Request;
  benign: () => Request;
}

const cases: Case[] = [
  {
    source: 'body', input: 'note', expected: 'post.note',
    exploit: () => new Request(URL_BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: EXPLOIT }) }),
    benign: () => new Request(URL_BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: 'hello' }) }),
  },
  {
    source: 'query', input: 'q', expected: 'get.q',
    exploit: () => new Request(`${URL_BASE}?q=${EXPLOIT}`),
    benign: () => new Request(`${URL_BASE}?q=hello`),
  },
  {
    source: 'cookie', input: 'session', expected: 'cookie.session',
    exploit: () => new Request(URL_BASE, { headers: { cookie: `session=${EXPLOIT}` } }),
    benign: () => new Request(URL_BASE, { headers: { cookie: 'session=abc123' } }),
  },
  {
    source: 'header', input: 'x-api-key', expected: 'server.HTTP_X_API_KEY',
    exploit: () => new Request(URL_BASE, { headers: { 'x-api-key': EXPLOIT } }),
    benign: () => new Request(URL_BASE, { headers: { 'x-api-key': 'abc123' } }),
  },
  {
    // A bare `files.<field>` resolves to the FILENAME, so that is where the payload goes.
    source: 'file', input: 'avatar', expected: 'files.avatar',
    exploit: () => multipart(`${EXPLOIT}.png`),
    benign: () => multipart('holiday.png'),
  },
];

describe('a coordinate the map emitted', () => {
  for (const c of cases) {
    describe(`${c.source} (${c.input})`, () => {
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

  it('covers every source the map can address, derived from the vocabulary', () => {
    // The previous version compared one hard-coded set against another hard-coded set, so it asserted that
    // this file agreed with itself. A sixth addressable source would not have failed it — which is exactly
    // the gap it was written to close.
    //
    // The expectation is now computed from production: a source is addressable when `runtimeCoordinate`
    // yields a parameter for it, and every addressable source must have a case here. Adding one to
    // `INPUT_SOURCES` and giving it a coordinate now fails this until it is driven through the engine.
    const addressable = INPUT_SOURCES.filter(
      (source) => runtimeCoordinate(source, 'field').runtimeParameter !== null,
    );
    const covered = new Set(cases.map((c) => c.source));

    // The body-shaped sources all resolve to `post.<path>`, so one case covers them; asserted explicitly
    // rather than assumed, because a divergence would otherwise hide behind the grouping.
    const bodyShaped = ['json-body', 'form-body', 'multipart', 'body', 'server-fn-data'] as const;
    for (const source of bodyShaped) {
      expect(runtimeCoordinate(source, 'field').runtimeParameter).toBe('post.field');
    }

    const needsItsOwnCase = addressable.filter((s) => !bodyShaped.includes(s as never));
    expect(new Set([...needsItsOwnCase, 'body'])).toEqual(covered);

    // And the unaddressable ones stay unaddressable: a coordinate appearing for a route parameter would
    // compile a rule the resolver cannot resolve, which is the failure this whole file is about.
    for (const source of INPUT_SOURCES.filter((s) => !addressable.includes(s))) {
      expect(runtimeCoordinate(source, 'field').runtimeParameter).toBeNull();
      expect(runtimeCoordinate(source, 'field').runtimeParameterReason).toBeTruthy();
    }
  });
});
