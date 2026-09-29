import type { Endpoint, Flow, SiteInputMap } from './types.js';
import { isProvenFlow } from './coordinates.js';

/**
 * The size a map may have and still be accepted by the Patchstack API's map ingest: at most 2,000 flows on
 * one endpoint, 50,000 nodes in the whole document (every member of an array or object counts one), and
 * 2 MiB of JSON. A document over any of them is refused whole, so a large app would send no map at all.
 */
export const INGEST_LIMITS = { flowsPerEndpoint: 2000, nodes: 50_000, bytes: 2 * 1024 * 1024 } as const;

/** Room for what the upload adds around the map: the build identity and its key. */
const RESERVE = { nodes: 8, bytes: 256 } as const;

/** Nodes as the ingest counts them: each member of an array or object is one, recursively. */
export function nodeCount(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;
  let n = 0;
  for (const item of Object.values(value as object)) n += 1 + nodeCount(item);
  return n;
}

const encoder = new TextEncoder();
const byteLength = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

/**
 * Which flows to keep when the document has to shrink, highest first: an exact-local flow that can
 * generate a rule, then any other exact-local flow, then transformed-local, then unproven.
 */
function keepPriority(flow: Flow): number {
  if (flow.confidence === 'exact-local') return flow.ruleGeneratable ? 3 : 2;
  if (flow.confidence === 'transformed-local') return 1;
  return 0;
}

interface Candidate { endpoint: number; flow: number; priority: number; nodes: number; bytes: number }

/**
 * Fit the document inside `INGEST_LIMITS` by leaving flows out, lowest priority first.
 *
 * The order is deterministic — priority, then later endpoints before earlier ones, then later flows before
 * earlier ones — so the same app gives the same document on every build. An endpoint that lost proven flows
 * says how many in `provenFlowsOmitted`: the flows it still lists are true, but a coordinate missing from
 * it may be one that was left out. One that lost only unproven flows is marked `flowsTruncated`, as before.
 */
export function budgetDocument(map: SiteInputMap, limits: { flowsPerEndpoint: number; nodes: number; bytes: number } = INGEST_LIMITS): SiteInputMap {
  const omittedProven = new Map<number, number>();
  const removed = new Set<string>();
  const note = (endpoint: number, flow: Flow) => {
    if (isProvenFlow(flow.confidence)) omittedProven.set(endpoint, (omittedProven.get(endpoint) ?? 0) + 1);
  };

  // Per endpoint first: the ingest counts flows endpoint by endpoint, whatever the document's size.
  map.endpoints.forEach((endpoint, e) => {
    if (endpoint.flows.length <= limits.flowsPerEndpoint) return;
    const order = endpoint.flows.map((flow, f) => ({ f, priority: keepPriority(flow) }))
      .sort((a, b) => b.priority - a.priority || a.f - b.f);
    for (const { f } of order.slice(limits.flowsPerEndpoint)) {
      removed.add(`${e}:${f}`);
      note(e, endpoint.flows[f]!);
    }
  });

  const apply = (): SiteInputMap => ({
    ...map,
    endpoints: map.endpoints.map((endpoint, e): Endpoint => {
      const flows = endpoint.flows.filter((_, f) => !removed.has(`${e}:${f}`));
      if (flows.length === endpoint.flows.length) return endpoint;
      const provenOmitted = omittedProven.get(e) ?? 0;
      const unprovenOmitted = endpoint.flows.length - flows.length - provenOmitted;
      return {
        ...endpoint,
        flows,
        ...(unprovenOmitted > 0 ? { flowsTruncated: true as const } : {}),
        ...(provenOmitted > 0 ? { provenFlowsOmitted: provenOmitted } : {}),
      };
    }),
  });
  const withNote = (doc: SiteInputMap): SiteInputMap => {
    const proven = [...omittedProven.values()].reduce((a, b) => a + b, 0);
    if (proven === 0) return doc;
    return {
      ...doc,
      coverage: {
        ...doc.coverage,
        notes: [...doc.coverage.notes, `${proven} proven flow(s) on ${omittedProven.size} endpoint(s) were left out to keep the document within the size the Patchstack API accepts; those endpoints are marked provenFlowsOmitted. Every flow listed is true, but a coordinate missing from one of them may be one that was left out.`],
      },
    };
  };
  const fits = (doc: SiteInputMap) => nodeCount(doc) <= limits.nodes - RESERVE.nodes && byteLength(doc) <= limits.bytes - RESERVE.bytes;

  let doc = withNote(apply());
  if (fits(doc)) return doc;

  // Then the whole document, against the node and byte limits.
  const candidates: Candidate[] = [];
  map.endpoints.forEach((endpoint, e) => endpoint.flows.forEach((flow, f) => {
    if (removed.has(`${e}:${f}`)) return;
    candidates.push({ endpoint: e, flow: f, priority: keepPriority(flow), nodes: 1 + nodeCount(flow), bytes: byteLength(flow) + 1 });
  }));
  candidates.sort((a, b) => a.priority - b.priority || b.endpoint - a.endpoint || b.flow - a.flow);

  let nodes = nodeCount(doc);
  let bytes = byteLength(doc);
  for (const c of candidates) {
    if (nodes <= limits.nodes - RESERVE.nodes && bytes <= limits.bytes - RESERVE.bytes) {
      // Estimated inside the limits; confirm on the real document, since the markers and note add a little.
      doc = withNote(apply());
      nodes = nodeCount(doc);
      bytes = byteLength(doc);
      if (fits(doc)) return doc;
    }
    removed.add(`${c.endpoint}:${c.flow}`);
    note(c.endpoint, map.endpoints[c.endpoint]!.flows[c.flow]!);
    nodes -= c.nodes;
    bytes -= c.bytes;
  }

  // Everything removable is gone. What is left is the smallest document this map can be.
  return withNote(apply());
}
