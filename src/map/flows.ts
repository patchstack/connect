import type { ArgumentRole, Flow, InputField, Limitation, Sink, TsModule } from './types.js';
import { bindingKey, calleeName, isValueRead, lineOf, rootIdentifier } from './ast.js';
import { REQ_SOURCES } from './inputs.js';
import { argumentRoleOf, CANDIDATE_FAMILIES } from './sinks.js';

// --- input → sink flow linking ---------------------------------------------
// Evidence-backed data links: for each sink, does an INPUT identifier/path appear inside the sink
// call's arguments? "Tainted" roots are the handler's own parameter names (`{ data }`, `req`) plus any
// local alias of them (`const body = await request.json()`, `const { title } = data`).
//
// Deliberately conservative: a match yields `precise`; no match yields `heuristic` (the input and sink
// merely co-occur). It never claims a flow it didn't see, which is the point — a consumer pinning a
// rule to a parameter should trust `precise` and treat `heuristic` as "may reach".
// Spread onto an endpoint: `flows`, plus `limitations` only when there are any (keeps the common case clean).
export function linkedFlows(body: any, params: any, inputs: InputField[], sinks: Sink[], ts: TsModule): { flows: Flow[]; limitations?: Limitation[] } {
  const { flows, limitations } = linkFlows(body, params, inputs, sinks, ts);
  return limitations.length > 0 ? { flows, limitations } : { flows };
}

function linkFlows(
  bodyNode: any,
  params: any,
  inputs: InputField[],
  sinks: Sink[],
  ts: TsModule,
): { flows: Flow[]; limitations: Limitation[] } {
  if (!bodyNode || sinks.length === 0 || inputs.length === 0) return { flows: [], limitations: [] };

  // Tainted roots and the PATH each one stands for. `req` → '' (its own members are the path);
  // `const { billing } = await req.json()` → billing stands for 'billing', so a read of
  // `billing.email` normalizes to 'billing.email' and can be compared with the input path.
  // Bindings whose members ARE the input paths, so they contribute no segment: a request source
  // (`{ body }`), and the validated-payload conventions of the server-fn frameworks (`{ data }` for
  // TanStack). Getting this wrong shifts every path by one segment and silently kills all matching.
  const CONTAINER_KEYS = new Set([...REQ_SOURCES, 'data', 'input', 'payload']);
  const rootPath = new Map<string, string>();
  const addRoot = (name: string, path: string) => { if (!rootPath.has(name)) rootPath.set(name, path); };
  for (const p of params ?? []) {
    if (!p?.name) continue;
    if (ts.isIdentifier(p.name)) addRoot(p.name.text, '');
    else if (ts.isObjectBindingPattern(p.name)) {
      for (const el of p.name.elements) {
        if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) continue;
        const key = bindingKey(el, ts);
        // A destructured request source (`{ body }`) is a container: its members ARE the paths.
        addRoot(el.name.text, key && CONTAINER_KEYS.has(key) ? '' : key ?? el.name.text);
      }
    }
  }

  // Does this initializer carry request data? Includes `Schema.parse(await req.json())`: VALIDATION IS
  // NOT SANITIZATION — a validated value is still attacker-controlled, and treating it as clean would
  // silently drop every flow in a validated handler (the common TanStack/Next shape).
  const requestReadPath = (init: any): string | undefined => {
    let cur = init;
    while (cur && (ts.isAwaitExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur))) cur = cur.expression;
    if (!cur) return undefined;
    if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
      const m = cur.expression.name.text;
      if (['json', 'formData', 'text'].includes(m)) {
        const root = rootIdentifier(cur.expression.expression, ts);
        return root && rootPath.has(root) ? '' : undefined;
      }
      if (['parse', 'safeParse', 'validate', 'cast'].includes(m)) {
        for (const a of cur.arguments) {
          const inner = requestReadPath(a);
          if (inner !== undefined) return inner; // taint survives validation
        }
        return undefined;
      }
    }
    const p = pathFromTainted(cur, ts, rootPath);
    return p;
  };

  const aliasVisit = (n: any) => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const base = requestReadPath(n.initializer);
      if (base !== undefined) {
        if (ts.isIdentifier(n.name)) addRoot(n.name.text, base);
        else if (ts.isObjectBindingPattern(n.name)) {
          for (const el of n.name.elements) {
            if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) continue;
            const key = bindingKey(el, ts);
            addRoot(el.name.text, join2(base, key ?? el.name.text));
          }
        }
      }
    }
    ts.forEachChild(n, aliasVisit);
  };
  aliasVisit(bodyNode);

  // Index every call by its start offset so a sink's span identifies its EXACT call node.
  // Keyed by start+end: in `db.from(t).insert(x)` BOTH calls start at `db`, so the start offset alone
  // is ambiguous — the end distinguishes them.
  const callBySpan = new Map<string, any>();
  const callVisit = (n: any) => {
    // NewExpression too, or `new Function(...)` — inventoried as an eval sink — could never be located,
    // leaving its flows permanently heuristic and its argument-role entry unreachable.
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      try { callBySpan.set(`${n.getStart()}:${n.getEnd()}`, n); } catch { /* synthetic */ }
    }
    ts.forEachChild(n, callVisit);
  };
  callVisit(bodyNode);

  const flows: Flow[] = [];
  const allLimits: Limitation[] = [];
  for (const sink of sinks) {
    // A sink from an imported module has no call site here — never claim precise for it.
    const node = sink.file === undefined && sink.start !== undefined && sink.end !== undefined
      ? callBySpan.get(`${sink.start}:${sink.end}`)
      : undefined;
    // path → the argument ROLES it was read into. Per-argument attribution is what makes a candidate
    // possible: the same value in `url` vs `body`, or `path` vs `content`, implies different mitigations.
    const reads = new Map<string, Set<ArgumentRole>>();
    const sinkLimits: Limitation[] = [];
    if (node) {
      // ONLY this sink call's own arguments, plus other calls in the SAME fluent chain
      // (`.update({…}).eq('id', data.id)` is one operation). Never the enclosing statement: a sibling
      // expression such as `Promise.all([audit(data.title), db.insert({…})])` must not lend evidence.
      for (const call of fluentChainCalls(node, ts)) {
        const method = calleeName(call, ts);
        const args = call.arguments ?? [];
        for (const a of args) for (const l of sinkArgumentLimitations(a, ts, rootPath)) sinkLimits.push(l);
        for (let i = 0; i < args.length; i++) {
          const role = argumentRoleOf(sink.kind, method, i, args.length);
          for (const path of taintedReadPaths(args[i], ts, rootPath)) {
            const set = reads.get(path) ?? new Set<ArgumentRole>();
            set.add(role);
            reads.set(path, set);
          }
        }
      }
    }
    for (const input of inputs) {
      const inputPath = normalizePath(input.name);
      // Exact path, or the input is an ANCESTOR of what was read (`billing` covers `billing.email`).
      // A mere shared leaf name is NOT evidence: `billing.email` and `shipping.email` are different.
      const matched = [...reads.entries()].filter(([r]) => r === inputPath || r.startsWith(inputPath + '.'));
      const precise = matched.length > 0;
      const roles = new Set<ArgumentRole>(matched.flatMap(([, rs]) => [...rs]));
      // Prefer a role that maps to a mitigation class over a generic one (a value can reach two args).
      const family = [...roles].map((r) => CANDIDATE_FAMILIES[sink.kind]?.[r]).find(Boolean);
      const argumentRole = family
        ? [...roles].find((r) => CANDIDATE_FAMILIES[sink.kind]?.[r])
        : [...roles].find((r) => r !== 'unknown') ?? (precise ? 'unknown' : undefined);

      // Deliberately SEPARATE from confidence: `precise` means "the source reaches the sink", which is
      // not authorization to block traffic. Every remaining obstacle is listed, so this doubles as the
      // queue for improving the extractor/adapters rather than silently losing the opportunity.
      const reasons: string[] = [];
      if (!precise) reasons.push('flow evidence is heuristic, not precise');
      if (!input.runtimeParameter) reasons.push(input.runtimeParameterReason ?? 'input has no runtime parameter');
      if (sink.file !== undefined) reasons.push('sink is in an imported module: no local call-site evidence');
      if (sink.start === undefined) reasons.push('sink call could not be located in the source');
      if (sink.attribution === undefined) {
        reasons.push(`sink receiver could not be traced to a dependency (${sink.kind}.${sink.op ?? '?'} on an unresolved receiver): a rule here would be a guess`);
      }
      if (precise && argumentRole === 'unknown') reasons.push(`sink argument role is not modelled for ${sink.kind}.${sink.op ?? '?'}`);
      // A dynamic key or a spread in this sink's arguments means no coordinate can name the field that
      // actually reaches it — report the specific cause rather than a generic "heuristic".
      for (const l of sinkLimits) {
        reasons.push(l.kind === 'dynamic-key'
          ? `dynamic computed key reaches this sink (${l.detail}): the field cannot be named by a parameter`
          : `spread reaches this sink (${l.detail}): the specific field is not identifiable`);
      }
      if (precise && argumentRole && argumentRole !== 'unknown' && !family) {
        // e.g. a request value in a parameterized db `values` object: real reachability, but not a
        // pattern a generic blocking rule can express.
        reasons.push(`argument role "${argumentRole}" on a ${sink.kind} sink is not a blockable pattern on its own`);
      }
      flows.push({
        input: input.name,
        sink,
        confidence: precise ? 'precise' : 'heuristic',
        line: sink.line,
        ...(argumentRole ? { argumentRole } : {}),
        ...(family ? { candidateFamily: family } : {}),
        ruleGeneratable: reasons.length === 0,
        ruleGeneratableReasons: reasons,
      });
    }
    for (const l of sinkLimits) allLimits.push(l);
  }
  return { flows, limitations: dedupeLimitations(allLimits) };
}

function dedupeLimitations(list: Limitation[]): Limitation[] {
  const seen = new Set<string>();
  return list.filter((l) => {
    const k = `${l.kind}:${l.detail}:${l.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Join two path segments, tolerating an empty base. */
function join2(base: string, seg: string): string {
  return base ? `${base}.${seg}` : seg;
}

/**
 * Canonical form for comparing paths: index/array tokens are erased and empty segments collapsed, so
 * `tags[0].label`, `tags[].label` and `tags.label` all compare equal, while DISTINCT paths such as
 * `billing.email` and `shipping.email` stay distinct (the previous leaf-only comparison conflated them).
 */
function normalizePath(path: string): string {
  return path
    .replace(/\[\d*\]/g, '')
    .split('.')
    .filter(Boolean)
    .join('.');
}

/**
 * Calls belonging to the same fluent chain as `call` — the same logical operation. Walking UP stops at
 * anything that is not a continuation of the chain (an array literal, an argument position), which is
 * what keeps a sibling expression in the same statement from lending evidence.
 */
function fluentChainCalls(call: any, ts: TsModule): any[] {
  let root = call;
  for (;;) {
    const p = root.parent;
    if (p && ts.isPropertyAccessExpression(p) && p.expression === root) { root = p; continue; }
    if (p && ts.isCallExpression(p) && p.expression === root) { root = p; continue; }
    if (p && (ts.isAwaitExpression(p) || ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p)) && p.expression === root) { root = p; continue; }
    break;
  }
  const out: any[] = [];
  const collect = (n: any) => {
    if (!n) return;
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) out.push(n);
    if (ts.isCallExpression(n) || ts.isPropertyAccessExpression(n) || ts.isAwaitExpression(n) || ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n)) {
      collect(n.expression);
    }
  };
  collect(root);
  return out;
}

/**
 * The canonical PATHS of values genuinely read from a tainted source inside `node` — the evidence behind
 * a `precise` flow. Full paths, not leaf names: `data.shipping.email` yields `shipping.email`, so it can
 * never be mistaken for the distinct input `billing.email`. Array indices normalize to `[]`.
 * Property KEYS, member names and binding names are not reads.
 */
function taintedReadPaths(node: any, ts: TsModule, rootPath: Map<string, string>): Set<string> {
  const out = new Set<string>();
  const visit = (n: any) => {
    if (!n) return;
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      const path = pathFromTainted(n, ts, rootPath);
      if (path !== undefined) { out.add(path); return; } // the inner nodes are the path, not separate reads
    }
    if (ts.isIdentifier(n) && rootPath.has(n.text) && isValueRead(n, ts)) {
      const p = rootPath.get(n.text)!;
      if (p) out.add(normalizePath(p));
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/**
 * Shapes that defeat parameter pinning, found in a sink call's arguments. Reporting these is the point:
 * "we could not model this" is far more useful to an operator than an endpoint that silently shows no
 * flow, and it is the queue for improving the extractor.
 *   - `insert({ v: body[field] })` → the field is chosen at runtime; no coordinate can name it.
 *   - `insert({ ...body })`        → the whole payload reaches the sink; which field is unidentifiable.
 */
function sinkArgumentLimitations(node: any, ts: TsModule, rootPath: Map<string, string>): Limitation[] {
  const out: Limitation[] = [];
  const seen = new Set<string>();
  const add = (kind: Limitation['kind'], detail: string, n: any) => {
    const key = `${kind}:${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, detail, line: lineOf(n) });
  };
  const text = (n: any) => {
    try { return String(n.getText()).replace(/\s+/g, ' ').slice(0, 120); } catch { return '<expression>'; }
  };
  const visit = (n: any) => {
    if (!n) return;
    // A computed member read off tainted data with a non-literal index.
    if (ts.isElementAccessExpression(n)) {
      const root = rootIdentifier(n.expression, ts);
      const arg = n.argumentExpression;
      if (root && rootPath.has(root) && arg && !ts.isStringLiteralLike(arg) && !ts.isNumericLiteral(arg)) {
        add('dynamic-key', text(n), n);
      }
    }
    // A spread of tainted data into the sink's argument.
    if ((ts.isSpreadAssignment?.(n) || ts.isSpreadElement(n)) && n.expression) {
      const root = rootIdentifier(n.expression, ts);
      if (root && rootPath.has(root)) add('spread-into-sink', text(n.parent ?? n), n);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** Canonical path of a member/element access rooted in a tainted binding, or undefined if not tainted. */
function pathFromTainted(node: any, ts: TsModule, rootPath: Map<string, string>): string | undefined {
  const segs: string[] = [];
  let cur = node;
  for (;;) {
    if (ts.isPropertyAccessExpression(cur)) { segs.unshift(cur.name.text); cur = cur.expression; continue; }
    if (ts.isElementAccessExpression(cur)) {
      const a = cur.argumentExpression;
      segs.unshift(a && ts.isStringLiteralLike(a) ? a.text : '[]');
      cur = cur.expression;
      continue;
    }
    if (ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isAwaitExpression(cur)) { cur = cur.expression; continue; }
    break;
  }
  if (!cur || !ts.isIdentifier(cur)) return undefined;
  const base = rootPath.get(cur.text);
  if (base === undefined) return undefined;
  // Drop a leading NAMESPACE segment (`req.body.webhookUrl` → `webhookUrl`). Input names — and the
  // runtime coordinates derived from them — are relative to their namespace (`post.webhookUrl`), so
  // leaving `body.` in the read path would fail to match the very inputs it came from. Without this,
  // the highest-value flows (`req.body.webhookUrl` → fetch, `req.body.command` → exec) never reach
  // `precise`.
  if (base === '' && segs.length > 1 && REQ_SOURCES.includes(segs[0]!)) segs.shift();
  return normalizePath([base, ...segs].filter(Boolean).join('.'));
}
