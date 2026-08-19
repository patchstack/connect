import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeploymentShape, ServerSurface, SurfaceSignal } from './types.js';

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
//   server-runtime-detected  a recognized endpoint, or an artifact that declares a deployment
//   static-build-detected    a static generator identified AND nothing suggesting a server surface
//   unknown                  everything else — including "we found nothing and cannot say why"
//
// Three rules keep `static-build-detected` from becoming the default for an unrecognised stack:
//
//   1. It needs a static generator NAMED. Absence of server signals is not evidence; `endpoints: []` is
//      what an unparsed framework looks like, and entry-point recognition has no completeness flag.
//   2. A server-framework dependency blocks it. An app with `express` installed and no endpoint we could
//      read is a parsing gap, not a static site.
//   3. Any deployment shape blocks it — including `layout`. A root `api/` folder holding source may be a
//      front-end helper or a pile of platform functions, and from here they are the same folder. That
//      ambiguity belongs in `unknown`, not in a claim either way.
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
 * Dependencies that mean a server, so a static claim is off the table.
 *
 * Deliberately wider than the framework detector: this list only has to answer "might this app serve
 * requests", and over-answering yes costs a claim we would rather not make anyway.
 */
const SERVER_DEPENDENCIES = [
  'express', 'fastify', 'hono', 'koa', '@nestjs/core', '@hapi/hapi', 'h3', 'polka', 'restify',
  '@tanstack/react-start', '@tanstack/start', '@tanstack/solid-start', '@sveltejs/kit', 'nuxt', 'remix',
  '@remix-run/node', '@remix-run/server-runtime',
];

/** Astro and Next ship both modes, so the adapter or the output setting decides. */
const SSR_ADAPTERS = ['@astrojs/node', '@astrojs/vercel', '@astrojs/cloudflare', '@astrojs/netlify', '@astrojs/deno'];

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

/** Whether a Next project is configured to emit a static export rather than run a server. */
function nextExportsStatically(cwd: string, manifest: Manifest): string | null {
  const scripts = Object.values(manifest.scripts ?? {}).join(' ');
  if (/\bnext\s+export\b/.test(scripts)) return 'next export (build script)';

  for (const file of ['next.config.js', 'next.config.mjs', 'next.config.ts']) {
    try {
      // A textual read, and scoped to the one setting that decides it. Parsing the config would mean
      // executing it, which this analysis will not do.
      if (/output\s*:\s*['"]export['"]/.test(readFileSync(join(cwd, file), 'utf8'))) {
        return `output: 'export' (${file})`;
      }
    } catch { /* next candidate */ }
  }

  return null;
}

/**
 * Static generators this project positively identifies, each with the dependency or setting that named it.
 *
 * Astro and Next are conditional: both ship a server mode, so `astro` alone says nothing and an SSR adapter
 * rules the static reading out entirely.
 */
function staticSignals(cwd: string): SurfaceSignal[] {
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
    const exported = nextExportsStatically(cwd, manifest);
    if (exported !== null) signals.push({ signal: 'static-generator', source: `next: ${exported}` });
  }

  return signals;
}

/** Server-framework dependencies present, each named — they block a static conclusion. */
function serverDependencySignals(cwd: string): SurfaceSignal[] {
  const manifest = readManifest(cwd);
  if (manifest === null) return [];

  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  const found = SERVER_DEPENDENCIES.filter((dep) => deps[dep] !== undefined);

  // `next` counts as a server dependency UNLESS the project exports statically, which `staticSignals`
  // establishes from the same manifest.
  if (deps['next'] !== undefined && nextExportsStatically(cwd, manifest) === null) found.push('next');
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
): ServerSurface {
  const evidence: SurfaceSignal[] = [];

  if (endpointCount > 0) {
    evidence.push({ signal: 'endpoint', source: `${endpointCount} recognized entry point(s)` });
  }
  for (const shape of deploymentShapes) {
    evidence.push({
      signal: shape.evidence === 'layout' ? 'ambiguous-layout' : 'deployment-artifact',
      source: `${shape.shape} (${shape.source})`,
    });
  }

  const servers = serverDependencySignals(cwd);
  const statics = staticSignals(cwd);

  // A recognized endpoint or a declared deployment settles it. `layout` shapes deliberately do not:
  // `api/client.ts` is an ordinary front-end folder, and concluding a runtime from a folder name would
  // classify a pile of client-only apps as having one.
  const declaresDeployment = deploymentShapes.some((shape) => shape.evidence !== 'layout');
  if (endpointCount > 0 || declaresDeployment) {
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
