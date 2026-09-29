import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildInputMap } from '../../src/map/index.js';
import { budgetDocument, depthOf, INGEST_LIMITS, ingestProblems, nodeCount } from '../../src/map/budget.js';

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
  coverage: { notes: [], importsComplete: true, importCoverageGaps: { unreadableFiles: 0, unscannableFiles: 0, unwalkedPaths: 0, unresolvableImports: 0 } },
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

    const out = budgetDocument(map, { ...INGEST_LIMITS, flowsPerEndpoint: 2, nodes: 1e9, bytes: 1e9 });

    expect(out.endpoints[0]!.flows.map((f) => f.input)).toEqual(['b', 'd']);
    expect(out.endpoints[0]).toMatchObject({ provenFlowsOmitted: 1, flowsTruncated: true });
  });

  // Sweeps the node limit down from the full document: at every limit the kept flows must be the most
  // useful ones, and the document must fit.
  const sweep = (map: any, check: (out: any) => void) => {
    for (let limit = nodeCount(map) + 8; limit > 0; limit--) check(budgetDocument(map, { ...INGEST_LIMITS, flowsPerEndpoint: 1e9, nodes: limit, bytes: 1e9 }));
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
    const limit = { ...INGEST_LIMITS, flowsPerEndpoint: 1e9, nodes: nodeCount(map), bytes: 1e9 };
    expect(budgetDocument(map, limit)).toEqual(budgetDocument(map, limit));
  });

  it('always fits the node limit when the flows alone can make it fit', () => {
    const map = doc([[flow('exact-local', true), flow('heuristic')], [flow('transformed-local')]]);
    const floor = nodeCount(budgetDocument(map, { ...INGEST_LIMITS, flowsPerEndpoint: 0, nodes: 1e9, bytes: 1e9 }));

    for (let limit = nodeCount(map) + 8; limit >= floor + 8; limit--) {
      expect(nodeCount(budgetDocument(map, { ...INGEST_LIMITS, flowsPerEndpoint: 1e9, nodes: limit, bytes: 1e9 }))).toBeLessThanOrEqual(limit - 8);
    }
  });

  it('fits the byte limit as well as the node limit', () => {
    const map = doc([[flow('exact-local', true, 'a'.repeat(400)), flow('exact-local', true, 'b'.repeat(400))]]);
    const limit = JSON.stringify(map).length - 100 + 256;

    const out = budgetDocument(map, { ...INGEST_LIMITS, flowsPerEndpoint: 1e9, nodes: 1e9, bytes: limit });

    expect(JSON.stringify(out).length).toBeLessThanOrEqual(limit - 256);
    expect(out.endpoints[0]!.flows).toHaveLength(1);
  });

  it('marks an endpoint that lost only unproven flows as truncated, not as missing proven ones', () => {
    const map = doc([[flow('exact-local', true), flow('heuristic')]]);

    const out = budgetDocument(map, { ...INGEST_LIMITS, flowsPerEndpoint: 1, nodes: 1e9, bytes: 1e9 });

    expect(out.endpoints[0]).toMatchObject({ flowsTruncated: true });
    expect(out.endpoints[0]).not.toHaveProperty('provenFlowsOmitted');
    expect(out.coverage.notes).toEqual([]);
  });

  it('says in the notes how many proven flows were left out', () => {
    const map = doc([[flow('exact-local'), flow('exact-local')]]);

    const out = budgetDocument(map, { ...INGEST_LIMITS, flowsPerEndpoint: 1, nodes: 1e9, bytes: 1e9 });

    expect(out.coverage.notes.join(' ')).toMatch(/left out 1 proven flow\(s\) \(1 endpoint\(s\) marked provenFlowsOmitted.*unknown, not absent/);
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
    expect(map.coverage.notes.join(' ')).toMatch(/left out \d+ proven flow\(s\)/);
  }, 120_000);
});

describe('every section, against every limit', () => {
  const imp = (i: number) => ({ package: `pkg-${i}`, specifiers: [`pkg-${i}`], namesComplete: true, sites: [{ file: `src/f${i}.ts`, line: 1 }], siteCount: 1, recognizedSinkKinds: [] });
  const inv = (i: number) => ({ package: `pkg-${i}`, api: `call${i}`, symbol: `pkg.call${i}`, kind: 'call', resolution: 'direct', specifiers: [`pkg-${i}`], sites: [{ file: 'src/a.ts', line: i }] });
  const link = (i: number) => ({ input: 'x', inputId: 'post:x', package: 'p', specifier: 'p', api: `a${i}`, symbol: `p.a${i}`, kind: 'call', resolution: 'direct', argumentIndex: 0, argumentUse: 'direct', line: i });
  const endpoint = (i: number, extra: any = {}) => ({ name: `e${i}`, file: `f${i}.ts`, inputs: [], sinks: [], flows: [], ...extra });
  const base = (extra: any = {}): any => ({ ...doc([]), ...extra, coverage: { ...doc([]).coverage, ...(extra.coverage ?? {}) } });

  it('fits an import-heavy map by leaving imports out, and stops claiming the inventory is complete', () => {
    const map = base({ imports: Array.from({ length: 6000 }, (_, i) => imp(i)) });
    expect(ingestProblems(map)).not.toEqual([]);

    const out: any = budgetDocument(map);

    expect(ingestProblems(out)).toEqual([]);
    expect(out.imports.length).toBeLessThan(6000);
    expect(out.coverage.importsComplete).toBe(false);
    expect(out.coverage.importCoverageGaps.omittedForSize).toBe(6000 - out.imports.length);
    // The first imports are kept; the last go first.
    expect(out.imports[0].package).toBe('pkg-0');
  });

  it('keeps no more endpoints than the ingest accepts, and counts the rest', () => {
    const map = base({ endpoints: Array.from({ length: 2001 }, (_, i) => endpoint(i)) });
    expect(ingestProblems(map)).toContain('2001 endpoints, over 2000');

    const out: any = budgetDocument(map);

    expect(out.endpoints).toHaveLength(2000);
    expect(out.endpoints[1999].name).toBe('e1999');
    expect(out.coverage.endpointsOmitted).toBe(1);
    expect(ingestProblems(out)).toEqual([]);
  });

  it('leaves out an endpoint whose file path the ingest would refuse', () => {
    const out: any = budgetDocument(base({ endpoints: [endpoint(0, { file: 'x'.repeat(513) }), endpoint(1)] }));

    expect(out.endpoints.map((e: any) => e.name)).toEqual(['e1']);
    expect(out.coverage.endpointsOmitted).toBe(1);
  });

  it('caps inputs and sinks per endpoint, keeping those the proven flows need, and marks the endpoint', () => {
    const inputs = Array.from({ length: 600 }, (_, i) => ({ id: `post:i${i}`, name: `i${i}`, source: 'body' }));
    const sinks = Array.from({ length: 600 }, (_, i) => ({ id: `s${i}`, kind: 'db' }));
    const needed = { ...flow('exact-local', true, 'i599'), inputId: 'post:i599', sink: { id: 's599', kind: 'db' } };
    const out: any = budgetDocument(base({ endpoints: [endpoint(0, { inputs, sinks, flows: [needed] })] }));
    const e = out.endpoints[0];

    expect(e.inputs).toHaveLength(500);
    expect(e.sinks).toHaveLength(500);
    expect(e.inputs.map((i: any) => i.id)).toContain('post:i599');
    expect(e.sinks.map((s: any) => s.id)).toContain('s599');
    expect(e.flows).toHaveLength(1);
    expect(e).toMatchObject({ inputsOmitted: 100, sinksOmitted: 100 });
  });

  it('drops a flow whose input was left out, and counts it as an omitted proven flow', () => {
    const inputs = Array.from({ length: 501 }, (_, i) => ({ id: `post:i${i}`, name: `i${i}`, source: 'body' }));
    const flows = inputs.map((i) => ({ ...flow('exact-local', false, i.name), inputId: i.id }));
    const out: any = budgetDocument(base({ endpoints: [endpoint(0, { inputs, flows })] }));

    expect(out.endpoints[0]).toMatchObject({ inputsOmitted: 1, provenFlowsOmitted: 1 });
    expect(out.endpoints[0].flows).toHaveLength(500);
  });

  it('caps dependency links per endpoint and marks them truncated', () => {
    const out: any = budgetDocument(base({ endpoints: [endpoint(0, { dependencyInputFlows: Array.from({ length: 101 }, (_, i) => link(i)) })] }));

    expect(out.endpoints[0].dependencyInputFlows).toHaveLength(100);
    expect(out.endpoints[0].dependencyInputFlowsTruncated).toBe(true);
  });

  it('fits a map oversized in every section, in stage order, marking each section it trimmed', () => {
    const map = base({
      endpoints: Array.from({ length: 50 }, (_, i) => endpoint(i, {
        flows: [flow('heuristic'), flow('exact-local', true), flow('transformed-local')],
        dependencyInputFlows: Array.from({ length: 40 }, (_, j) => link(j)),
      })),
      apiInvocations: Array.from({ length: 3000 }, (_, i) => inv(i)),
      imports: Array.from({ length: 3000 }, (_, i) => imp(i)),
    });
    expect(ingestProblems(map)).not.toEqual([]);

    const out: any = budgetDocument(map);

    expect(ingestProblems(out)).toEqual([]);
    // Unproven flows, invocations and dependency links give way before any proven flow or import.
    expect(out.endpoints.every((e: any) => !e.flows.some((f: any) => f.confidence === 'heuristic'))).toBe(true);
    expect(out.coverage.apiInvocationsOmitted).toBeGreaterThan(0);
    expect(out.endpoints.some((e: any) => e.dependencyInputFlowsTruncated)).toBe(true);
    expect(out.coverage.notes.join(' ')).toMatch(/unknown, not absent/);
  });

  it('gives way in stage order: invocations before dependency links before proven flows before imports', () => {
    const map = base({
      endpoints: [endpoint(0, { flows: [flow('exact-local', true)], dependencyInputFlows: [link(0)] })],
      apiInvocations: [inv(0)],
      imports: [imp(0)],
    });
    const seen: string[] = [];
    for (let limit = nodeCount(map) + 8; limit > 0; limit--) {
      const out: any = budgetDocument(map, { ...INGEST_LIMITS, nodes: limit });
      const state = [
        out.apiInvocations.length, out.endpoints[0].dependencyInputFlows.length, out.endpoints[0].flows.length, out.imports.length,
      ].join('');
      if (seen.at(-1) !== state) seen.push(state);
    }

    expect(seen).toEqual(['1111', '0111', '0011', '0001', '0000']);
  });

  it('reports a map that cannot be fitted, and says it must not be uploaded', () => {
    // 2,000 endpoints with 500 inputs each: nothing left to leave out that would bring it under the node limit.
    const inputs = Array.from({ length: 30 }, (_, i) => ({ id: `post:i${i}`, name: `i${i}`, source: 'body' }));
    const map = base({ endpoints: Array.from({ length: 2000 }, (_, i) => endpoint(i, { inputs })) });

    const out: any = budgetDocument(map);

    expect(ingestProblems(out).join(' ')).toMatch(/nodes, over/);
    expect(out.coverage.notes.join(' ')).toMatch(/cannot be fitted.*must not be uploaded/);
  });

  it('gives the same document for the same input', () => {
    const map = base({ imports: Array.from({ length: 6000 }, (_, i) => imp(i)), apiInvocations: Array.from({ length: 2000 }, (_, i) => inv(i)) });

    expect(JSON.stringify(budgetDocument(map))).toBe(JSON.stringify(budgetDocument(structuredClone(map))));
  });

  it('measures depth as the ingest does', () => {
    expect(depthOf({ a: 1 })).toBe(1);
    expect(depthOf({ a: [{ b: 1 }] })).toBe(3);
    expect(ingestProblems(base({ endpoints: [endpoint(0, { inputs: [{ id: 'x', deep: [[[[[[[[[[[1]]]]]]]]]]] }] })] })).join(' ')).toMatch(/nesting \d+ levels deep, over 12/);
  });
});
