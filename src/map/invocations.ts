import type { ApiInvocation, InvocationResolution, TsModule } from './types.js';
import { rootIdentifier, spanOf } from './ast.js';
import { npmPackageOf, type Bindings } from './bindings.js';
import type { ModuleGraph } from './sinks.js';

// Which dependency APIs the app actually CALLS — a different question from the sink analysis, and a much
// cheaper one.
//
// A sink answers "can request input reach a dangerous operation". That is only askable for the handful of
// API families the extractor models, which measured out at ~3.6% of real advisories. This answers "is this
// package's API invoked at all", which is askable for every package and is the whole answer for an advisory
// whose precondition is *calling* the vulnerable function rather than feeding it untrusted input.
//
// The discipline is the sink discipline, deliberately: a receiver we cannot trace to a dependency is not an
// invocation of that dependency, no matter how suggestive the method name. `inferred` attribution — the
// package guessed from another import in the same file — does not qualify at all here, because unlike a
// sink there is no second signal (an argument role, a dangerous operation) to corroborate it.
//
// PARTIAL BY CONSTRUCTION, and that is not a parsing budget problem. Parsing every file would raise recall,
// but dynamic property access (`client[method]()`), dynamic `import()`/`require()` with a computed
// specifier, reflection, aliases we do not follow, generated code and syntax we cannot parse all remain
// invisible. So absence here NEVER licenses "the vulnerable API is not called"; the document says so in
// `coverage.apiInventoryLimitations` rather than carrying a boolean a consumer could misread.

/** Sites kept per distinct invocation, so a hot API cannot dominate the document. */
const MAX_SITES = 3;

export interface InvocationContext {
  /** Absolute path of the file being analysed, for resolving relative re-exports. */
  file: string;
  /** The same file, repo-relative — part of the record's identity, so it must not vary by machine. */
  owner: string;
  graph: ModuleGraph;
}

/**
 * Collect resolved dependency calls from one parsed file.
 *
 * Returns the invocations plus a count of calls whose callee could NOT be traced to a package. That count
 * is the honest denominator: it is what turns "we found 40 invocations" into "we resolved 40 of 300 calls",
 * which is the number that decides whether more parsing is worth paying for.
 */
export function collectInvocations(
  sf: any,
  ts: TsModule,
  bindings: Bindings,
  ctx: InvocationContext,
): { invocations: ApiInvocation[]; unresolved: number } {
  const found: ApiInvocation[] = [];
  let unresolved = 0;

  const lineOf = (node: any): number | undefined => {
    try {
      return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    } catch {
      return undefined;
    }
  };

  /** The package a local name traces to, and how — including one hop for a re-exported dependency value. */
  const traceRoot = (root: string): { pkg: string; specifier: string; resolution: InvocationResolution } | null => {
    const specifier = bindings.resolve(root);
    if (specifier === undefined) return null;

    const direct = npmPackageOf(specifier);
    if (direct !== undefined) {
      // `direct` vs `factory` is already recorded by the bindings; default to direct when unknown so a
      // missing origin cannot silently upgrade a weaker claim.
      return { pkg: direct, specifier, resolution: bindings.originOf(root) ?? 'direct' };
    }

    // A relative specifier: the value may still be a dependency re-exported from a local module
    // (`export const db = createClient(...)` in lib/db.ts — the layout generated apps actually use).
    const exportName = bindings.exportNameOf(root) ?? root;
    const viaModule = ctx.graph.importedPackage(ctx.file, specifier, exportName);
    if (viaModule !== undefined) {
      return { pkg: viaModule, specifier, resolution: 'reexport' };
    }

    return null;
  };

  const push = (
    traced: { pkg: string; specifier: string; resolution: InvocationResolution },
    api: string,
    receiver: string | undefined,
    kind: ApiInvocation['kind'],
    node: any,
  ) => {
    const span = spanOf(node);
    found.push({
      package: traced.pkg,
      specifiers: [traced.specifier],
      api,
      ...(receiver !== undefined ? { receiver } : {}),
      symbol: receiver !== undefined ? `${receiver}.${api}` : api,
      kind,
      // Only ever `import`: a global has no package to correlate against, and an inferred package is not
      // evidence about the value being called.
      attribution: 'import',
      resolution: traced.resolution,
      callCount: 1,
      sites: [{ file: ctx.owner, line: lineOf(node), start: span.start, end: span.end }],
    });
  };

  const visit = (node: any) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;

      if (ts.isIdentifier(callee)) {
        // `merge(a, b)` / `new Pool()` — the callee itself is the imported binding.
        const traced = traceRoot(callee.text);
        if (traced) {
          const api = bindings.exportNameOf(callee.text) ?? callee.text;
          push(traced, api, undefined, ts.isNewExpression(node) ? 'construct' : 'call', node);
        } else {
          unresolved++;
        }
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
        // `pool.query(sql)` / `helper.exec(cmd)` — resolve the RECEIVER, never the method name. A
        // dangerous-looking method on an untraceable object is exactly the lookalike the corpus exists for.
        const root = rootIdentifier(callee.expression, ts);
        const traced = root !== undefined ? traceRoot(root) : null;
        if (traced && root !== undefined) {
          // A receiver name is only reported when the binding came STRAIGHT from the package. Anything
          // else is the app's own name for a value: `pool` re-exported from `./lib`, or `Student` returned
          // by `sequelize.define()`. Reporting those as part of the package's API would be inventing an
          // API name — and the first version of this did exactly that, calling pg's method `pool.query`.
          const receiver = traced.resolution === 'direct' ? bindings.exportNameOf(root) ?? root : undefined;
          push(traced, callee.name.text, receiver, 'member', node);
        } else {
          unresolved++;
        }
      } else {
        unresolved++; // computed callee, IIFE, dynamic import — see the limitations note
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { invocations: found, unresolved };
}

/**
 * Aggregate invocations across files.
 *
 * Keyed by package + symbol + kind + resolution, so two call sites with DIFFERENT evidence stay separate
 * entries rather than being merged under whichever was seen first — the strength of the claim is part of
 * the record, not a detail to round off.
 */
export function createInvocationInventory() {
  const byKey = new Map<string, ApiInvocation>();

  return {
    add(invocations: ApiInvocation[]): void {
      for (const invocation of invocations) {
        const key = `${invocation.package}|${invocation.symbol}|${invocation.kind}|${invocation.resolution}`;
        const existing = byKey.get(key);
        if (existing === undefined) {
          byKey.set(key, { ...invocation });
          continue;
        }
        existing.callCount += invocation.callCount;
        for (const specifier of invocation.specifiers) {
          if (!existing.specifiers.includes(specifier)) existing.specifiers.push(specifier);
        }
        if (existing.sites.length < MAX_SITES) existing.sites.push(...invocation.sites.slice(0, MAX_SITES - existing.sites.length));
      }
    },

    list(): ApiInvocation[] {
      return [...byKey.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, invocation]) => ({ ...invocation, specifiers: [...invocation.specifiers].sort() }));
    },
  };
}
