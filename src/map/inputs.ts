import type { FieldShape, InputField, InputSource, TsModule } from './types.js';
import { bindingKey, rootIdentifier, rootIdentifierNode } from './ast.js';
import { declarationOf, isGlobal } from './scope.js';
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
): { inputs: InputField[]; schemaUnresolved: boolean } {
  // A validated schema inside a handler describes the request body — except for a payload-style entry
  // (a server action), where the schema describes the action's own argument.
  const schemaSource = opts.validatorSource ?? 'json-body';
  const inline = zodObjectFields(body, ts, bindings);
  // A schema declared outside the handler and applied to the request (`Schema.parse(await req.json())`).
  const referenced = inline.length > 0 ? { fields: [], unresolved: false } : referencedSchemaFields(params, body, ts, bindings);
  const schemaFields = inline.length > 0 ? inline : referenced.fields;
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
  return { inputs: [...byId.values()], schemaUnresolved: referenced.unresolved };
}

const SCHEMA_METHODS = new Set(['parse', 'safeParse', 'parseAsync', 'safeParseAsync']);

/**
 * Fields of a schema the handler applies to its request but declares elsewhere: `Schema.parse(x)` where
 * `x` derives from a handler parameter. A schema declared in this file is read; one imported from
 * another module cannot be, and is reported as `unresolved` so its fields count as unknown, not absent.
 */
function referencedSchemaFields(params: any, body: any, ts: TsModule, bindings: Bindings): { fields: FieldShape[]; unresolved: boolean } {
  if (!body) return { fields: [], unresolved: false };
  const paramDecls = new Set<any>();
  for (const p of params ?? []) {
    if (!p?.name) continue;
    if (ts.isIdentifier(p.name)) paramDecls.add(p.name);
    else if (ts.isObjectBindingPattern(p.name)) for (const el of p.name.elements) if (ts.isIdentifier(el.name)) paramDecls.add(el.name);
  }
  // Rooted at a handler parameter, directly or through one local (`const raw = await req.json()`).
  const fromParams = (e: any): boolean => {
    const root = rootIdentifierNode(e, ts);
    const declaration = root ? declarationOf(root, ts) : undefined;
    if (declaration === undefined) return false;
    if (paramDecls.has(declaration)) return true;
    const owner = declaration.parent;
    if (owner && ts.isVariableDeclaration(owner) && owner.name === declaration && owner.initializer) {
      const inner = rootIdentifierNode(owner.initializer, ts);
      const innerDeclaration = inner ? declarationOf(inner, ts) : undefined;
      return innerDeclaration !== undefined && paramDecls.has(innerDeclaration);
    }
    return false;
  };
  let fields: FieldShape[] = [];
  let unresolved = false;
  const visit = (n: any) => {
    if (fields.length > 0) return;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && SCHEMA_METHODS.has(n.expression.name.text)
        && ts.isIdentifier(n.expression.expression)
        && n.arguments.some((a: any) => fromParams(a))) {
      const declaration = declarationOf(n.expression.expression, ts);
      const owner = declaration?.parent;
      if (owner && ts.isVariableDeclaration(owner) && owner.name === declaration && owner.initializer) {
        const literal = findValidatorObject(owner.initializer, ts, bindings);
        if (literal) fields = fieldsOfObject(literal, ts, bindings, '');
        else unresolved = true;
      } else if (declaration !== undefined && isImported(declaration, ts)) {
        unresolved = true;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return { fields, unresolved: fields.length === 0 && unresolved };
}

function isImported(declaration: any, ts: TsModule): boolean {
  for (let cur = declaration?.parent; cur; cur = cur.parent) {
    if (ts.isImportDeclaration(cur)) return true;
    if (ts.isSourceFile(cur) || ts.isStatement(cur)) return false;
  }
  return false;
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
  // The request bindings, by declaration, so an inner function's own parameter of the same name is not the
  // request: the handler's first parameter, a destructured `({ request })`, and aliases (`const r = req`).
  const reqDecl = p0 && ts.isIdentifier(p0.name) ? p0.name : undefined;
  const requestDecls = new Set<any>(reqDecl ? [reqDecl] : []);
  const isRequest = (e: any): boolean => ts.isIdentifier(e) && requestDecls.has(declarationOf(e, ts));
  // A request as an object that carries the request API: the request itself, or a context's `req` (Hono).
  const isRequestObject = (e: any): boolean =>
    isRequest(e) || (ts.isPropertyAccessExpression(e) && e.name.text === 'req' && isRequest(e.expression));
  // `new URL(request.url)`, `request.nextUrl`, a destructured `({ url })` and their aliases — the query
  // string is read through their `searchParams`.
  const urlDecls = new Set<any>();
  const searchParamDecls = new Set<any>();
  // Identifiers that ARE a request-input object (destructured `({ body })` param, `await req.json()`),
  // mapped to the NAMESPACE each one came from. It has to be a map, not a set of names: with
  // `({ query: q })` the local is `q`, and matching the local against the literal 'query'/'params'
  // discards the namespace — which silently mis-addresses the input (`post.doc` for a query-string
  // field, and worse, a coordinate for a route param, which the resolver cannot address at all).
  // Keyed by declaration, like the request itself: a same-named binding in another scope is not one.
  const sourceNames = new Map<any, InputSource>();
  const payloadNames = new Set<any>();
  const sourceOf = (e: any): InputSource | undefined => (ts.isIdentifier(e) ? sourceNames.get(declarationOf(e, ts)) : undefined);
  if (opts.payloadParam && p0 && ts.isIdentifier(p0.name)) payloadNames.add(p0.name);
  if (p0 && !reqDecl && ts.isObjectBindingPattern(p0.name)) {
    for (const el of p0.name.elements) {
      const key = bindingKey(el, ts);
      if (!key || !ts.isIdentifier(el.name)) continue;
      if (REQ_SOURCES.includes(key)) sourceNames.set(el.name, namespaceSource(key));
      // A request event (SvelteKit, Astro): `({ request, url })`.
      else if (key === 'request') requestDecls.add(el.name);
      else if (key === 'url') urlDecls.add(el.name);
    }
  }
  // A route context after the request: `(request, { params })` (Next.js).
  for (const p of (params ?? []).slice(1)) {
    if (!p?.name || !ts.isObjectBindingPattern(p.name)) continue;
    for (const el of p.name.elements) {
      if (bindingKey(el, ts) === 'params' && ts.isIdentifier(el.name)) sourceNames.set(el.name, 'route-param');
    }
  }
  const unwrap = (e: any): any => {
    let cur = e;
    while (cur && (ts.isAwaitExpression(cur) || ts.isAsExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur))) cur = cur.expression;
    return cur;
  };
  const isPayloadExpr = (e: any): boolean => ts.isIdentifier(e) && payloadNames.has(declarationOf(e, ts));
  const isReqSourceExpr = (e: any): boolean =>
    isPayloadExpr(e) ||
    (ts.isPropertyAccessExpression(e) && isRequest(e.expression) && REQ_SOURCES.includes(e.name.text)) ||
    sourceOf(e) !== undefined;
  const isBodyReadCall = (e: any): boolean => {
    const inner = unwrap(e);
    return Boolean(inner && ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) &&
      ['json', 'formData'].includes(inner.expression.name.text) &&
      isRequestObject(inner.expression.expression));
  };
  const isRequestUrl = (e: any): boolean => {
    const cur = unwrap(e);
    if (!cur) return false;
    if (ts.isIdentifier(cur)) return urlDecls.has(declarationOf(cur, ts));
    if (ts.isPropertyAccessExpression(cur) && cur.name.text === 'nextUrl') return isRequest(cur.expression);
    if (ts.isNewExpression(cur) && isGlobal(cur.expression, 'URL', ts)) {
      const [href] = cur.arguments ?? [];
      return Boolean(href && ts.isPropertyAccessExpression(href) && href.name.text === 'url' && isRequestObject(href.expression));
    }
    return false;
  };
  const isSearchParams = (e: any): boolean => {
    const cur = unwrap(e);
    if (!cur) return false;
    if (ts.isIdentifier(cur)) return searchParamDecls.has(declarationOf(cur, ts));
    return ts.isPropertyAccessExpression(cur) && cur.name.text === 'searchParams' && isRequestUrl(cur.expression);
  };
  const literalArgument = (call: any): string | undefined => {
    const [arg] = call.arguments ?? [];
    return call.arguments?.length === 1 && arg && ts.isStringLiteral(arg) ? arg.text : undefined;
  };
  // `request.headers.get` in `request.headers.get('x')` is a METHOD of the namespace, not a field of it.
  // Recording it would invent an input named `get` — a coordinate no request carries.
  const isCallee = (n: any): boolean =>
    Boolean(n.parent && (ts.isCallExpression(n.parent) || ts.isNewExpression(n.parent)) && n.parent.expression === n);
  const ACCESSOR_SOURCES = new Set<InputSource>(['header', 'cookie', 'form-body']);
  const HONO_ACCESSORS: Record<string, InputSource> = { query: 'query', param: 'route-param', header: 'header' };
  const visit = (n: any) => {
    // <source>.<field>
    if (ts.isPropertyAccessExpression(n) && isReqSourceExpr(n.expression) && !isCallee(n)) {
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
    // Only on an object whose `.get()` is a field accessor — a `Headers`, a cookie store, a `FormData`.
    // On `req.body` or `req.query` it is an application method, and its argument names no input.
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && n.expression.name.text === 'get' && isReqSourceExpr(n.expression.expression)
        && n.arguments.length === 1 && n.arguments[0] && ts.isStringLiteral(n.arguments[0])
        && ACCESSOR_SOURCES.has(sourceOfExpr(n.expression.expression))) {
      record((n.arguments[0] as any).text, sourceOfExpr(n.expression.expression));
    }
    // `url.searchParams.get('q')` — the query string, read through a URL of the request.
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'get'
        && isSearchParams(n.expression.expression)) {
      const name = literalArgument(n);
      if (name !== undefined) record(name, 'query');
    }
    // Hono: `c.req.query('q')`, `c.req.param('id')`, `c.req.header('x-token')`.
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && ts.isPropertyAccessExpression(n.expression.expression) && n.expression.expression.name.text === 'req'
        && isRequest(n.expression.expression.expression)) {
      const source = HONO_ACCESSORS[n.expression.name.text];
      const name = literalArgument(n);
      if (source && name !== undefined) record(name, source);
    }
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const init = unwrap(n.initializer);
      if (ts.isIdentifier(n.name)) {
        // const r = req → another name for the request.
        if (isRequest(init)) requestDecls.add(n.name);
        // const b = req.body → a namespace of the request, read under another name.
        else if (ts.isPropertyAccessExpression(init) && isRequest(init.expression) && REQ_SOURCES.includes(init.name.text)) {
          sourceNames.set(n.name, namespaceSource(init.name.text));
        } else if (isRequestUrl(init)) urlDecls.add(n.name);
        else if (isSearchParams(init)) searchParamDecls.add(n.name);
      }
      // const { searchParams } = new URL(request.url)
      if (ts.isObjectBindingPattern(n.name) && isRequestUrl(init)) {
        for (const el of n.name.elements) {
          if (bindingKey(el, ts) === 'searchParams' && ts.isIdentifier(el.name)) searchParamDecls.add(el.name);
        }
      }
      // const b = await request.json() → b is a request-input object from here on.
      if (ts.isIdentifier(n.name) && isBodyReadCall(n.initializer)) sourceNames.set(n.name, bodyReadSource(n.initializer));
      // const { query: q } = req → the SAME namespace capture as a destructured handler param, just one
      // statement later. Without this the fields read off `q` are invisible: no coordinate is emitted
      // (so nothing is mis-addressed) but the surface goes unreported, which reads as "nothing here".
      if (ts.isObjectBindingPattern(n.name) && isRequest(init)) {
        for (const el of n.name.elements) {
          const key = bindingKey(el, ts);
          if (key && REQ_SOURCES.includes(key) && ts.isIdentifier(el.name)) sourceNames.set(el.name, namespaceSource(key));
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
      const recorded = sourceOf(e);
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
