import type { AddressSpace, ApiInvocation, ArgumentRole, DependencyInputFlow, Flow, InputField, Limitation, Sink, TsModule } from './types.js';
import { bindingKey, calleeName, isValueRead, lineOf, rootIdentifierNode } from './ast.js';
import { declarationOf, isGlobal } from './scope.js';
import { REQ_SOURCES } from './inputs.js';
import { addressSpaceOf } from './coordinates.js';
import { argumentRoleOf, CANDIDATE_FAMILIES } from './sinks.js';

const MAX_DEPENDENCY_INPUT_FLOWS_PER_ENDPOINT = 100;

/** A tainted binding: the path prefix it stands for, and the request region it came from if known. */
/**
 * `accessor`: the binding is an object whose `.get('<name>')` returns a request field — a `Headers`, a
 * cookie store, or a `FormData`. Only such an object makes `.get('<name>')` a read of `<name>`; on
 * anything else it is an application method, and its argument names nothing.
 */
interface Root {
  path: string;
  space?: AddressSpace;
  accessor?: boolean;
  /**
   * The binding is the request object itself. Only on the request are `headers`, `cookies`, `query`,
   * `body` and `params` namespaces: on a parsed body or any other value they are ordinary field names,
   * and reading them as namespaces would move a body field into another address space.
   */
  request?: boolean;
  /**
   * The binding, or one it was derived from, is assigned again after its declaration. What reaches a
   * sink through it may be the request value or whatever replaced it, so a read through it is evidence
   * of reachability but never of an exact, untransformed value.
   */
  reassigned?: boolean;
  /**
   * The binding is a URL of the request (`new URL(request.url)`, `request.nextUrl`, an event's `url`).
   * Its members are not request fields: only its `searchParams` read the query string.
   */
  url?: boolean;
}

/**
 * Tainted bindings keyed by the declaration an occurrence resolves to, never by its name: a block-scoped
 * or callback binding that happens to share a request binding's name is a different variable.
 */
class Roots {
  private readonly byDeclaration = new Map<any, Root>();

  constructor(private readonly ts: TsModule) {}

  add(declaration: any, root: Root): void {
    if (!this.byDeclaration.has(declaration)) this.byDeclaration.set(declaration, root);
  }

  /** The root an identifier occurrence refers to, when its binding is tainted. */
  get(id: any): Root | undefined {
    const declaration = declarationOf(id, this.ts);

    return declaration === undefined ? undefined : this.byDeclaration.get(declaration);
  }
}

/** Declarations whose binding is the target of an assignment, an update or a `for…of`/`for…in` head. */
function reassignedDeclarations(body: any, ts: TsModule): Set<any> {
  const out = new Set<any>();
  const target = (n: any): void => {
    if (!n) return;
    if (ts.isParenthesizedExpression(n)) return target(n.expression);
    if (ts.isIdentifier(n)) {
      const declaration = declarationOf(n, ts);
      if (declaration !== undefined) out.add(declaration);
      return;
    }
    // Destructuring assignment: `({ cmd } = other)`, `[cmd] = list`.
    if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) {
        if (ts.isShorthandPropertyAssignment(p)) target(p.name);
        else if (ts.isPropertyAssignment(p)) target(p.initializer);
        else if (ts.isSpreadAssignment(p)) target(p.expression);
      }
      return;
    }
    if (ts.isArrayLiteralExpression(n)) {
      for (const e of n.elements) target(ts.isSpreadElement(e) ? e.expression : e);
      return;
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) target(n.left);
  };
  const visit = (n: any) => {
    if (!n) return;
    if (ts.isBinaryExpression(n)
        && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      target(n.left);
    }
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n))
        && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) {
      target(n.operand);
    }
    if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) target(n.initializer);
    ts.forEachChild(n, visit);
  };
  visit(body);

  return out;
}

/** Request namespaces whose `.get('<name>')` reads the field `<name>`. */
const ACCESSOR_NAMESPACES = new Set(['headers', 'cookies']);

/** The address space a request-namespace binding key implies (`query` → get, `params` → route-param). */
function spaceOfKey(key: string | undefined): AddressSpace | undefined {
  if (key === 'query') return 'get';
  if (key === 'params') return 'route-param';
  if (key === 'body') return 'post';
  // `data` / `input` / `payload`: a server-function argument, which the guard feeds through as the body.
  if (key === 'data' || key === 'input' || key === 'payload') return 'post';
  // Without these, a read off a destructured `({ headers })` carried NO space — and a space of `undefined`
  // matches any input of the same name, so a header read could lend its evidence to a body field called
  // `token`. Keeping the spaces distinct is what stops a rule being pinned to the wrong parameter.
  if (key === 'headers') return 'server';
  if (key === 'cookies') return 'cookie';
  if (key === 'files') return 'files';
  return undefined;
}

// --- input → sink flow linking ---------------------------------------------
// Evidence-backed data links: for each sink, does an INPUT identifier/path appear inside the sink
// call's arguments? "Tainted" roots are the handler's own parameter names (`{ data }`, `req`) plus any
// local alias of them (`const body = await request.json()`, `const { title } = data`).
//
// Deliberately conservative: a match yields one of the two `*-local` tiers; no match yields `imported` /
// `heuristic` / `unknown` depending on WHY nothing was seen. It never claims a flow it didn't see, which
// is the point — a consumer pinning a rule should require a proven tier (see `isProvenFlow`) and treat
// the rest as "may reach". Matching is per (address space, path): a read of `query.id` is not evidence
// about the body field `id`.
// Spread onto an endpoint: `flows`, plus `limitations` only when there are any (keeps the common case clean).
export function linkedFlows(body: any, params: any, inputs: InputField[], sinks: Sink[], ts: TsModule, invocations: ApiInvocation[] = []): { flows: Flow[]; limitations?: Limitation[]; dependencyInputFlows?: DependencyInputFlow[]; dependencyInputFlowsTruncated?: true } {
  const { flows, limitations, dependencyInputFlows, dependencyInputFlowsTruncated } = linkFlows(body, params, inputs, sinks, ts, invocations);
  return {
    flows,
    ...(limitations.length > 0 ? { limitations } : {}),
    ...(dependencyInputFlows.length > 0 ? { dependencyInputFlows } : {}),
    ...(dependencyInputFlowsTruncated ? { dependencyInputFlowsTruncated: true as const } : {}),
  };
}

function linkFlows(
  bodyNode: any,
  params: any,
  inputs: InputField[],
  sinks: Sink[],
  ts: TsModule,
  invocations: ApiInvocation[],
): { flows: Flow[]; limitations: Limitation[]; dependencyInputFlows: DependencyInputFlow[]; dependencyInputFlowsTruncated: boolean } {
  if (!bodyNode || inputs.length === 0 || (sinks.length === 0 && invocations.length === 0)) {
    return { flows: [], limitations: [], dependencyInputFlows: [], dependencyInputFlowsTruncated: false };
  }

  // Tainted roots and the PATH each one stands for. `req` → '' (its own members are the path);
  // `const { billing } = await req.json()` → billing stands for 'billing', so a read of
  // `billing.email` normalizes to 'billing.email' and can be compared with the input path.
  // Bindings whose members ARE the input paths, so they contribute no segment: a request source
  // (`{ body }`), and the validated-payload conventions of the server-fn frameworks (`{ data }` for
  // TanStack). Getting this wrong shifts every path by one segment and silently kills all matching.
  const CONTAINER_KEYS = new Set([...REQ_SOURCES, 'data', 'input', 'payload']);
  // Each tainted root also carries the ADDRESS SPACE it was bound from, when that is known. A bare `req`
  // has none — its next segment decides (`req.query.x` vs `req.body.x`) — but `({ query: q })` fixes `q`
  // in `get` for good. Without this the space was dropped along with the namespace segment, so a read of
  // `query.id` was indistinguishable from a read of `body.id` and could match either input.
  const rootPath = new Roots(ts);
  // A binding assigned again after its declaration may no longer hold what it was declared with.
  const reassigned = reassignedDeclarations(bodyNode, ts);
  const addRoot = (declaration: any, path: string, space?: AddressSpace, accessor = false, request = false, inherited = false, url = false) => {
    const changed = inherited || reassigned.has(declaration);
    rootPath.add(declaration, { path, space, ...(accessor ? { accessor } : {}), ...(request ? { request } : {}), ...(changed ? { reassigned: true } : {}), ...(url ? { url } : {}) });
  };
  for (const [index, p] of (params ?? []).entries()) {
    if (!p?.name) continue;
    // The handler's first parameter is its request; later ones (`res`, a route context) are not.
    if (ts.isIdentifier(p.name)) addRoot(p.name, '', undefined, false, index === 0);
    else if (ts.isObjectBindingPattern(p.name)) {
      for (const el of p.name.elements) {
        if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) continue;
        const key = bindingKey(el, ts);
        // A request event (SvelteKit, Astro) carries the request and its URL: `({ request, url })`.
        if (index === 0 && key === 'request') { addRoot(el.name, '', undefined, false, true); continue; }
        if (index === 0 && key === 'url') { addRoot(el.name, '', undefined, false, false, false, true); continue; }
        // A destructured request source (`{ body }`) is a container: its members ARE the paths.
        const container = key !== undefined && CONTAINER_KEYS.has(key);
        addRoot(el.name, container ? '' : key ?? el.name.text, container ? spaceOfKey(key) : undefined, container && ACCESSOR_NAMESPACES.has(key!));
      }
    }
  }

  // Does this initializer carry request data? Includes `Schema.parse(await req.json())`: VALIDATION IS
  // NOT SANITIZATION — a validated value is still attacker-controlled, and treating it as clean would
  // silently drop every flow in a validated handler (the common TanStack/Next shape).
  const requestReadPath = (init: any): Root | undefined => {
    let cur = init;
    while (cur && (ts.isAwaitExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur))) cur = cur.expression;
    if (!cur) return undefined;
    const params = searchParamsOrigin(cur, ts, rootPath);
    if (params) return { path: '', space: 'get', accessor: true, ...carried(params) };
    const url = requestUrlOrigin(cur, ts, rootPath);
    if (url) return { path: '', url: true, ...carried(url) };
    if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
      const m = cur.expression.name.text;
      if (['json', 'formData', 'text'].includes(m)) {
        const root = rootIdentifierNode(cur.expression.expression, ts);
        const owner = root ? rootPath.get(root) : undefined;
        // A body read: whatever the field names turn out to be, they are addressed in `post`.
        if (!owner) return undefined;

        return m === 'formData' ? { path: '', space: 'post', accessor: true, ...carried(owner) } : { path: '', space: 'post', ...carried(owner) };
      }
      if (['parse', 'safeParse', 'validate', 'cast'].includes(m)) {
        for (const a of cur.arguments) {
          const inner = requestReadPath(a);
          if (inner !== undefined) return inner; // taint survives validation
        }
        return undefined;
      }
    }
    return pathFromTainted(cur, ts, rootPath) ?? accessorRead(cur, ts, rootPath);
  };

  const aliasVisit = (n: any) => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const base = requestReadPath(n.initializer);
      if (base !== undefined) {
        if (ts.isIdentifier(n.name)) addRoot(n.name, base.path, base.space, base.accessor === true, base.request === true, base.reassigned === true, base.url === true);
        else if (ts.isObjectBindingPattern(n.name)) {
          for (const el of n.name.elements) {
            if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) continue;
            const key = bindingKey(el, ts);
            // Off a URL of the request, only `searchParams` is request data.
            if (base.url === true) {
              if (key === 'searchParams') addRoot(el.name, '', 'get', true, false, base.reassigned === true);
              continue;
            }
            // A request namespace (`query`, `headers`, …) only when destructured from the request itself:
            // off a parsed body the same key is an ordinary field, and its members are paths under it.
            const namespace = base.request === true && key !== undefined && REQ_SOURCES.includes(key);
            const container = base.path === '' && key !== undefined && CONTAINER_KEYS.has(key) && (namespace || !REQ_SOURCES.includes(key));
            // `const { query: q } = req` — the binding KEY names the space when the base has none yet.
            const space = base.space ?? (namespace ? spaceOfKey(key) : undefined);
            addRoot(el.name, container ? '' : join2(base.path, key ?? el.name.text), space, namespace && ACCESSOR_NAMESPACES.has(key!), false, base.reassigned === true);
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
    // A sink from an imported module has no call site here — its flows can only be `imported`.
    const node = sink.file === undefined && sink.start !== undefined && sink.end !== undefined
      ? callBySpan.get(`${sink.start}:${sink.end}`)
      : undefined;
    // path → the argument ROLES it was read into. Per-argument attribution is what makes a candidate
    // possible: the same value in `url` vs `body`, or `path` vs `content`, implies different mitigations.
    // Keyed by `<space>:<path>` so a read of `query.id` cannot lend its evidence to the body field `id`.
    const reads = new Map<string, { read: Root; roles: Set<ArgumentRole>; exact: boolean }>();
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
          // Is the ARGUMENT ITSELF the read (`readFileSync(req.body.p)`), or does the read sit inside a
          // larger expression (`readFileSync('/tmp/' + req.body.p)`)? Both mean the value arrives in the
          // same parameter, but only the first says what reaches the sink is exactly what arrived — the
          // distinction a server needs before promoting a rule to blocking without a human.
          const whole = pathFromTainted(args[i], ts, rootPath) ?? accessorRead(args[i], ts, rootPath);
          for (const read of taintedReadPaths(args[i], ts, rootPath)) {
            const key = `${read.space ?? '*'}:${read.path}`;
            const exact = whole !== undefined && whole.path === read.path && whole.space === read.space && whole.reassigned !== true;
            const entry = reads.get(key) ?? { read, roles: new Set<ArgumentRole>(), exact: false };
            entry.roles.add(role);
            entry.exact = entry.exact || exact;
            reads.set(key, entry);
          }
        }
      }
    }
    for (const input of inputs) {
      const inputPath = normalizePath(input.name);
      const inputSpace = addressSpaceOf(input.source);
      // Exact path, or the input is an ANCESTOR of what was read (`billing` covers `billing.email`).
      // A mere shared leaf name is NOT evidence: `billing.email` and `shipping.email` are different.
      // The SPACE must agree too, or the two `id`s of `query.id` / `body.id` trade evidence and a rule
      // gets pinned to whichever the extractor happened to keep. A read whose space is unknown (a bare
      // `req` handed to a helper, say) still matches on path alone — recall, at heuristic strength.
      const matched = [...reads.values()].filter(({ read }) =>
        (read.space === undefined || read.space === inputSpace)
        && (read.path === inputPath || read.path.startsWith(inputPath + '.')));
      const proven = matched.length > 0;
      // Weakest-honest tier that fits the evidence.
      const confidence: Flow['confidence'] = proven
        ? (matched.some((m) => m.exact) ? 'exact-local' : 'transformed-local')
        : sink.file !== undefined ? 'imported'
        // No span at all (a synthetic node) means no evidence is even possible. A sink whose span exists
        // but sits outside this handler — reached through a same-file helper — is ordinary co-occurrence:
        // located, just not attributable to an argument here. Calling that "unknown" would overstate it.
        : sink.start === undefined ? 'unknown'
        : 'heuristic';
      const roles = new Set<ArgumentRole>(matched.flatMap(({ roles: rs }) => [...rs]));
      // Prefer a role that maps to a mitigation class over a generic one (a value can reach two args).
      // A sink whose package does not establish this API cannot support the mitigation class either:
      // labelling a GraphQL `.query()` as the sql-injection family would mis-classify it for any consumer
      // that reads `candidateFamily` without also checking `ruleGeneratable`.
      const family = sink.apiUnconfirmed
        ? undefined
        : [...roles].map((r) => CANDIDATE_FAMILIES[sink.kind]?.[r]).find(Boolean);
      const argumentRole = family
        ? [...roles].find((r) => CANDIDATE_FAMILIES[sink.kind]?.[r])
        : [...roles].find((r) => r !== 'unknown') ?? (proven ? 'unknown' : undefined);

      // Deliberately SEPARATE from confidence: a proven tier means "the source reaches the sink", which is
      // not authorization to block traffic. Every remaining obstacle is listed, so this doubles as the
      // queue for improving the extractor/adapters rather than silently losing the opportunity.
      const reasons: string[] = [];
      if (!proven) reasons.push(`flow evidence is "${confidence}": no proven local read of this input into the sink call`);
      if (!input.runtimeParameter) reasons.push(input.runtimeParameterReason ?? 'input has no runtime parameter');
      if (sink.file !== undefined) reasons.push('sink is in an imported module: no local call-site evidence');
      if (sink.start === undefined) reasons.push('sink call could not be located in the source');
      // Only a receiver traced to a dependency ('import') or a genuine runtime global earns a rule.
      // 'inferred' is deliberately NOT enough: the package came from some OTHER import in the file, not
      // from the receiver, so `res.locals.db.query(x)` in a file that happens to import `pg` looks
      // identical to a real pool — and `res.locals.db` may be any app object. Such sinks stay in the
      // inventory for review; they just cannot compile a rule that blocks live traffic on a guess.
      if (sink.apiUnconfirmed) {
        reasons.push(`sink package "${sink.package}" is not a known ${sink.kind} provider: it does not establish a ${sink.kind} API (method name alone is not evidence)`);
      }
      if (sink.attribution !== 'import' && sink.attribution !== 'global') {
        reasons.push(sink.attribution === 'inferred'
          ? `sink package "${sink.package}" was inferred from the file's other imports, not from the receiver (${sink.kind}.${sink.op ?? '?'}): the receiver may be any app object`
          : `sink receiver could not be traced to a dependency (${sink.kind}.${sink.op ?? '?'} on an unresolved receiver): a rule here would be a guess`);
      }
      if (proven && argumentRole === 'unknown') reasons.push(`sink argument role is not modelled for ${sink.kind}.${sink.op ?? '?'}`);
      // A dynamic key or a spread in this sink's arguments means no coordinate can name the field that
      // actually reaches it — report the specific cause rather than a generic "heuristic".
      for (const l of sinkLimits) {
        reasons.push(l.kind === 'dynamic-key'
          ? `dynamic computed key reaches this sink (${l.detail}): the field cannot be named by a parameter`
          : `spread reaches this sink (${l.detail}): the specific field is not identifiable`);
      }
      // `!sink.apiUnconfirmed`: when the family was withheld because the PACKAGE does not establish this
      // API, the role is not what's wrong — role "sql" is normally blockable, and saying otherwise sends a
      // reviewer to look at the wrong thing. The package reason above already explains the refusal.
      if (proven && argumentRole && argumentRole !== 'unknown' && !family && !sink.apiUnconfirmed) {
        // e.g. a request value in a parameterized db `values` object: real reachability, but not a
        // pattern a generic blocking rule can express.
        reasons.push(`argument role "${argumentRole}" on a ${sink.kind} sink is not a blockable pattern on its own`);
      }
      flows.push({
        input: input.name,
        inputId: input.id,
        sink,
        confidence,
        line: sink.line,
        ...(argumentRole ? { argumentRole } : {}),
        ...(family ? { candidateFamily: family } : {}),
        ruleGeneratable: reasons.length === 0,
        ruleGeneratableReasons: reasons,
      });
    }
    for (const l of sinkLimits) allLimits.push(l);
  }
  const dependencyInputFlows: DependencyInputFlow[] = [];
  let dependencyInputFlowsTruncated = false;
  const seenDependencyInputs = new Set<string>();
  const modeledCalls = new Set(sinks.filter((s) => s.file === undefined && s.start !== undefined && s.end !== undefined)
    .map((s) => `${s.start}:${s.end}`));
  for (const invocation of invocations) {
    if (invocation.package.startsWith('node:')) continue;
    for (const site of invocation.sites) {
      if (site.start === undefined || site.end === undefined) continue;
      const span = `${site.start}:${site.end}`;
      if (modeledCalls.has(span)) continue;
      const call = callBySpan.get(span);
      if (!call) continue;
      const args = call.arguments ?? [];
      for (let argumentIndex = 0; argumentIndex < args.length; argumentIndex++) {
        const argument = args[argumentIndex];
        if (sinkArgumentLimitations(argument, ts, rootPath).length > 0) continue;
        const whole = pathFromTainted(argument, ts, rootPath);
        for (const read of taintedReadPaths(argument, ts, rootPath, false)) {
          // An unlocated request namespace is not enough to identify which runtime parameter a rule
          // would inspect; keep this list to links whose address space is known.
          if (read.space === undefined) continue;
          for (const input of inputs) {
            if (addressSpaceOf(input.source) !== read.space) continue;
            const inputPath = normalizePath(input.name);
            if (read.path !== inputPath && !read.path.startsWith(inputPath + '.')) continue;
            const key = `${span}:${argumentIndex}:${input.id}:${invocation.package}:${invocation.symbol}`;
            if (seenDependencyInputs.has(key)) continue;
            seenDependencyInputs.add(key);
            if (dependencyInputFlows.length >= MAX_DEPENDENCY_INPUT_FLOWS_PER_ENDPOINT) {
              dependencyInputFlowsTruncated = true;
              continue;
            }
            dependencyInputFlows.push({
              input: input.name,
              inputId: input.id,
              package: invocation.package,
              specifier: invocation.specifiers[0]!,
              api: invocation.api,
              symbol: invocation.symbol,
              kind: invocation.kind,
              resolution: invocation.resolution,
              argumentIndex,
              argumentUse: whole?.path === read.path && whole.space === read.space && whole.reassigned !== true ? 'direct' : 'within-expression',
              line: site.line,
              start: site.start,
              end: site.end,
            });
          }
        }
      }
    }
  }
  return { flows, limitations: dedupeLimitations(allLimits), dependencyInputFlows, dependencyInputFlowsTruncated };
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
 * a proven flow. Full paths, not leaf names: `data.shipping.email` yields `shipping.email`, so it can
 * never be mistaken for the distinct input `billing.email`. Array indices normalize to `[]`.
 * Property KEYS, member names and binding names are not reads.
 */
function taintedReadPaths(node: any, ts: TsModule, rootPath: Roots, includeDeferredBodies = true): Root[] {
  const out: Root[] = [];
  const seen = new Set<string>();
  const add = (r: Root) => {
    const key = `${r.space ?? '*'}:${r.path}`;
    if (!seen.has(key)) { seen.add(key); out.push(r); }
  };
  const visit = (n: any) => {
    if (!n) return;
    if (!includeDeferredBodies && (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n))) return;
    if (ts.isCallExpression(n)) {
      const accessed = accessorRead(n, ts, rootPath);
      if (accessed !== undefined) { add(accessed); return; }
      // A method called on a value (`req.body.cmd.trim()`) reads the value it is called on. Its name is
      // not a field of it, so the callee is not read as a path.
      if (ts.isPropertyAccessExpression(n.expression)) {
        visit(n.expression.expression);
        for (const arg of n.arguments ?? []) visit(arg);
        return;
      }
    }
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      const read = pathFromTainted(n, ts, rootPath);
      if (read !== undefined) { add(read); return; } // the inner nodes are the path, not separate reads
    }
    const bound = ts.isIdentifier(n) && isValueRead(n, ts) ? rootPath.get(n) : undefined;
    if (bound) {
      if (bound.path) add({ path: normalizePath(bound.path), space: bound.space });
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
function sinkArgumentLimitations(node: any, ts: TsModule, rootPath: Roots): Limitation[] {
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
      const root = rootIdentifierNode(n.expression, ts);
      const arg = n.argumentExpression;
      if (root && rootPath.get(root) && arg && !ts.isStringLiteralLike(arg) && !ts.isNumericLiteral(arg)) {
        add('dynamic-key', text(n), n);
      }
    }
    // A spread of tainted data into the sink's argument.
    if ((ts.isSpreadAssignment?.(n) || ts.isSpreadElement(n)) && n.expression) {
      const root = rootIdentifierNode(n.expression, ts);
      if (root && rootPath.get(root)) add('spread-into-sink', text(n.parent ?? n), n);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/**
 * `<accessor>.get('<name>')`: the value named `<name>`, read exactly as it arrived.
 *
 * `request.headers.get('x-cmd')`, `request.cookies.get('sid')` and `form.get('cmd')` are accessors of a
 * request namespace, so the read is of `x-cmd` / `sid` / `cmd` — not of a field called `get`, and not a
 * transformation of anything. Only a string-literal name is a read of a known field, and only on an
 * accessor: `req.body.account.get('name')` is an application method whose result can be anything.
 */
function accessorRead(node: any, ts: TsModule, rootPath: Roots): Root | undefined {
  let cur = node;
  while (cur && (ts.isAwaitExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur))) cur = cur.expression;
  if (!cur || !ts.isCallExpression(cur) || !ts.isPropertyAccessExpression(cur.expression)) return undefined;
  const [name] = cur.arguments;
  if (cur.arguments.length !== 1 || !name || !ts.isStringLiteralLike(name)) return undefined;
  const method = cur.expression.name.text;
  const receiver = cur.expression.expression;
  // Hono: `c.req.query('q')`, `c.req.param('id')`, `c.req.header('x-token')` on the handler's context.
  const hono = HONO_ACCESSOR_SPACES[method];
  if (hono && ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'req' && ts.isIdentifier(receiver.expression)) {
    const context = rootPath.get(receiver.expression);
    if (context?.request === true) return { path: normalizePath(name.text), space: hono, ...carried(context) };
  }
  if (method !== 'get') return undefined;
  // `new URL(request.url).searchParams.get('q')`: the query-string field `q`.
  const params = ts.isIdentifier(receiver) ? undefined : searchParamsOrigin(receiver, ts, rootPath);
  if (params) return { path: normalizePath(name.text), space: 'get', ...carried(params) };
  if (!isAccessor(receiver, ts, rootPath)) return undefined;

  return pathFromTainted(receiver, ts, rootPath, [name.text]);
}

/** Hono request accessors and the address space each one reads. */
const HONO_ACCESSOR_SPACES: Record<string, AddressSpace> = { query: 'get', param: 'route-param', header: 'server' };

/** The reassignment marker of the binding a read derives from, to carry onto the read. */
function carried(origin: Root): { reassigned?: true } {
  return origin.reassigned === true ? { reassigned: true } : {};
}

/**
 * When `node` is a URL of the request — `new URL(request.url)` (also on a Hono context's `req`),
 * `request.nextUrl`, or a binding that holds one — the binding it derives from. `URL` must be the
 * global constructor: a local or imported `URL` can return anything.
 */
function requestUrlOrigin(node: any, ts: TsModule, rootPath: Roots): Root | undefined {
  let cur = node;
  while (cur && (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur) || ts.isAwaitExpression(cur) || ts.isAsExpression(cur))) cur = cur.expression;
  if (!cur) return undefined;
  if (ts.isIdentifier(cur)) {
    const root = rootPath.get(cur);
    return root?.url === true ? root : undefined;
  }
  const request = (e: any): Root | undefined => {
    let inner = e;
    while (inner && (ts.isParenthesizedExpression(inner) || ts.isNonNullExpression(inner) || ts.isAsExpression(inner))) inner = inner.expression;
    if (!inner || !ts.isIdentifier(inner)) return undefined;
    const root = rootPath.get(inner);
    return root?.request === true ? root : undefined;
  };
  if (ts.isPropertyAccessExpression(cur) && cur.name.text === 'nextUrl') return request(cur.expression);
  if (ts.isNewExpression(cur) && isGlobal(cur.expression, 'URL', ts)) {
    const [href] = cur.arguments ?? [];
    if (!href || !ts.isPropertyAccessExpression(href) || href.name.text !== 'url') return undefined;
    const owner = href.expression;
    if (ts.isPropertyAccessExpression(owner) && owner.name.text === 'req') return request(owner.expression) ?? request(owner);
    return request(owner);
  }
  return undefined;
}

/** When `node` is the `searchParams` of a request URL, or a binding that holds them, the binding they derive from. */
function searchParamsOrigin(node: any, ts: TsModule, rootPath: Roots): Root | undefined {
  let cur = node;
  while (cur && (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur) || ts.isAsExpression(cur))) cur = cur.expression;
  if (!cur) return undefined;
  if (ts.isIdentifier(cur)) {
    const root = rootPath.get(cur);
    return root?.accessor === true && root.space === 'get' ? root : undefined;
  }
  if (!ts.isPropertyAccessExpression(cur) || cur.name.text !== 'searchParams') return undefined;
  return requestUrlOrigin(cur.expression, ts, rootPath);
}

/**
 * Whether `node` is an object whose `.get('<name>')` returns a request field: `request.headers` /
 * `request.cookies` on the request itself, or a binding that holds one (`({ cookies })`, a
 * `formData()` result).
 */
function isAccessor(node: any, ts: TsModule, rootPath: Roots): boolean {
  let cur = node;
  while (cur && (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur))) cur = cur.expression;
  if (ts.isIdentifier(cur)) return rootPath.get(cur)?.accessor === true;
  if (ts.isPropertyAccessExpression(cur) && ACCESSOR_NAMESPACES.has(cur.name.text) && ts.isIdentifier(cur.expression)) {
    return rootPath.get(cur.expression)?.request === true;
  }

  return false;
}

/**
 * Canonical path of a member/element access rooted in a tainted binding, or undefined if not tainted.
 * `trailing` is appended to the segments read off `node` — the field an accessor call names.
 */
function pathFromTainted(node: any, ts: TsModule, rootPath: Roots, trailing: string[] = []): Root | undefined {
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
  const base = rootPath.get(cur);
  if (base === undefined || base.url === true) return undefined;
  segs.push(...trailing);
  let space = base.space;
  // Drop a leading NAMESPACE segment (`req.body.webhookUrl` → `webhookUrl`). Input names — and the
  // runtime coordinates derived from them — are relative to their namespace (`post.webhookUrl`), so
  // leaving `body.` in the read path would fail to match the very inputs it came from. Without this,
  // the highest-value flows (`req.body.webhookUrl` → fetch, `req.body.command` → exec) never reach
  // proven.
  // The dropped segment is exactly what names the address space, so capture it before discarding it —
  // losing it is what made `req.query.id` and `req.body.id` the same read.
  // A bare namespace (`const b = req.body`) is that namespace's container: its members are the fields.
  let namespace: string | undefined;
  if (base.request === true && base.path === '' && segs.length > 0 && REQ_SOURCES.includes(segs[0]!)) {
    namespace = segs[0]!;
    space = spaceOfKey(namespace) ?? space;
    segs.shift();
  }
  // Read bare, the request is still the request — which is what lets `const { headers } = request`
  // destructure a namespace, and `const { headers } = await request.json()` not.
  const request = base.request === true && namespace === undefined && segs.length === 0 ? { request: true } : {};
  // `const headers = request.headers` holds an accessor, so `headers.get('x')` reads the header `x`.
  const accessor = namespace !== undefined && segs.length === 0 && ACCESSOR_NAMESPACES.has(namespace) ? { accessor: true } : {};
  const reassigned = base.reassigned === true ? { reassigned: true } : {};

  return { path: normalizePath([base.path, ...segs].filter(Boolean).join('.')), space, ...request, ...accessor, ...reassigned };
}
