import type { Endpoint, Flow, SiteInputMap } from './types.js';
import { isProvenFlow } from './coordinates.js';

/**
 * What the Patchstack API's map ingest accepts. A document over ANY of these is refused whole, so a map
 * that breaks one reports no surface at all.
 *
 *   bytes       the JSON request body, build identity included
 *   nodes       every member of an array or object counts one, across the whole document
 *   depth       nesting below the root
 *   endpoints   endpoints in the document; each endpoint's `file` is at most `fileLength` characters
 *   per endpoint: `inputs` and `sinks` (500 each), `flows` (2,000), `dependencyInputFlows` (100)
 */
export const INGEST_LIMITS = {
  bytes: 2 * 1024 * 1024,
  nodes: 50_000,
  depth: 12,
  endpoints: 2000,
  fileLength: 512,
  inputsPerEndpoint: 500,
  sinksPerEndpoint: 500,
  flowsPerEndpoint: 2000,
  dependencyInputFlowsPerEndpoint: 100,
} as const;

export type IngestLimits = { [K in keyof typeof INGEST_LIMITS]: number };

/** Room for what the upload adds around the map: the build identity and its key. */
const RESERVE = { nodes: 8, bytes: 256 } as const;

/** Nodes as the ingest counts them: each member of an array or object is one, recursively. */
export function nodeCount(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;
  let n = 0;
  for (const item of Object.values(value as object)) n += 1 + nodeCount(item);
  return n;
}

/** The deepest member below the root, counted as the ingest counts it (the root's members are depth 1). */
export function depthOf(value: unknown, depth = 0): number {
  if (value === null || typeof value !== 'object') return depth;
  let deepest = depth;
  for (const item of Object.values(value as object)) deepest = Math.max(deepest, depthOf(item, depth + 1));
  return deepest;
}

const encoder = new TextEncoder();
const byteLength = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

/**
 * Every ingest limit this document breaks, as a reason a person can act on. Empty when it would be
 * accepted. Measured with the room the upload needs around the map.
 */
export function ingestProblems(map: SiteInputMap, limits: IngestLimits = INGEST_LIMITS): string[] {
  const problems: string[] = [];
  const bytes = byteLength(map);
  const nodes = nodeCount(map);
  const depth = depthOf(map);
  if (bytes > limits.bytes - RESERVE.bytes) problems.push(`${bytes} bytes, over the ${limits.bytes - RESERVE.bytes} the upload can carry`);
  if (nodes > limits.nodes - RESERVE.nodes) problems.push(`${nodes} nodes, over the ${limits.nodes - RESERVE.nodes} the upload can carry`);
  if (depth > limits.depth) problems.push(`nesting ${depth} levels deep, over ${limits.depth}`);
  if (map.endpoints.length > limits.endpoints) problems.push(`${map.endpoints.length} endpoints, over ${limits.endpoints}`);
  map.endpoints.forEach((e, i) => {
    const at = `endpoint ${i}`;
    if (typeof e.file !== 'string' || e.file.length > limits.fileLength) problems.push(`${at} has a file path over ${limits.fileLength} characters`);
    if (e.inputs.length > limits.inputsPerEndpoint) problems.push(`${at} has ${e.inputs.length} inputs, over ${limits.inputsPerEndpoint}`);
    if (e.sinks.length > limits.sinksPerEndpoint) problems.push(`${at} has ${e.sinks.length} sinks, over ${limits.sinksPerEndpoint}`);
    if (e.flows.length > limits.flowsPerEndpoint) problems.push(`${at} has ${e.flows.length} flows, over ${limits.flowsPerEndpoint}`);
    if ((e.dependencyInputFlows?.length ?? 0) > limits.dependencyInputFlowsPerEndpoint) problems.push(`${at} has ${e.dependencyInputFlows!.length} dependency input links, over ${limits.dependencyInputFlowsPerEndpoint}`);
  });
  return problems;
}

/**
 * Which flows to keep when the document has to shrink, highest first: an exact-local flow that can
 * generate a rule, then any other exact-local flow, then transformed-local, then unproven.
 */
function keepPriority(flow: Flow): number {
  if (flow.confidence === 'exact-local') return flow.ruleGeneratable ? 3 : 2;
  if (flow.confidence === 'transformed-local') return 1;
  return 0;
}

/**
 * The order sections give way when the whole document is too big, least consequential first. Each is
 * marked when it loses anything, so what is left never reads as complete:
 *
 *   unproven flows        endpoint `flowsTruncated`
 *   API invocations       `coverage.apiInvocationsOmitted` (positive-only evidence; absence proves nothing)
 *   dependency links      endpoint `dependencyInputFlowsTruncated`
 *   proven flows          endpoint `provenFlowsOmitted`
 *   imports               `coverage.importsComplete: false` and `importCoverageGaps.omittedForSize`
 */
const STAGES = ['unproven', 'invocation', 'dependency', 'transformed', 'exact', 'generatable', 'import'] as const;
type Stage = (typeof STAGES)[number];

interface Removal { stage: Stage; section: number; item: number; nodes: number; bytes: number }

/**
 * Fit the document to `INGEST_LIMITS`, or say it cannot be fitted.
 *
 * First the hard per-section counts, then the whole document's node and byte size, by leaving parts out
 * in `STAGES` order. Within a stage, later endpoints and later entries go first, so the same app gives the
 * same document on every build. Everything left out is marked where a consumer reads it: the parts that
 * remain are true, and the parts that do not are unknown rather than absent.
 *
 * When nothing permitted can make it fit, the result carries a note and `ingestProblems()` is non-empty;
 * such a map must not be uploaded.
 */
export function budgetDocument(input: SiteInputMap, limits: IngestLimits = INGEST_LIMITS): SiteInputMap {
  let endpointsOmitted = 0;
  // Endpoints the ingest refuses outright, or beyond its count: dropped whole, latest first.
  let endpoints = input.endpoints.filter((e) => {
    const ok = typeof e.file === 'string' && e.file.length <= limits.fileLength;
    if (!ok) endpointsOmitted++;
    return ok;
  });
  if (endpoints.length > limits.endpoints) {
    endpointsOmitted += endpoints.length - limits.endpoints;
    endpoints = endpoints.slice(0, limits.endpoints);
  }
  endpoints = endpoints.map((e) => capEndpoint(e, limits));

  let map: SiteInputMap = { ...input, endpoints };
  if (endpointsOmitted > 0) map = { ...map, coverage: { ...map.coverage, endpointsOmitted } };

  // Then the whole document.
  const removals: Removal[] = [];
  map.endpoints.forEach((e, s) => {
    e.flows.forEach((f, i) => {
      const p = keepPriority(f);
      const stage: Stage = p === 3 ? 'generatable' : p === 2 ? 'exact' : p === 1 ? 'transformed' : 'unproven';
      removals.push({ stage, section: s, item: i, nodes: 1 + nodeCount(f), bytes: byteLength(f) + 1 });
    });
    (e.dependencyInputFlows ?? []).forEach((d, i) => removals.push({ stage: 'dependency', section: s, item: i, nodes: 1 + nodeCount(d), bytes: byteLength(d) + 1 }));
  });
  (map.apiInvocations ?? []).forEach((v, i) => removals.push({ stage: 'invocation', section: -1, item: i, nodes: 1 + nodeCount(v), bytes: byteLength(v) + 1 }));
  (map.imports ?? []).forEach((v, i) => removals.push({ stage: 'import', section: -1, item: i, nodes: 1 + nodeCount(v), bytes: byteLength(v) + 1 }));
  removals.sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) || b.section - a.section || b.item - a.item);

  const removed = new Set<string>();
  const key = (r: Removal) => `${r.stage === 'unproven' || r.stage === 'transformed' || r.stage === 'exact' || r.stage === 'generatable' ? 'flow' : r.stage}:${r.section}:${r.item}`;
  const fitsSize = (doc: SiteInputMap) => nodeCount(doc) <= limits.nodes - RESERVE.nodes && byteLength(doc) <= limits.bytes - RESERVE.bytes;

  let doc = withNote(applyRemovals(map, removed));
  let nodes = nodeCount(doc);
  let bytes = byteLength(doc);
  for (const r of removals) {
    if (nodes <= limits.nodes - RESERVE.nodes && bytes <= limits.bytes - RESERVE.bytes) {
      // Estimated inside the limits; confirm on the real document, since the markers and note add a little.
      doc = withNote(applyRemovals(map, removed));
      nodes = nodeCount(doc);
      bytes = byteLength(doc);
      if (fitsSize(doc)) break;
    }
    removed.add(key(r));
    nodes -= r.nodes;
    bytes -= r.bytes;
  }
  doc = withNote(applyRemovals(map, removed));

  const problems = ingestProblems(doc, limits);
  if (problems.length === 0) return doc;

  return {
    ...doc,
    coverage: {
      ...doc.coverage,
      notes: [...doc.coverage.notes, `This map cannot be fitted to the size the Patchstack API accepts (${problems.join('; ')}), even after leaving out everything that may be left out. It must not be uploaded.`],
    },
  };
}

/** One endpoint within its per-section counts. Flows go by priority; inputs and sinks that kept flows need stay. */
function capEndpoint(e: Endpoint, limits: IngestLimits): Endpoint {
  let flows = e.flows;
  let droppedProven = 0;
  let droppedUnproven = 0;
  const drop = (keep: (f: Flow) => boolean) => {
    flows = flows.filter((f) => {
      if (keep(f)) return true;
      if (isProvenFlow(f.confidence)) droppedProven++;
      else droppedUnproven++;
      return false;
    });
  };

  if (flows.length > limits.flowsPerEndpoint) {
    const kept = new Set(
      flows.map((f, i) => ({ f, i, p: keepPriority(f) }))
        .sort((a, b) => b.p - a.p || a.i - b.i)
        .slice(0, limits.flowsPerEndpoint)
        .map(({ i }) => i),
    );
    const byIndex = new Map(flows.map((f, i) => [f, i] as const));
    drop((f) => kept.has(byIndex.get(f)!));
  }

  // Inputs and sinks: keep the ones the most useful flows need, then the rest in order.
  const ranked = [...flows].sort((a, b) => keepPriority(b) - keepPriority(a));
  const pick = <T extends { id?: string }>(items: T[], limit: number, idOf: (f: Flow) => string | undefined): { kept: T[]; omitted: number } => {
    if (items.length <= limit) return { kept: items, omitted: 0 };
    const wanted = new Set<string>();
    for (const f of ranked) {
      const id = idOf(f);
      if (id !== undefined && wanted.size < limit) wanted.add(id);
    }
    const chosen = new Set<T>(items.filter((it) => it.id !== undefined && wanted.has(it.id)));
    for (const it of items) if (chosen.size < limit) chosen.add(it);
    return { kept: items.filter((it) => chosen.has(it)), omitted: items.length - chosen.size };
  };
  const inputs = pick(e.inputs, limits.inputsPerEndpoint, (f) => f.inputId);
  const sinks = pick(e.sinks, limits.sinksPerEndpoint, (f) => f.sink?.id);
  if (inputs.omitted > 0 || sinks.omitted > 0) {
    const inputIds = new Set(inputs.kept.map((i) => i.id));
    const sinkIds = new Set(sinks.kept.map((s) => s.id));
    drop((f) => (f.inputId === undefined || inputIds.has(f.inputId)) && (f.sink?.id === undefined || sinkIds.has(f.sink.id)));
  }

  let links = e.dependencyInputFlows;
  let linksTruncated = e.dependencyInputFlowsTruncated === true;
  if (links !== undefined && links.length > limits.dependencyInputFlowsPerEndpoint) {
    links = links.slice(0, limits.dependencyInputFlowsPerEndpoint);
    linksTruncated = true;
  }

  if (flows === e.flows && inputs.omitted === 0 && sinks.omitted === 0 && links === e.dependencyInputFlows) return e;
  return {
    ...e,
    inputs: inputs.kept,
    sinks: sinks.kept,
    flows,
    ...(links !== undefined ? { dependencyInputFlows: links } : {}),
    ...(linksTruncated ? { dependencyInputFlowsTruncated: true as const } : {}),
    ...(droppedUnproven > 0 ? { flowsTruncated: true as const } : {}),
    ...(droppedProven > 0 ? { provenFlowsOmitted: (e.provenFlowsOmitted ?? 0) + droppedProven } : {}),
    ...(inputs.omitted > 0 ? { inputsOmitted: inputs.omitted } : {}),
    ...(sinks.omitted > 0 ? { sinksOmitted: sinks.omitted } : {}),
  };
}

function applyRemovals(map: SiteInputMap, removed: Set<string>): SiteInputMap {
  if (removed.size === 0) return map;
  const endpoints = map.endpoints.map((e, s): Endpoint => {
    let proven = 0;
    let unproven = 0;
    const flows = e.flows.filter((f, i) => {
      if (!removed.has(`flow:${s}:${i}`)) return true;
      if (isProvenFlow(f.confidence)) proven++;
      else unproven++;
      return false;
    });
    const links = e.dependencyInputFlows?.filter((_, i) => !removed.has(`dependency:${s}:${i}`));
    const linksDropped = (e.dependencyInputFlows?.length ?? 0) - (links?.length ?? 0);
    if (proven === 0 && unproven === 0 && linksDropped === 0) return e;
    return {
      ...e,
      flows,
      ...(links !== undefined ? { dependencyInputFlows: links } : {}),
      ...(unproven > 0 ? { flowsTruncated: true as const } : {}),
      ...(proven > 0 ? { provenFlowsOmitted: (e.provenFlowsOmitted ?? 0) + proven } : {}),
      ...(linksDropped > 0 ? { dependencyInputFlowsTruncated: true as const } : {}),
    };
  });
  const invocations = map.apiInvocations?.filter((_, i) => !removed.has(`invocation:-1:${i}`));
  const imports = map.imports?.filter((_, i) => !removed.has(`import:-1:${i}`));
  const invocationsOmitted = (map.apiInvocations?.length ?? 0) - (invocations?.length ?? 0);
  const importsOmitted = (map.imports?.length ?? 0) - (imports?.length ?? 0);

  return {
    ...map,
    endpoints,
    ...(invocations !== undefined ? { apiInvocations: invocations } : {}),
    ...(imports !== undefined ? { imports } : {}),
    coverage: {
      ...map.coverage,
      ...(invocationsOmitted > 0 ? { apiInvocationsOmitted: invocationsOmitted } : {}),
      // A package missing from a trimmed inventory may still be imported, so the inventory stops licensing
      // any "not imported" conclusion.
      ...(importsOmitted > 0
        ? { importsComplete: false, importCoverageGaps: { ...map.coverage.importCoverageGaps!, omittedForSize: importsOmitted } }
        : {}),
    },
  };
}

/** One note saying what was left out to fit, when anything was. */
function withNote(doc: SiteInputMap): SiteInputMap {
  const parts: string[] = [];
  const proven = doc.endpoints.reduce((n, e) => n + (e.provenFlowsOmitted ?? 0), 0);
  const marked = doc.endpoints.filter((e) => e.provenFlowsOmitted || e.inputsOmitted || e.sinksOmitted).length;
  if (proven > 0) parts.push(`${proven} proven flow(s)`);
  const inputs = doc.endpoints.reduce((n, e) => n + (e.inputsOmitted ?? 0), 0);
  const sinks = doc.endpoints.reduce((n, e) => n + (e.sinksOmitted ?? 0), 0);
  if (inputs > 0) parts.push(`${inputs} input(s)`);
  if (sinks > 0) parts.push(`${sinks} sink(s)`);
  if (doc.coverage.apiInvocationsOmitted) parts.push(`${doc.coverage.apiInvocationsOmitted} API invocation(s)`);
  if (doc.coverage.importCoverageGaps?.omittedForSize) parts.push(`${doc.coverage.importCoverageGaps.omittedForSize} import(s)`);
  if (doc.coverage.endpointsOmitted) parts.push(`${doc.coverage.endpointsOmitted} endpoint(s)`);
  const links = doc.endpoints.filter((e) => e.dependencyInputFlowsTruncated).length;
  if (parts.length === 0) return doc;
  return {
    ...doc,
    coverage: {
      ...doc.coverage,
      notes: [...doc.coverage.notes, `To stay within the size the Patchstack API accepts, this map left out ${parts.join(', ')}${marked > 0 ? ` (${marked} endpoint(s) marked provenFlowsOmitted, inputsOmitted or sinksOmitted)` : ''}${links > 0 ? `; ${links} endpoint(s) have dependencyInputFlowsTruncated` : ''}. What is listed is true; what was left out is unknown, not absent.`],
    },
  };
}
