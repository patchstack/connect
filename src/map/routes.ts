import type { TsModule } from './types.js';
import { isFnLike } from './ast.js';

// One list drives BOTH the AST route-registration recognizer and the textual pre-filter — they must
// never diverge: a file the pre-filter skips is invisible to every recognizer.
const ROUTE_REGISTER_NAMES = ['get', 'post', 'put', 'patch', 'delete', 'options', 'all', 'head', 'use'];
export const ROUTE_REGISTER = new Set(ROUTE_REGISTER_NAMES);
export const ROUTE_CALL_RE = new RegExp(`\\.(${[...ROUTE_REGISTER_NAMES, 'route'].join('|')})\\s*\\(`);

// Derive the URL path of a FILE-BASED route handler from its location, across the conventions AI
// builders actually emit. Dynamic segments become `:name` and set `dynamic` so a consumer knows the
// route is a PATTERN (the engine's `when.path` takes a glob or /regex/, not an Express param), rather
// than mistaking `/api/:id` for a literal path.
//   Next App Router     app/api/items/route.ts          -> /api/items
//                       app/api/items/[id]/route.ts     -> /api/items/:id      (dynamic)
//                       app/(marketing)/api/x/route.ts  -> /api/x              (route group stripped)
//   Next Pages Router   pages/api/items/index.ts        -> /api/items
//                       pages/api/[id].ts               -> /api/:id            (dynamic)
//   SvelteKit           src/routes/api/items/+server.ts -> /api/items
//   Nuxt                server/api/items.post.ts        -> /api/items
// The deployed name of a platform function, from its conventional location:
//   supabase/functions/<name>/index.ts  (Supabase Edge Functions)
//   functions/<name>/index.ts | functions/<name>.ts  (Base44 / generic Deno function dirs)
export function functionNameFromPath(relFile: string): string | undefined {
  const parts = relFile.split(/[\\/]/).filter(Boolean);
  const i = parts.lastIndexOf('functions');
  if (i === -1 || i === parts.length - 1) return undefined;
  const next = parts[i + 1];
  if (!next) return undefined;
  const base = next.replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, '');
  return base === 'index' ? undefined : base;
}

export function routeFromFilePath(relFile: string): { route?: string; dynamic?: boolean } {
  const parts = relFile.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return {};
  const base = (parts[parts.length - 1] ?? '').replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, '');
  const dirs = parts.slice(0, -1);
  const at = (name: string) => dirs.lastIndexOf(name);

  let segs: string[] | null = null;
  if (base === 'route' && at('app') !== -1) {
    segs = dirs.slice(at('app') + 1); // Next App Router
  } else if (base === '+server' && at('routes') !== -1) {
    segs = dirs.slice(at('routes') + 1); // SvelteKit
  } else if (at('pages') !== -1) {
    segs = [...dirs.slice(at('pages') + 1), ...(base === 'index' ? [] : [base])]; // Next Pages Router
  } else if (at('server') !== -1) {
    // Nuxt server routes; a `.post`/`.get` suffix encodes the method, not a path segment.
    segs = [...dirs.slice(at('server') + 1), ...(base === 'index' ? [] : [base.replace(/\.(get|post|put|patch|delete|head|options)$/i, '')])];
  }
  if (!segs) return {};

  // Next route groups `(marketing)` and parallel/private segments don't appear in the URL.
  segs = segs.filter((s) => !(s.startsWith('(') && s.endsWith(')')) && !s.startsWith('@') && !s.startsWith('_'));

  let dynamic = false;
  const mapped = segs.map((s) => {
    const m = /^\[+(\.{0,3})(.+?)\]+$/.exec(s); // [id], [...slug], [[...slug]]
    if (m) {
      dynamic = true;
      return ':' + m[2];
    }
    return s;
  });
  const route = '/' + mapped.join('/');
  return { route: route.length > 1 ? route.replace(/\/+$/, '') : '/', dynamic };
}

// Unwind `router.route('/x').get(h).post(h2)` down to the `.route('/x')` call to recover the path.
export function routeFromChain(expr: any, ts: TsModule): string | undefined {
  let cur = expr;
  while (cur && ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    const nm = cur.expression.name.text;
    if (nm === 'route') {
      const a = cur.arguments[0];
      return a && ts.isStringLiteralLike(a) ? a.text : undefined;
    }
    if (!ROUTE_REGISTER.has(nm)) return undefined;
    cur = cur.expression.expression;
  }
  return undefined;
}

// Read `{ method, url|path, handler }` from a Fastify-style route object (handler as arrow/function
// property or as an object-method shorthand).
export function routeObject(obj: any, ts: TsModule): { url?: string; methods: string[]; handler?: any } {
  let url: string | undefined;
  let handler: any;
  const methods: string[] = [];
  for (const p of obj.properties) {
    const key = (p.name as any)?.text;
    if (ts.isPropertyAssignment(p)) {
      if ((key === 'url' || key === 'path') && ts.isStringLiteralLike(p.initializer)) url = p.initializer.text;
      if (key === 'method') {
        if (ts.isStringLiteralLike(p.initializer)) methods.push(p.initializer.text.toUpperCase());
        else if (ts.isArrayLiteralExpression(p.initializer)) {
          for (const el of p.initializer.elements) if (ts.isStringLiteralLike(el)) methods.push(el.text.toUpperCase());
        }
      }
      if (key === 'handler' && isFnLike(p.initializer, ts)) handler = p.initializer;
    } else if (ts.isMethodDeclaration(p) && key === 'handler') handler = p;
  }
  return { url, methods, handler };
}
