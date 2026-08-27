import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildInputMap } from '../../src/map/index.js';
import { AUTO_PROMOTABLE_CONFIDENCE } from '../../src/map/capabilities.js';

/**
 * Deserialization that EXECUTES what it decodes is an `eval` sink.
 *
 * `eval` was in `SINK_KINDS` but only ever produced by globals — `eval(...)` and `new Function(...)`.
 * A package-backed one had no recognizer, so `node-serialize`'s `unserialize` produced NO sink and NO
 * flow, and the package reported `recognizedSinkKinds: []`.
 *
 * The map was honest about that ("no model of this API"), but it meant the flagship CVE-2017-5941 case
 * could not be expressed at all: the input was found, the import was found, and nothing connected them.
 * A consumer could never grade that app as reachable, so no rule could be aimed at the parameter that
 * actually reaches the RCE.
 */
async function mapOf(files: Record<string, string>, deps: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ps-deser-'));
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: deps }));
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), body);
    }

    const { map } = await buildInputMap(dir, {});

    return map!;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const DEPS = { express: '4.18.2', 'node-serialize': '0.0.4' };

const NAMESPACE_FORM = `
  const express = require("express");
  const serialize = require("node-serialize");
  const app = express();

  app.post("/api/restore", (req, res) => {
    const state = serialize.unserialize(req.body.state);
    res.json({ restored: state });
  });

  module.exports = app;
`;

const DESTRUCTURED_FORM = `
  const express = require("express");
  const { unserialize } = require("node-serialize");
  const app = express();

  app.post("/api/restore", (req, res) => {
    res.json({ restored: unserialize(req.body.state) });
  });

  module.exports = app;
`;

describe('an unserialize call that request data reaches', () => {
  it.each([
    ['through the package namespace', NAMESPACE_FORM],
    ['through a destructured import', DESTRUCTURED_FORM],
  ])('is an eval sink %s', async (_label, source) => {
    const map = await mapOf({ 'src/server.js': source }, DEPS);
    const endpoint = map.endpoints[0]!;

    expect(endpoint.sinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'eval', package: 'node-serialize', op: 'unserialize' }),
      ]),
    );
  });

  it('yields a flow that can actually be compiled into a rule', async () => {
    // The whole point of the recognizer. Each of these is separately load-bearing: without the coordinate
    // there is nothing to pin a rule to, without the `code` role no mitigation family applies, and without
    // a proven tier a consumer must not act on it.
    const map = await mapOf({ 'src/server.js': NAMESPACE_FORM }, DEPS);
    const endpoint = map.endpoints[0]!;
    const flow = endpoint.flows.find((f) => f.sink.package === 'node-serialize')!;

    expect(flow).toBeDefined();
    expect(flow.inputId).toBe('post:state');
    expect(endpoint.inputs.find((i) => i.name === 'state')?.runtimeParameter).toBe('post.state');
    expect(flow.argumentRole).toBe('code');
    expect(flow.candidateFamily).toBe('code-injection');
    expect(flow.ruleGeneratable).toBe(true);
    expect(flow.ruleGeneratableReasons ?? []).toEqual([]);
  });

  it('lands on the one tier that may be promoted automatically', async () => {
    // `unserialize(req.body.state)` passes the parameter with nothing in between, so what reaches the sink
    // IS what arrived. That is the distinction between `exact-local` and `transformed-local`, and it is
    // what decides whether a generated rule may go straight to blocking.
    const map = await mapOf({ 'src/server.js': NAMESPACE_FORM }, DEPS);
    const flow = map.endpoints[0]!.flows.find((f) => f.sink.package === 'node-serialize')!;

    expect(flow.confidence).toBe(AUTO_PROMOTABLE_CONFIDENCE);
  });

  it('makes the package advertise that a dataflow question about it can be answered', async () => {
    // `recognizedSinkKinds: []` is the map saying "do not read my silence as unreachable". While that was
    // the answer for node-serialize, its vulnerabilities could only ever stay "needs review".
    const map = await mapOf({ 'src/server.js': NAMESPACE_FORM }, DEPS);

    expect(map.imports?.find((i) => i.package === 'node-serialize')?.recognizedSinkKinds).toEqual(['eval']);
  });
});

describe('what must NOT be recognized', () => {
  it('ignores a local function that merely shares the name', async () => {
    // Recognizing by method name alone is the classic false positive, and here it would be expensive: a
    // rule aimed at a parameter feeding an app's own `unserialize` helper blocks legitimate traffic while
    // protecting nothing. Recognition stays tied to a RESOLVED import.
    const map = await mapOf({
      'src/server.js': `
        const express = require("express");
        const { unserialize } = require("./codec");
        const app = express();

        app.post("/api/restore", (req, res) => {
          res.json({ restored: unserialize(req.body.state) });
        });

        module.exports = app;
      `,
      'src/codec.js': `
        // App code. Decodes; does not execute.
        exports.unserialize = (raw) => JSON.parse(Buffer.from(String(raw), "base64").toString("utf8"));
      `,
    }, { express: '4.18.2' });

    expect(map.endpoints[0]!.sinks.filter((s) => s.kind === 'eval')).toEqual([]);
  });

  it('ignores a LOCAL namespace whose method shares the name', async () => {
    // The member form needs its own case. The test above uses a destructured import, so it never reaches
    // the `serialize.unserialize(` path — dropping that path's package check left it passing, which is a
    // negative test passing for the wrong reason. An app with its own codec module used as a namespace is
    // the realistic shape.
    const map = await mapOf({
      'src/server.js': `
        const express = require("express");
        const codec = require("./codec");
        const app = express();

        app.post("/api/restore", (req, res) => {
          res.json({ restored: codec.unserialize(req.body.state) });
        });

        module.exports = app;
      `,
      'src/codec.js': `
        exports.unserialize = (raw) => JSON.parse(Buffer.from(String(raw), "base64").toString("utf8"));
      `,
    }, { express: '4.18.2' });

    expect(map.endpoints[0]!.sinks.filter((s) => s.kind === 'eval')).toEqual([]);
  });

  it('ignores an unserialize on a DIFFERENT, non-executing package', async () => {
    // The discriminating case for the package check, and not a contrived one: `php-serialize` exposes an
    // `unserialize` that decodes PHP's serialization format without executing JavaScript. Flagging it
    // would aim a code-injection rule at traffic that cannot execute anything.
    //
    // The local-module case above cannot pin this — a relative `require` resolves to no package at all, so
    // it fails a bare `b.pkg` check just as well as the real one. Only a resolved package that is NOT in
    // the recognized list separates "has a package" from "has a package whose API executes".
    const map = await mapOf({
      'src/server.js': `
        const express = require("express");
        const php = require("php-serialize");
        const app = express();

        app.post("/api/restore", (req, res) => {
          res.json({ restored: php.unserialize(req.body.state) });
        });

        module.exports = app;
      `,
    }, { express: '4.18.2', 'php-serialize': '4.1.1' });

    expect(map.endpoints[0]!.sinks.filter((s) => s.kind === 'eval')).toEqual([]);
    // And it is still reported as imported, with no capability claimed — the honest "no model" answer.
    expect(map.imports?.find((i) => i.package === 'php-serialize')?.recognizedSinkKinds).toEqual([]);
  });

  it('ignores a DIFFERENT method on the recognized package', async () => {
    // `serialize.serialize(input)` encodes; it does not execute. This is what pins the API set to
    // `unserialize` rather than "any method on a recognized package" — widening the set left every other
    // negative here still passing, because none of them called a real method on the real package.
    const map = await mapOf({
      'src/server.js': `
        const express = require("express");
        const serialize = require("node-serialize");
        const app = express();

        app.post("/api/save", (req, res) => {
          res.json({ blob: serialize.serialize(req.body.state) });
        });

        module.exports = app;
      `,
    }, DEPS);

    expect(map.endpoints[0]!.sinks.filter((s) => s.kind === 'eval')).toEqual([]);
  });

  it('does not treat JSON.parse as a deserialization sink', async () => {
    // It decodes without executing. Note this one cannot fail from the API set widening — `JSON` is a
    // global, not a resolved package binding — so the case above is what actually guards that. Kept
    // because `JSON.parse` on request data is ubiquitous and must stay off the eval list by construction.
    const map = await mapOf({
      'src/server.js': `
        const express = require("express");
        const app = express();

        app.post("/api/restore", (req, res) => {
          res.json({ restored: JSON.parse(req.body.state) });
        });

        module.exports = app;
      `,
    }, { express: '4.18.2' });

    expect(map.endpoints[0]!.sinks.filter((s) => s.kind === 'eval')).toEqual([]);
  });

  it('does not invent a sink from the import alone', async () => {
    // Imported and never called must stay imported-and-never-called: promoting it would make every
    // dependency look reachable, which is the failure mode on the opposite side from silence.
    const map = await mapOf({
      'src/server.js': `
        const express = require("express");
        const serialize = require("node-serialize");
        const app = express();

        app.post("/api/restore", (req, res) => res.json({ ok: true, has: typeof serialize }));

        module.exports = app;
      `,
    }, DEPS);

    expect(map.endpoints[0]!.sinks.filter((s) => s.kind === 'eval')).toEqual([]);
    // Still reported as imported, with the capability declared — the two questions stay separate.
    expect(map.imports?.find((i) => i.package === 'node-serialize')?.recognizedSinkKinds).toEqual(['eval']);
  });
});
