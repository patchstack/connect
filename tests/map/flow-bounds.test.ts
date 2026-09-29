import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildInputMap } from '../../src/map/index.js';
import { boundUnprovenFlows } from '../../src/map/flows.js';

/**
 * Unproven flows are every input paired with every sink it was not shown to reach, so they grow with the
 * product of the two. The map carries a bounded number of them and says when it left some out; proven
 * flows, the ones rules are built from, are always kept.
 */
async function mapOf(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ps-flow-bounds-'));
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { next: '15.0.0' } }));
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
      writeFileSync(path.join(dir, file), source);
    }
    const { map } = await buildInputMap(dir, {});

    return map!;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A handler reading `fields` body fields next to `sinks` exec calls, one of which gets `field0`. */
const wideHandler = (fields: number, sinks: number) => {
  const reads = Array.from({ length: fields }, (_, i) => `body.field${i}`).join(', ');
  const calls = Array.from({ length: sinks }, (_, i) => (i === sinks - 1 ? '  exec(body.field0);' : `  exec('job-${i}');`)).join('\n');
  return `import { exec } from 'node:child_process';\nexport async function POST(request: Request) {\n  const body = await request.json();\n  console.log(${reads});\n${calls}\n  return new Response('ok');\n}\n`;
};

const proven = (flows: any[]) => flows.filter((f) => f.confidence === 'exact-local' || f.confidence === 'transformed-local');

describe('bounded unproven flows', () => {
  it('leaves a small endpoint untouched', async () => {
    const map = await mapOf({ 'app/api/run/route.ts': wideHandler(5, 5) });
    const endpoint = map.endpoints[0]!;

    expect(endpoint.flows).toHaveLength(25);
    expect(endpoint.flowsTruncated).toBeUndefined();
    expect(map.coverage.notes.join(' ')).not.toMatch(/flowsTruncated/);
  });

  it('bounds a wide endpoint, keeps its proven flow, and says so', async () => {
    const map = await mapOf({ 'app/api/run/route.ts': wideHandler(40, 40) });
    const endpoint = map.endpoints[0]!;

    expect(endpoint.flows.length - proven(endpoint.flows).length).toBe(200);
    expect(proven(endpoint.flows)).toEqual([expect.objectContaining({ input: 'field0', confidence: 'exact-local' })]);
    expect(endpoint.flowsTruncated).toBe(true);
    expect(map.coverage.notes.join(' ')).toMatch(/1 endpoint\(s\) had more unproven flows.*flowsTruncated/);
  });

  it('bounds unproven flows across the whole map', async () => {
    const files = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`app/api/r${i}/route.ts`, wideHandler(20, 10)]));
    const map = await mapOf(files);
    const unproven = map.endpoints.flatMap((e) => e.flows).length - map.endpoints.flatMap((e) => proven(e.flows)).length;

    expect(unproven).toBe(1000);
    expect(map.endpoints.every((e) => proven(e.flows).length === 1)).toBe(true);
    expect(map.endpoints.filter((e) => e.flowsTruncated)).toHaveLength(2);
  });
});

describe('boundUnprovenFlows', () => {
  const flow = (confidence: string, input: string) => ({ confidence, input }) as any;

  it('keeps every proven flow and the first unproven ones, in order', () => {
    const flows = [flow('heuristic', 'a'), flow('exact-local', 'b'), flow('imported', 'c'), flow('transformed-local', 'd'), flow('unknown', 'e')];

    expect(boundUnprovenFlows(flows, 1)).toEqual({ flows: [flows[0], flows[1], flows[3]], truncated: true });
  });

  it('reports no truncation at the limit', () => {
    const flows = [flow('heuristic', 'a'), flow('exact-local', 'b')];

    expect(boundUnprovenFlows(flows, 1)).toEqual({ flows, truncated: false });
  });
});
