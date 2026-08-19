import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeploymentShape, ServerSurface, SurfaceSignal, TsModule } from './types.js';

// Does this app have a server side at all?
//
// The question is worth answering because the answer changes what protection MEANS: an app with no server
// runtime cannot run a request guard, so its advisories are dependency and bundle hygiene rather than
// request-path risk. Told plainly, that is useful. Told wrongly, it is the worst output this analysis can
// produce — "nothing to protect here" on an app we simply failed to read.
//
// So the classification is built from POSITIVE signals on both sides, and the honest answer is usually
// neither:
//
//   server-runtime-detected  a recognized endpoint, or an artifact that SERVES (a worker entry, a provider
//                            function directory with source)
//   static-build-detected    a static generator identified AND nothing suggesting a server surface
//   unknown                  everything else — including "we found nothing and cannot say why"
//
// A deployment CONFIG is not in that first list, and that is the correction that matters most here: a static
// site on Netlify has a `netlify.toml`, a static Vercel project has a `vercel.json`, and a Pages project
// serving only assets has a `wrangler.toml`. Reading those as a runtime would have classified a large share
// of purely static apps as having a server. They stay visible in the evidence and they still rule out a
// confident static claim — a project that deploys somewhere is not one this analysis can call server-free —
// but the answer with nothing else behind it is `unknown`.
//
// Three rules keep `static-build-detected` from becoming the default for an unrecognised stack:
//
//   1. It needs a static generator NAMED. Absence of server signals is not evidence; `endpoints: []` is
//      what an unparsed framework looks like, and entry-point recognition has no completeness flag.
//   2. A server-framework dependency blocks it. An app with `express` installed and no endpoint we could
//      read is a parsing gap, not a static site.
//   3. Any deployment shape blocks it — config and `layout` included. A root `api/` folder holding source
//      may be a front-end helper or a pile of platform functions, and from here they are the same folder.
//      That ambiguity belongs in `unknown`, not in a claim either way.
//
// Even `static-build-detected` is not deployment attestation: it says the source describes a static build,
// not that nothing server-side is deployed. Only build or platform metadata can carry that, and this
// analysis never sees it.

/** Dependencies that build a static bundle and, on their own, no server. */
const STATIC_GENERATORS: Array<{ dep: string; label: string }> = [
  { dep: 'vite', label: 'vite' },
  { dep: 'react-scripts', label: 'create-react-app' },
  { dep: 'gatsby', label: 'gatsby' },
  { dep: 'parcel', label: 'parcel' },
  { dep: '@sveltejs/adapter-static', label: 'sveltekit-static-adapter' },
];

/**
 * Build tools that turn a static bundler into an SSR stack.
 *
 * Vite is the awkward one: it is the default bundler for client-only apps AND the foundation of several
 * server frameworks, so `vite` in a manifest is not by itself a static build. Anything here vetoes the
 * static reading and leaves the app `unknown`, which is the conservative direction for a state whose product
 * meaning is "no request-path protection needed".
 */
const SSR_COMPANIONS = ['vike', 'vite-plugin-ssr', '@react-router/node', '@react-router/serve', 'vite-plugin-node'];

/**
 * Dependencies that mean a server, so a static claim is off the table.
 *
 * Deliberately wider than the framework detector: this list only has to answer "might this app serve
 * requests", and over-answering yes costs a claim we would rather not make anyway.
 */
const SERVER_DEPENDENCIES = [
  'express', 'fastify', 'hono', 'koa', '@nestjs/core', '@hapi/hapi', 'h3', 'polka', 'restify',
  '@tanstack/react-start', '@tanstack/start', '@tanstack/solid-start', 'nuxt', 'remix',
  '@remix-run/node', '@remix-run/server-runtime',
];

/**
 * Frameworks that ship BOTH modes, where another dependency decides which one this project is.
 *
 * `@sveltejs/kit` is the case that made this necessary: every static SvelteKit app has it alongside
 * `@sveltejs/adapter-static`, so treating kit as an unconditional server dependency made a real static
 * SvelteKit project permanently `unknown` — and the test that "proved" the adapter worked installed the
 * adapter with no kit, which is not a package set anyone ships.
 */
const CONDITIONAL_SERVER_DEPENDENCIES: Array<{ dep: string; staticWhen: string }> = [
  { dep: '@sveltejs/kit', staticWhen: '@sveltejs/adapter-static' },
];

/** Astro and Next ship both modes, so the adapter or the output setting decides. */
const SSR_ADAPTERS = ['@astrojs/node', '@astrojs/vercel', '@astrojs/cloudflare', '@astrojs/netlify', '@astrojs/deno'];

/** How each deployment-evidence level appears in the surface evidence list. */
const SHAPE_SIGNAL: Record<DeploymentShape['evidence'], SurfaceSignal['signal']> = {
  'runtime-entry': 'runtime-entry',
  'deployment-config': 'deployment-config',
  layout: 'ambiguous-layout',
};

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

function readManifest(cwd: string): Manifest | null {
  try {
    const parsed = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));

    return typeof parsed === 'object' && parsed !== null ? parsed as Manifest : null;
  } catch {
    return null; // no manifest, or unreadable — either way nothing is identified from it
  }
}

/**
 * Whether a Next project is configured to emit a static export rather than run a server.
 *
 * The config is PARSED, not pattern-matched. A regex over the file text accepts
 * `// output: 'export'`, the same words inside a string, and an example block nobody exports — and each of
 * those would have reclassified an ordinary server-mode Next app as static, which is the direction that
 * loses protection. Parsing is also not the same as executing: the AST is read, the config never runs.
 *
 * Only a value reachable from the module's export counts, so dead code declaring `output: 'export'` is
 * ignored too. The wrapper form (`withPlugins(config)`, `withMDX({...})`) is followed one level, since it
 * is how most real Next configs are written.
 */
function nextExportsStatically(cwd: string, manifest: Manifest, ts: TsModule | undefined): string | null {
  const scripts = Object.values(manifest.scripts ?? {}).join(' ');
  // Scripts are JSON strings — no comments to be fooled by.
  if (/\bnext\s+export\b/.test(scripts)) return 'next export (build script)';

  if (ts === undefined) return null; // no compiler available: nothing is claimed from the config

  for (const file of ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs']) {
    let text: string;
    try {
      text = readFileSync(join(cwd, file), 'utf8');
    } catch {
      continue;
    }

    try {
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      if (exportedConfigIsStatic(sf, ts)) return `output: 'export' (${file})`;
    } catch { /* unparseable config claims nothing */ }
  }

  return null;
}

/**
 * `output: 'export'` on the object this module actually exports.
 *
 * Alias following is cycle-safe by construction. `const a = b; const b = a; export default a` would
 * otherwise recurse until the stack gave out, and while the surrounding catch turns that into a
 * conservative `unknown`, a malformed config should be an ordinary answer rather than an exception used as
 * control flow — a thrown RangeError also discards any signal found before it.
 */
function exportedConfigIsStatic(sf: any, ts: TsModule): boolean {
  const objects: any[] = [];
  const followed = new Set<string>();

  const collectFrom = (expr: any): void => {
    if (!expr) return;
    if (ts.isObjectLiteralExpression(expr)) { objects.push(expr); return; }
    // `export default withPlugins({...})` / `module.exports = withMDX(config)`
    if (ts.isCallExpression(expr)) { for (const arg of expr.arguments) collectFrom(arg); return; }
    // `const nextConfig = {...}; export default nextConfig`
    if (ts.isIdentifier(expr)) {
      const name = expr.text;
      if (followed.has(name)) return; // already resolved, or part of a cycle
      followed.add(name);
      const visit = (node: any): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
          collectFrom(node.initializer);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  };

  const findExports = (node: any): void => {
    // `export default X`
    if (ts.isExportAssignment(node)) collectFrom(node.expression);
    // `module.exports = X`
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left)
      && node.left.name.text === 'exports') {
      collectFrom(node.right);
    }
    ts.forEachChild(node, findExports);
  };
  findExports(sf);

  for (const object of objects) {
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = property.name;
      const keyName = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
      if (keyName !== 'output') continue;
      if (ts.isStringLiteralLike(property.initializer) && property.initializer.text === 'export') return true;
    }
  }

  return false;
}

/**
 * Static generators this project positively identifies, each with the dependency or setting that named it.
 *
 * Astro and Next are conditional: both ship a server mode, so `astro` alone says nothing and an SSR adapter
 * rules the static reading out entirely.
 */
function staticSignals(cwd: string, ts: TsModule | undefined): SurfaceSignal[] {
  const manifest = readManifest(cwd);
  if (manifest === null) return [];

  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  const signals: SurfaceSignal[] = [];

  for (const generator of STATIC_GENERATORS) {
    if (deps[generator.dep] !== undefined) {
      signals.push({ signal: 'static-generator', source: generator.label });
    }
  }

  if (deps['astro'] !== undefined && !SSR_ADAPTERS.some((adapter) => deps[adapter] !== undefined)) {
    signals.push({ signal: 'static-generator', source: 'astro (no SSR adapter)' });
  }

  if (deps['next'] !== undefined) {
    const exported = nextExportsStatically(cwd, manifest, ts);
    if (exported !== null) signals.push({ signal: 'static-generator', source: `next: ${exported}` });
  }

  return signals;
}

/** Server-framework dependencies present, each named — they block a static conclusion. */
function serverDependencySignals(cwd: string, ts: TsModule | undefined): SurfaceSignal[] {
  const manifest = readManifest(cwd);
  if (manifest === null) return [];

  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  const found = SERVER_DEPENDENCIES.filter((dep) => deps[dep] !== undefined);

  // Both-mode frameworks: present, but not a server dependency when the project also installs the
  // dependency that makes it static.
  for (const conditional of CONDITIONAL_SERVER_DEPENDENCIES) {
    if (deps[conditional.dep] !== undefined && deps[conditional.staticWhen] === undefined) {
      found.push(conditional.dep);
    }
  }

  // An SSR companion turns a static bundler into a server stack, so it vetoes the static reading the same
  // way a server framework does. `vite` alone is not a static build.
  for (const companion of SSR_COMPANIONS) if (deps[companion] !== undefined) found.push(companion);

  // `next` counts as a server dependency UNLESS the project exports statically, which `staticSignals`
  // establishes from the same manifest.
  if (deps['next'] !== undefined && nextExportsStatically(cwd, manifest, ts) === null) found.push('next');
  if (deps['astro'] !== undefined) {
    for (const adapter of SSR_ADAPTERS) if (deps[adapter] !== undefined) found.push(adapter);
  }

  return found.map((dep) => ({ signal: 'server-dependency', source: dep }));
}

/**
 * Classify the app's server surface from what was positively found.
 *
 * `endpointCount` and `deploymentShapes` come from the analysis that already ran; the manifest signals are
 * read here. Nothing in this function infers from absence except the final fall-through to `unknown`,
 * which is the one honest thing absence supports.
 */
export function classifyServerSurface(
  cwd: string,
  endpointCount: number,
  deploymentShapes: DeploymentShape[],
  ts?: TsModule,
): ServerSurface {
  const evidence: SurfaceSignal[] = [];

  if (endpointCount > 0) {
    evidence.push({ signal: 'endpoint', source: `${endpointCount} recognized entry point(s)` });
  }
  for (const shape of deploymentShapes) {
    evidence.push({
      signal: SHAPE_SIGNAL[shape.evidence],
      source: `${shape.shape} (${shape.source})`,
    });
  }

  const servers = serverDependencySignals(cwd, ts);
  const statics = staticSignals(cwd, ts);

  // Only code that SERVES settles this: a recognized endpoint, a worker entry, or a provider function
  // directory with source in it. A deployment config does not — a static site on Netlify has a
  // `netlify.toml` and no server — and a `layout` folder does not either, since `api/client.ts` is an
  // ordinary front-end helper. Both remain in the evidence, and both still block a static claim below.
  const servesRequests = deploymentShapes.some((shape) => shape.evidence === 'runtime-entry');
  if (endpointCount > 0 || servesRequests) {
    return { state: 'server-runtime-detected', evidence };
  }

  evidence.push(...servers, ...statics);

  const blocked = servers.length > 0 || deploymentShapes.length > 0;
  if (statics.length > 0 && !blocked) {
    return { state: 'static-build-detected', evidence };
  }

  return { state: 'unknown', evidence };
}

/** The sentence that goes with each state, so a consumer states the same limits the analysis does. */
export function surfaceNote(surface: ServerSurface): string {
  if (surface.state === 'server-runtime-detected') {
    return 'serverSurface: a server runtime was recognized in the analysed source (see its evidence). Request-path protection applies to this app.';
  }

  if (surface.state === 'static-build-detected') {
    return 'serverSurface: a static build was identified and no server runtime was recognized in the analysed source. This is NOT deployment attestation — it describes the source, not what is deployed, and a serverless function added at the platform level would not appear here. Advisories against this app are dependency and bundle concerns rather than request-path risk.';
  }

  return 'serverSurface is UNKNOWN: neither a server runtime nor a static build could be positively identified. This is the honest answer for an unrecognised stack, and it must not be read as "no server side" — an unparsed framework produces no endpoints, and entry-point recognition has no completeness flag.';
}
