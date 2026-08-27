import type { FieldShape, InputField, InputSource, TsModule } from './types.js';
import { bindingKey, rootIdentifier } from './ast.js';
import { npmPackageOf, type Bindings } from './bindings.js';
import { addressSpaceOf, inputIdOf, runtimeCoordinate } from './coordinates.js';

const ZOD_BASE = new Set(['string', 'number', 'boolean', 'array', 'object', 'enum', 'bigint', 'date', 'record']);
// String-format refinements a validator can declare — kept on the field so a rule can pin the shape.
const STRING_FORMATS = new Set(['email', 'uuid', 'url', 'ip', 'ipv4', 'ipv6', 'cuid', 'cuid2', 'ulid', 'emoji', 'datetime', 'base64', 'jwt', 'nanoid']);
// Packages whose `.object({…})` calls describe an input schema.
const VALIDATOR_PACKAGES = new Set(['zod', 'valibot', 'yup', 'joi', '@hapi/joi', 'superstruct']);

// --- inputs -----------------------------------------------------------------
export function inputsFromValidator(validatorCall: any, ts: TsModule, bindings: Bindings): FieldShape[] {
  if (!validatorCall) return [];
  return zodObjectFields(validatorCall, ts, bindings);
}

// From a raw handler: validator schema fields it parses, plus the request fields it actually reads
// (member accesses, destructuring, `await request.json()` bodies).
export function inputsFromHandler(
  params: any,
  body: any,
  ts: TsModule,
  bindings: Bindings,
  opts: { payloadParam?: boolean; validatorSource?: InputSource } = {},
): InputField[] {
  // A validated schema inside a handler describes the request body — except for a payload-style entry
  // (a server action), where the schema describes the action's own argument.
  const schemaSource = opts.validatorSource ?? 'json-body';
  const schemaFields = zodObjectFields(body, ts, bindings);
  const reads = requestMemberAccesses(params, body, ts, opts);

  // Keyed by IDENTITY — `<space>:<path>` — not by field name. A handler that reads `query.id` and
  // `params.id`, or validates a body field named `id` while the sink consumes `query.id`, has TWO inputs
  // that merely share a name. Name-keying made one of them disappear, and since the survivor decided the
  // coordinate, a rule could be pinned to a parameter the payload never travels in. Distinct identities
  // remove that class outright: each input carries its own address, and a flow names which one it means.
  // Same space + same path IS the same input, so a schema field and an `req.body` read of it merge
  // (the schema entry wins, since it also carries the declared type/constraints).
  const byId = new Map<string, InputField>();
  const put = (name: string, source: InputSource, extra: Omit<FieldShape, 'name' | 'source'> = {}) => {
    const id = inputIdOf(source, name);
    if (byId.has(id)) return;
    byId.set(id, { ...extra, id, name, source, ...runtimeCoordinate(source, name) });
  };
  for (const f of schemaFields) {
    const { name, source, ...shape } = f;
    put(name, source ?? schemaSource, shape);
  }
  for (const { name, sources } of reads) for (const source of sources) put(name, source);
  return [...byId.values()];
}

// Find the first validator `.object({...})` in a subtree — gated on the receiver tracing to a known
// validator package (so an unrelated `.object(` never becomes a schema). An untraceable receiver
// literally named `z` is accepted as a heuristic (covers `z` re-exported from a local module).
function findValidatorObject(node: any, ts: TsModule, bindings: Bindings): any {
  let found: any = null;
  const find = (n: any) => {
    if (found || !n) return;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'object') {
      const root = rootIdentifier(n.expression.expression, ts);
      const pkg = root ? npmPackageOf(bindings.resolve(root)) : undefined;
      const isValidator = (pkg && VALIDATOR_PACKAGES.has(pkg)) || (!pkg && root === 'z' && !bindings.locals.has(root));
      if (isValidator) {
        const arg = n.arguments[0];
        if (arg && ts.isObjectLiteralExpression(arg)) { found = arg; return; }
      }
    }
    ts.forEachChild(n, find);
  };
  find(node);
  return found;
}

// Read a validator object's fields (name + type/constraints). Nested objects/arrays are flattened to
// dotted paths — `address.city`, `tags[].label` — the same coordinates `array_key_value` rules use.
function zodObjectFields(node: any, ts: TsModule, bindings: Bindings): FieldShape[] {
  if (!node) return [];
  const lit = findValidatorObject(node.body ?? node, ts, bindings);
  return lit ? fieldsOfObject(lit, ts, bindings, '') : [];
}

function fieldsOfObject(objectLiteral: any, ts: TsModule, bindings: Bindings, prefix: string): FieldShape[] {
  const fields: FieldShape[] = [];
  for (const p of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(p) || !p.name) continue;
    const fname = (p.name as any).text;
    if (!fname) continue;
    const shape = zodShape(p.initializer, ts);
    fields.push({ name: prefix + fname, ...shape });
    const nested = findValidatorObject(p.initializer, ts, bindings);
    if (nested) fields.push(...fieldsOfObject(nested, ts, bindings, prefix + fname + (shape.type === 'array' ? '[].' : '.')));
  }
  return fields;
}

function numericValue(arg: any, ts: TsModule): number | undefined {
  if (!arg) return undefined;
  if (ts.isNumericLiteral(arg)) return Number(arg.text);
  if (ts.isPrefixUnaryExpression(arg) && arg.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(arg.operand)) return -Number(arg.operand.text);
  return undefined;
}

function zodShape(node: any, ts: TsModule): Omit<FieldShape, 'name'> {
  const shape: Omit<FieldShape, 'name'> = {};
  let cur = node;
  while (cur && ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    const method = cur.expression.name.text;
    const arg0 = cur.arguments[0];
    if (ZOD_BASE.has(method) && !shape.type) shape.type = method;
    if (method === 'min') { const v = numericValue(arg0, ts); if (v !== undefined) shape.min = v; }
    if (method === 'max') { const v = numericValue(arg0, ts); if (v !== undefined) shape.max = v; }
    if (STRING_FORMATS.has(method) && !shape.format) shape.format = method;
    if (method === 'regex' && arg0 && ts.isRegularExpressionLiteral(arg0) && !shape.pattern) shape.pattern = arg0.text;
    if (method === 'optional' || method === 'nullish') shape.optional = true;
    cur = cur.expression.expression;
  }
  return shape;
}

// The request namespaces an input can be read from. `headers`, `cookies` and `files` were declared in
// `InputSource` and in `ADDRESS_SPACES`, and the coordinate mapping for all three was already written —
// only extraction never produced them, so a header-, cookie- or upload-borne vulnerability could never
// get a coordinate and therefore never a pinned rule. A declared capability nothing can reach is worse
// than an absent one: it reads as covered.
export const REQ_SOURCES = ['body', 'query', 'params', 'headers', 'cookies', 'files'];

// The request fields a handler reads, across the common idioms:
//   req.body.x / req.query.x / req.params.x        (member access)
//   const { x } = req.body                          (destructuring)
//   ({ body }) => body.x / const { x } = body       (destructured handler param)
//   const b = await request.json(); b.x / const { x } = await request.json()   (fetch-style Request)
function requestMemberAccesses(
  params: any,
  body: any,
  ts: TsModule,
  opts: { payloadParam?: boolean } = {},
): Array<{ name: string; sources: InputSource[] }> {
  if (!body) return [];
  // Keyed by FIELD NAME, which two namespaces can share (`params.id` and `query.id` in one handler).
  // Last-write-wins silently picked one, and since the pick decided the coordinate, a handler reading
  // both compiled a rule pinned to `get.id` for data that arrives in the path segment — a wrong-input
  // pin, the one failure this whole layer exists to prevent. Collisions are now recorded, and the
  // first-seen source wins so the record is at least deterministic.
  const out = new Map<string, InputSource[]>();
  const record = (name: string, source: InputSource) => {
    const list = out.get(name) ?? [];
    if (!list.includes(source)) list.push(source);
    out.set(name, list);
  };
  const p0 = params?.[0];
  const reqName = p0 && ts.isIdentifier(p0.name) ? p0.name.text : undefined;
  // Identifiers that ARE a request-input object (destructured `({ body })` param, `await req.json()`),
  // mapped to the NAMESPACE each one came from. It has to be a map, not a set of names: with
  // `({ query: q })` the local is `q`, and matching the local against the literal 'query'/'params'
  // discards the namespace — which silently mis-addresses the input (`post.doc` for a query-string
  // field, and worse, a coordinate for a route param, which the resolver cannot address at all).
  const sourceNames = new Map<string, InputSource>();
  const payloadNames = new Set<string>();
  if (opts.payloadParam && p0 && ts.isIdentifier(p0.name)) payloadNames.add(p0.name.text);
  if (p0 && !reqName && ts.isObjectBindingPattern(p0.name)) {
    for (const el of p0.name.elements) {
      const key = bindingKey(el, ts);
      if (key && REQ_SOURCES.includes(key) && ts.isIdentifier(el.name)) {
        sourceNames.set(el.name.text, namespaceSource(key));
      }
    }
  }
  const unwrap = (e: any): any => {
    let cur = e;
    while (cur && (ts.isAwaitExpression(cur) || ts.isAsExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur))) cur = cur.expression;
    return cur;
  };
  const isPayloadExpr = (e: any): boolean => ts.isIdentifier(e) && payloadNames.has(e.text);
  const isReqSourceExpr = (e: any): boolean =>
    isPayloadExpr(e) ||
    (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === reqName && REQ_SOURCES.includes(e.name.text)) ||
    (ts.isIdentifier(e) && sourceNames.has(e.text));
  const isBodyReadCall = (e: any): boolean => {
    const inner = unwrap(e);
    return Boolean(inner && ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) &&
      ['json', 'formData'].includes(inner.expression.name.text) &&
      ts.isIdentifier(inner.expression.expression) && inner.expression.expression.text === reqName);
  };
  const visit = (n: any) => {
    // <source>.<field>
    if (ts.isPropertyAccessExpression(n) && isReqSourceExpr(n.expression)) {
      record(n.name.text, sourceOfExpr(n.expression));
    }
    // <source>['<field>'] — the form a header read almost always takes, because a header name carries
    // dashes and cannot be a property name. Only a STRING LITERAL key: `headers[name]` is a dynamic read
    // whose field nobody knows, and inventing one would pin a rule to a parameter that may not exist.
    if (ts.isElementAccessExpression(n) && isReqSourceExpr(n.expression)
        && n.argumentExpression && ts.isStringLiteral(n.argumentExpression)) {
      record(n.argumentExpression.text, sourceOfExpr(n.expression));
    }
    // `request.headers.get('x-token')` / `request.cookies.get('sid')` — the fetch-style twin of the two
    // above. The namespace is one hop further out because `.get()` is a method on it.
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && n.expression.name.text === 'get' && isReqSourceExpr(n.expression.expression)
        && n.arguments.length === 1 && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
      record((n.arguments[0] as any).text, sourceOfExpr(n.expression.expression));
    }
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const init = unwrap(n.initializer);
      // const b = await request.json() → b is a request-input object from here on.
      if (ts.isIdentifier(n.name) && isBodyReadCall(n.initializer)) sourceNames.set(n.name.text, bodyReadSource(n.initializer));
      // const { query: q } = req → the SAME namespace capture as a destructured handler param, just one
      // statement later. Without this the fields read off `q` are invisible: no coordinate is emitted
      // (so nothing is mis-addressed) but the surface goes unreported, which reads as "nothing here".
      if (ts.isObjectBindingPattern(n.name) && ts.isIdentifier(init) && reqName && init.text === reqName) {
        for (const el of n.name.elements) {
          const key = bindingKey(el, ts);
          if (key && REQ_SOURCES.includes(key) && ts.isIdentifier(el.name)) sourceNames.set(el.name.text, namespaceSource(key));
        }
      }
      // const { a, b } = <source> | await request.json()
      if (ts.isObjectBindingPattern(n.name) && (isReqSourceExpr(init) || isBodyReadCall(n.initializer))) {
        const src = isBodyReadCall(n.initializer) ? bodyReadSource(n.initializer) : sourceOfExpr(init);
        for (const el of n.name.elements) {
          const key = bindingKey(el, ts);
          if (key) record(key, src);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return [...out].map(([name, sources]) => ({ name, sources }));

  // `req.body.x` / `req.query.x` / `req.params.x` — the namespace decides the runtime coordinate, and
  // route params notably have NONE, so this distinction is load-bearing rather than cosmetic.
  function sourceOfExpr(e: any): InputSource {
    if (isPayloadExpr(e)) return 'server-fn-data';
    if (ts.isPropertyAccessExpression(e)) {
      const named = namespaceSource(e.name.text);
      // `namespaceSource` falls back to 'body', which would make any member access a body read. Only
      // accept it when the name IS a namespace we recognise.
      if (REQ_SOURCES.includes(e.name.text)) return named;
    }
    // The recorded namespace, so an ALIAS resolves correctly (`({ query: q }) => q.id` → query).
    if (ts.isIdentifier(e)) {
      const recorded = sourceNames.get(e.text);
      if (recorded) return recorded;
    }
    return 'body';
  }

  /** Map a request namespace key to the input source it implies. */
  function namespaceSource(key: string): InputSource {
    if (key === 'query') return 'query';
    if (key === 'params') return 'route-param';
    if (key === 'headers') return 'header';
    if (key === 'cookies') return 'cookie';
    if (key === 'files') return 'file';
    return 'body';
  }
  function bodyReadSource(init: any): InputSource {
    const t = init?.getText?.() ?? '';
    return /formData\s*\(/.test(t) ? 'form-body' : 'json-body';
  }
}
