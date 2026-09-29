import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildInputMap } from '../../src/map/index.js';
import { budgetDocument, INGEST_LIMITS, nodeCount } from '../../src/map/budget.js';

/**
 * The Patchstack API refuses a whole map that is over its size limits, so a large app would report no
 * surface at all. The document is fitted to the limits by leaving flows out, least useful first, and an
 * endpoint that lost proven flows says so.
 */
const flow = (confidence: string, ruleGeneratable = false, input = 'x') =>
  ({ input, inputId: `post:${input}`, confidence, ruleGeneratable, ruleGeneratableReasons: [], sink: { kind: 'db' } }) as any;

const doc = (endpoints: any[][]): any => ({
  version: 3,
  endpoints: endpoints.map((flows, i) => ({ name: `e${i}`, file: `f${i}.ts`, inputs: [], sinks: [], flows })),
  coverage: { notes: [] },
});

const confidences = (map: any, e: number) => map.endpoints[e].flows.map((f: any) => `${f.confidence}${f.ruleGeneratable ? '+' : ''}`);

describe('nodeCount', () => {
  it('counts every member of an array or object, recursively, like the ingest', () => {
    // endpoints(1) + [0](1) + a(1) + [1,2](2) = 5; version(1) = 6
    expect(nodeCount({ version: 3, endpoints: [{ a: [1, 2] }] })).toBe(6);
    expect(nodeCount('text')).toBe(0);
  });
});

describe('budgetDocument', () => {
  it('leaves a document inside the limits untouched', () => {
    const map = doc([[flow('exact-local', true), flow('heuristic')]]);

    expect(budgetDocument(map)).toEqual(map);
  });

  it('caps one endpoint at the per-endpoint limit, keeping the most useful flows in their order', () => {
    const map = doc([[flow('heuristic', false, 'a'), flow('exact-local', true, 'b'), flow('transformed-local', false, 'c'), flow('exact-local', false, 'd')]]);

    const out = budgetDocument(map, { flowsPerEndpoint: 2, nodes: 1e9, bytes: 1e9 });

    expect(out.endpoints[0]!.flows.map((f) => f.input)).toEqual(['b', 'd']);
    expect(out.endpoints[0]).toMatchObject({ provenFlowsOmitted: 1, flowsTruncated: true });
  });

  // Sweeps the node limit down from the full document: at every limit the kept flows must be the most
  // useful ones, and the document must fit.
  const sweep = (map: any, check: (out: any) => void) => {
    for (let limit = nodeCount(map) + 8; limit > 0; limit--) check(budgetDocument(map, { flowsPerEndpoint: 1e9, nodes: limit, bytes: 1e9 }));
  };

  it('removes unproven flows before proven ones, and generatable exact flows last', () => {
    // Every unproven tier is one class: none of them is evidence, so none outranks another.
    const order = ['exact-local+', 'exact-local', 'transformed-local', 'unproven', 'unproven'];
    const tier = (c: string) => (c === 'heuristic' || c === 'unknown' ? 'unproven' : c);
    const map = doc([[flow('unknown'), flow('exact-local', true), flow('heuristic'), flow('exact-local'), flow('transformed-local')]]);
    const seen = new Set<number>();

    sweep(map, (out) => {
      const kept = confidences(out, 0).map(tier);
      seen.add(kept.length);
      // Whatever is kept is the most useful ${kept.length}, in the document's own order.
      expect([...kept].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(order.slice(0, kept.length));
    });
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('keeps a flow that can generate a rule over one that cannot, wherever it sits', () => {
    const map = doc([[flow('exact-local', false, 'plain'), flow('exact-local', true, 'generatable')]]);

    sweep(map, (out) => {
      if (out.endpoints[0].flows.length === 1) expect(out.endpoints[0].flows[0].input).toBe('generatable');
    });
  });

  it('takes from later endpoints first, so the result does not depend on anything but the input', () => {
    const map = doc([[flow('exact-local')], [flow('exact-local')], [flow('exact-local')]]);

    sweep(map, (out) => {
      const counts = out.endpoints.map((e: any) => e.flows.length);
      // Kept flows form a prefix: an endpoint loses its flow only once every later one has.
      expect(counts).toEqual([...counts].sort((a: number, b: number) => b - a));
      out.endpoints.forEach((e: any) => expect(e.provenFlowsOmitted ?? 0).toBe(1 - e.flows.length));
    });
    const limit = { flowsPerEndpoint: 1e9, nodes: nodeCount(map), bytes: 1e9 };
    expect(budgetDocument(map, limit)).toEqual(budgetDocument(map, limit));
  });

  it('always fits the node limit when the flows alone can make it fit', () => {
    const map = doc([[flow('exact-local', true), flow('heuristic')], [flow('transformed-local')]]);
    const floor = nodeCount(budgetDocument(map, { flowsPerEndpoint: 0, nodes: 1e9, bytes: 1e9 }));

    for (let limit = nodeCount(map) + 8; limit >= floor + 8; limit--) {
      expect(nodeCount(budgetDocument(map, { flowsPerEndpoint: 1e9, nodes: limit, bytes: 1e9 }))).toBeLessThanOrEqual(limit - 8);
    }
  });

  it('fits the byte limit as well as the node limit', () => {
    const map = doc([[flow('exact-local', true, 'a'.repeat(400)), flow('exact-local', true, 'b'.repeat(400))]]);
    const limit = JSON.stringify(map).length - 100 + 256;

    const out = budgetDocument(map, { flowsPerEndpoint: 1e9, nodes: 1e9, bytes: limit });

    expect(JSON.stringify(out).length).toBeLessThanOrEqual(limit - 256);
    expect(out.endpoints[0]!.flows).toHaveLength(1);
  });

  it('marks an endpoint that lost only unproven flows as truncated, not as missing proven ones', () => {
    const map = doc([[flow('exact-local', true), flow('heuristic')]]);

    const out = budgetDocument(map, { flowsPerEndpoint: 1, nodes: 1e9, bytes: 1e9 });

    expect(out.endpoints[0]).toMatchObject({ flowsTruncated: true });
    expect(out.endpoints[0]).not.toHaveProperty('provenFlowsOmitted');
    expect(out.coverage.notes).toEqual([]);
  });

  it('says in the notes how many proven flows were left out', () => {
    const map = doc([[flow('exact-local'), flow('exact-local')]]);

    const out = budgetDocument(map, { flowsPerEndpoint: 1, nodes: 1e9, bytes: 1e9 });

    expect(out.coverage.notes.join(' ')).toMatch(/1 proven flow\(s\) on 1 endpoint\(s\) were left out.*provenFlowsOmitted/);
  });
});

describe('what the mapper emits for a large app', () => {
  // Many route handlers, each reading a dozen fields into two database calls — an ordinary admin backend.
  // No single endpoint comes near the per-endpoint limit; it is the whole document that outgrows the ingest.
  async function largeApp(routes: number) {
    const dir = mkdtempSync(path.join(tmpdir(), 'ps-large-'));
    try {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { next: '15.0.0', pg: '8.0.0' } }));
      mkdirSync(path.join(dir, 'lib'), { recursive: true });
      writeFileSync(path.join(dir, 'lib/db.ts'), "import { Pool } from 'pg';\nexport const pool = new Pool();\n");
      const names = Array.from({ length: 12 }, (_, i) => `field${i}`);
      for (let r = 0; r < routes; r++) {
        const calls = [0, 1].map((s) => `  await pool.query('insert into t${r}_${s} values (${names.map((_, i) => `$${i + 1}`).join(', ')})', [${names.map((n) => `body.${n}`).join(', ')}]);`).join('\n');
        mkdirSync(path.join(dir, `app/api/resource${r}`), { recursive: true });
        writeFileSync(path.join(dir, `app/api/resource${r}/route.ts`), `import { pool } from '../../../lib/db';\nexport async function POST(request: Request) {\n  const body = await request.json();\n${calls}\n  return new Response('ok');\n}\n`);
      }
      const { map } = await buildInputMap(dir, {});

      return map!;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('keeps a moderate app whole', async () => {
    const map = await largeApp(40);

    expect(map.endpoints.flatMap((e) => e.flows)).toHaveLength(40 * 24);
    expect(map.endpoints.some((e) => e.provenFlowsOmitted)).toBe(false);
  }, 60_000);

  it('fits a large app inside the ingest limits, keeping every endpoint and marking what it left out', async () => {
    const map = await largeApp(120);
    const perEndpoint = map.endpoints.map((e) => e.flows.length + (e.provenFlowsOmitted ?? 0));

    // 120 x 12 x 2 = 2,880 proven flows, ~66,000 nodes before fitting: the whole map would be refused.
    expect(Math.max(...perEndpoint)).toBe(24);
    expect(perEndpoint.reduce((a, b) => a + b, 0)).toBe(2880);
    expect(nodeCount(map)).toBeLessThanOrEqual(INGEST_LIMITS.nodes);
    expect(Buffer.byteLength(JSON.stringify(map))).toBeLessThanOrEqual(INGEST_LIMITS.bytes);
    expect(map.endpoints).toHaveLength(120);
    expect(map.endpoints.filter((e) => e.provenFlowsOmitted).length).toBeGreaterThan(0);
    // Taken from the end, so the first endpoints are complete.
    expect(map.endpoints[0]!.provenFlowsOmitted).toBeUndefined();
    expect(map.coverage.notes.join(' ')).toMatch(/proven flow\(s\) on \d+ endpoint\(s\) were left out/);
  }, 120_000);
});
