import type { Endpoint, Sink, TsModule } from './types.js';
import { hasExport, isFnLike, methodFromObjectArg, spanOf, unwindChain } from './ast.js';
import type { Bindings } from './bindings.js';
import { functionNameFromPath, ROUTE_REGISTER, routeFromChain, routeObject } from './routes.js';
import { withCoordinates } from './coordinates.js';
import { inputsFromHandler, inputsFromValidator } from './inputs.js';
import { sinksFrom, type ModuleGraph } from './sinks.js';
import { linkedFlows } from './flows.js';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

// --- entry-point recognizers -----------------------------------------------
export function extractFromFile(sf: any, ts: TsModule, localSinks: Map<string, Sink[]>, bindings: Bindings, ctx: { file: string; graph: ModuleGraph }): Omit<Endpoint, 'file'>[] {
  const out: Omit<Endpoint, 'file'>[] = [];
  const isServerActionsFile = fileHasUseServer(sf, ts);

  const visit = (node: any) => {
    if (ts.isVariableStatement(node) && hasExport(node, ts)) {
      for (const decl of node.declarationList.declarations) {
        // (1) TanStack Start: `export const NAME = createServerFn({method}).inputValidator(fn).handler(fn)`
        if (decl.initializer && ts.isCallExpression(decl.initializer)) {
          const chain = unwindChain(decl.initializer, ts);
          if (chain.baseName === 'createServerFn' && ts.isIdentifier(decl.name)) {
            const validatorCall = chain.calls['inputValidator'] ?? chain.calls['validator'];
            const inputs = withCoordinates(inputsFromValidator(validatorCall, ts, bindings), 'server-fn-data');
            const handlerFn = chain.calls['handler']?.arguments?.[0];
            const sinks = sinksFrom(handlerFn, ts, localSinks, bindings, ctx);
            const handlerBody = handlerFn && isFnLike(handlerFn, ts) ? handlerFn.body : undefined;
            const ep: Omit<Endpoint, 'file'> = {
              name: decl.name.text,
              entryKind: 'server-fn',
              method: methodFromObjectArg(chain.baseCall, ts),
              ...spanOf(decl),
              inputs,
              sinks,
              ...linkedFlows(handlerBody, handlerFn?.parameters, inputs, sinks, ts),
            };
            // Honesty marker: a validator EXISTS but couldn't be read — inputs are unknown, not "none".
            if (validatorCall && inputs.length === 0) ep.inputsResolved = false;
            out.push(ep);
            continue;
          }
        }
        // (2b) `export const POST = (req) => …` route handler, or a `'use server'` action arrow.
        if (ts.isIdentifier(decl.name) && decl.initializer && isFnLike(decl.initializer, ts)) {
          if (HTTP_METHODS.has(decl.name.text)) {
            out.push(handlerEntry(decl.name.text, decl.name.text, decl.initializer.parameters, decl.initializer.body, ts, localSinks, bindings, ctx, spanOf(decl)));
          } else if (isServerActionsFile) {
            out.push(handlerEntry(decl.name.text, 'server-action', decl.initializer.parameters, decl.initializer.body, ts, localSinks, bindings, ctx, spanOf(decl)));
          }
        }
      }
    }

    // (2a) Route handlers / server actions declared as functions.
    if (ts.isFunctionDeclaration(node) && node.name && hasExport(node, ts)) {
      if (HTTP_METHODS.has(node.name.text)) {
        out.push(handlerEntry(node.name.text, node.name.text, node.parameters, node.body, ts, localSinks, bindings, ctx, spanOf(node)));
      } else if (isServerActionsFile || hasUseServerDirective(node, ts)) {
        out.push(handlerEntry(node.name.text, 'server-action', node.parameters, node.body, ts, localSinks, bindings, ctx, spanOf(node)));
      }
    }

    // (2c) Deno / WinterCG function entry: `Deno.serve(handler)` or `serve(handler)` — Supabase Edge
    // Functions, Base44 backend functions, Deno workers. These platforms have no router and no route
    // file: one handler per module, invoked by the function's NAME, so the endpoint's identity comes
    // from the file location. Without this recognizer such a project maps to nothing at all.
    if (ts.isCallExpression(node)) {
      const c = node.expression;
      const denoServe = ts.isPropertyAccessExpression(c) && c.name.text === 'serve' &&
        ts.isIdentifier(c.expression) && c.expression.text === 'Deno';
      const bareServe = ts.isIdentifier(c) && c.text === 'serve';
      if (denoServe || bareServe) {
        const handler = node.arguments.find((a: any) => isFnLike(a, ts));
        if (handler) {
          out.push(handlerEntry(functionNameFromPath(ctx.file) ?? 'serve', 'edge-function', handler.parameters, handler.body, ts, localSinks, bindings, ctx, spanOf(node)));
        }
      }
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const mname = node.expression.name.text;
      // (3a) Route registrations: `app.post('/path', …, handler)` (Express/Fastify/Hono/Koa) and the
      // chained `router.route('/x').get(handler)` idiom (path lives on the inner `.route()` call).
      if (ROUTE_REGISTER.has(mname)) {
        const args = node.arguments;
        const first = args[0];
        const route = first && ts.isStringLiteralLike(first) ? first.text : routeFromChain(node.expression.expression, ts);
        const handler = args[args.length - 1];
        if (route !== undefined && handler && isFnLike(handler, ts)) {
          out.push(handlerEntry(route, 'route-registration', handler.parameters, handler.body, ts, localSinks, bindings, ctx, {
            // `use`/`all` register handlers but are not HTTP methods — leave method undefined.
            method: HTTP_METHODS.has(mname.toUpperCase()) ? mname.toUpperCase() : undefined,
            route,
            ...spanOf(node),
          }));
        }
      }
      // (3b) Fastify object form: `app.route({ method, url, handler })` — one endpoint per method.
      if (mname === 'route') {
        const arg = node.arguments[0];
        if (arg && ts.isObjectLiteralExpression(arg)) {
          const reg = routeObject(arg, ts);
          if (reg.url && reg.handler) {
            for (const m of reg.methods.length ? reg.methods : [undefined]) {
              out.push(handlerEntry(reg.url, 'route-registration', reg.handler.parameters, reg.handler.body, ts, localSinks, bindings, ctx, { method: m, route: reg.url, ...spanOf(node) }));
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// Next server actions: a `'use server'` directive at the top of a module (whole file) or a function body.
function fileHasUseServer(sf: any, ts: TsModule): boolean {
  const first = sf.statements?.[0];
  return Boolean(first && ts.isExpressionStatement(first) && ts.isStringLiteralLike(first.expression) && first.expression.text === 'use server');
}
function hasUseServerDirective(fn: any, ts: TsModule): boolean {
  const first = fn.body?.statements?.[0];
  return Boolean(first && ts.isExpressionStatement(first) && ts.isStringLiteralLike(first.expression) && first.expression.text === 'use server');
}

function handlerEntry(
  name: string,
  kindLabel: string,
  params: any,
  body: any,
  ts: TsModule,
  localSinks: Map<string, Sink[]>,
  bindings: Bindings,
  ctx: { file: string; graph: ModuleGraph },
  extra: { method?: string; route?: string; line?: number; start?: number; end?: number } = {},
): Omit<Endpoint, 'file'> {
  const entryKind = kindLabel === 'route-registration' || kindLabel === 'server-action' || kindLabel === 'edge-function'
    ? kindLabel
    : 'route-handler';
  // A server action receives its payload as the first argument; a route handler receives a Request.
  const payloadStyle = kindLabel === 'server-action';
  const inputs = inputsFromHandler(params, body, ts, bindings, {
    payloadParam: payloadStyle,
    validatorSource: payloadStyle ? 'server-fn-data' : 'json-body',
  });
  const sinks = sinksFrom({ body, parameters: params, isSyntheticBody: true }, ts, localSinks, bindings, ctx);
  return {
    name,
    entryKind,
    method: extra.method ?? (HTTP_METHODS.has(name) ? name : undefined),
    route: extra.route,
    line: extra.line,
    start: extra.start,
    end: extra.end,
    inputs,
    sinks,
    ...linkedFlows(body, params, inputs, sinks, ts),
  };
}
