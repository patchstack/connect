import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildInputMap } from '../../src/map/index.js';

/**
 * A sink reached through one helper hop: what the map says about it, and why that is enough.
 *
 * `sinksFrom` follows one hop — into a same-file helper and into a relative-imported one — so the SINK is
 * found. Its call site is in the helper, so there is no argument in the endpoint to compare a tainted read
 * against, and the dataflow is not established.
 *
 * The value of pinning this is that the endpoint must not read as CLEAN. It does not: the flow exists at
 * tier `imported`, carries `ruleGeneratable: false`, and names both reasons. A consumer therefore sees
 * "undetermined", never "does not reach" — and the two server-side gates that matter both require
 * `exact-local`, so nothing auto-promotes off it.
 *
 * One thing here is NOT proven by these tests. The lookup that finds a sink's call node is keyed by
 * `start:end` with no file in the key, so a sink from another file could collide with a local call and
 * inherit its evidence — `exact-local`, rule-generatable, auto-promotable. `sink.file === undefined`
 * guards that, and the measured offsets show the ranges do overlap (the helper sink sat at 113–130 while
 * the endpoint body spanned 87–194). Constructing an actual collision needs two files whose byte offsets
 * line up exactly; two attempts at a self-adjusting fixture did not produce one, so that guard is
 * defensive and unverified rather than tested. Removing it does not fail anything here.
 *
 * Resolving the hop — mapping `helper(req.body.sql)` onto the helper's parameter and then onto the sink's
 * argument — would make this a proven flow. What tier it should carry is a vocabulary decision with
 * consequences: `exact-local` is the single auto-promotable tier, so a one-hop flow landing there would
 * change what automatic blocking is allowed to rest on.
 */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ps-hop-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

const PKG = JSON.stringify({ name: 'h', dependencies: { pg: '8.0.0', express: '4.18.0' } });

async function endpointOf(files: Record<string, string>) {
  const dir = project(files);
  try {
    const { map } = await buildInputMap(dir, {});
    return map?.endpoints?.[0];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HELPER_APP = {
  'package.json': PKG,
  'src/db.ts':
    "import { Client } from 'pg';\nconst client = new Client();\nexport async function runQuery(sql: string) {\n  return client.query(sql);\n}\n",
  'src/server.ts':
    "import express from 'express';\nimport { runQuery } from './db';\nconst app = express();\napp.post('/report', async (req, res) => {\n  const rows = await runQuery(req.body.sql);\n  res.json(rows);\n});\n",
};

describe('a sink one helper hop away', () => {
  it('is found, and its flow says undetermined rather than nothing', async () => {
    const endpoint = await endpointOf(HELPER_APP);

    expect(endpoint?.sinks?.some((s) => s.kind === 'db' && s.file === 'src/db.ts')).toBe(true);

    const flow: any = endpoint?.flows?.[0];
    expect(flow, 'the endpoint must not look clean').toBeDefined();
    expect(flow.confidence).toBe('imported');
    expect(flow.ruleGeneratable).toBe(false);
    // Both halves of why, so the reason cannot degrade to one vague sentence.
    expect(String(flow.ruleGeneratableReasons ?? [])).toContain('no proven local read');
    expect(String(flow.ruleGeneratableReasons ?? [])).toContain('no local call-site evidence');
  });

  it('carries a tier neither server-side gate will act on', async () => {
    // The property that makes the weaker tier safe rather than merely honest: `imported` is not
    // `exact-local`, so neither the reachability verdict nor the rule generator will pin from it.
    const endpoint = await endpointOf(HELPER_APP);
    const { PROVEN_CONFIDENCE_TIERS, AUTO_PROMOTABLE_CONFIDENCE } = await import('../../src/map/capabilities.js');

    const tier = (endpoint?.flows?.[0] as any)?.confidence;
    expect(PROVEN_CONFIDENCE_TIERS as readonly string[]).not.toContain(tier);
    expect(tier).not.toBe(AUTO_PROMOTABLE_CONFIDENCE);
  });

  it('does link the flow when the sink is called directly — the control', async () => {
    // Without this the two above would pass for an extractor that never proved anything.
    const endpoint = await endpointOf({
      'package.json': PKG,
      'src/server.ts':
        "import express from 'express';\nimport { Client } from 'pg';\nconst app = express();\nconst client = new Client();\napp.post('/report', async (req, res) => {\n  const rows = await client.query(req.body.sql);\n  res.json(rows);\n});\n",
    });

    const flow: any = endpoint?.flows?.[0];
    expect(flow.confidence).toBe('exact-local');
    expect(flow.ruleGeneratable).toBe(true);
  });
});
