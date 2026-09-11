import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { detectDeploymentShapes } from './map/sources.js';
import {
  CONDITIONAL_SERVER_DEPENDENCIES,
  SERVER_DEPENDENCIES,
  SSR_ADAPTERS,
  SSR_COMPANIONS,
  STATIC_GENERATORS,
} from './map/surface.js';

/**
 * Is there a request path in this project for a runtime guard to attach to?
 *
 * The guard screens requests as they arrive, so it needs something that receives one. A project that only
 * emits files at build time never does, and every artifact protection would install there — a guard module,
 * a rules file, a `--check` that can never pass — is inert. Scaffolding it anyway costs more than nothing:
 * it puts security-shaped files in a repository that no request will ever reach, and leaves a permanently
 * red check that teaches the reader to ignore the command.
 *
 * `none` is the dangerous answer, because it withholds protection, so it is only given on positive
 * static-only evidence: a static site GENERATOR is named, and nothing else in the project could serve. A
 * bundler is not a generator — `vite` and its kin build client apps and server apps alike — so a bundler
 * alone never supports `none`. And a generator beside a `server.mjs` that calls `createServer` is not a
 * static site, so the usual server entry files are read for the calls that serve. Any of these turns the
 * answer to `unknown`, which scaffolds the generic guard and leaves its wiring to be finished, exactly as
 * an unrecognised project always has.
 *
 * This asks a NARROWER question than `map`'s `serverSurface`, and the two differ deliberately on one
 * signal. `serverSurface` describes the app, so a platform config (`netlify.toml`, `vercel.json`) blocks it
 * from calling anything static — the project deploys somewhere, and that is not a thing the analysis can
 * claim to have looked behind. A guard does not need to know where the app deploys; it needs somewhere to
 * be invoked from. A config file is not that, so it does not block the verdict here.
 */
export type RequestPath =
  /** Something in this project receives requests, so a guard has a seam. */
  | 'server'
  /** A static site generator was named and nothing here receives a request. */
  | 'none'
  /** Neither could be established. Never to be read as "no server side". */
  | 'unknown';

export interface ArchitectureVerdict {
  requestPath: RequestPath;
  /** The signals behind the verdict, each named, so a reader can disagree with it. */
  evidence: string[];
  /** One sentence a caller can print verbatim. */
  note: string;
}

interface Manifest {
  main?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * Bundlers that appear in the static-generator registry because a plain client app is built with them,
 * but which say nothing about whether a server sits beside that app. Never enough on their own.
 */
const BUNDLERS_NOT_GENERATORS = new Set(['vite', 'parcel']);

/**
 * Tooling that builds for an edge runtime, which serves requests without any of the server frameworks
 * appearing in the manifest. The same toolchain also publishes purely static Pages projects, so this rules
 * out `none` without establishing `server`.
 */
const EDGE_RUNTIME_TOOLING = ['wrangler', '@cloudflare/workers-types', 'miniflare'];

/** Deployment shapes that could be hiding a runtime, so a `none` verdict may not be claimed over them. */
const RUNTIME_AMBIGUOUS_SHAPES = new Set(['cloudflare-workers']);

/**
 * Where a hand-written server usually lives. The same list the generic installer's wiring plan reads, so
 * the file this rules on is the file that plan would have told the reader to wire.
 */
const SERVER_ENTRY_CANDIDATES = [
  'server.ts', 'server.js', 'server.mjs', 'server.cjs',
  'src/server.ts', 'src/server.js', 'src/server.mjs',
  'index.ts', 'index.js', 'index.mjs', 'index.cjs',
  'src/index.ts', 'src/index.js', 'src/index.mjs',
  'app.ts', 'app.js', 'app.mjs',
  'src/app.ts', 'src/app.js', 'src/app.mjs',
  'src/main.ts', 'src/main.js',
];

/** Calls that mean a request is received. Textual, and deliberately broad: a miss here withholds protection. */
const SERVING_CALL = /\b(?:createServer|createSecureServer|Bun\.serve|Deno\.serve|serve\s*\(|\.listen\s*\(|express\s*\(|fastify\s*\(|new\s+(?:Hono|Koa|Elysia)\b)/;

const MAX_ENTRY_BYTES = 256 * 1024;

function readManifest(cwd: string): Manifest {
  try {
    const parsed = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Manifest) : {};
  } catch {
    return {};
  }
}

/** Server-framework dependencies present, each named. Any one of them means a request can arrive. */
function serverDependencies(deps: Record<string, string>): string[] {
  const found = SERVER_DEPENDENCIES.filter((dep) => deps[dep] !== undefined);

  // Both-mode frameworks: only a server dependency when the project does not also install the
  // dependency that makes it static.
  for (const conditional of CONDITIONAL_SERVER_DEPENDENCIES) {
    if (deps[conditional.dep] !== undefined && deps[conditional.staticWhen] === undefined) {
      found.push(conditional.dep);
    }
  }

  for (const companion of SSR_COMPANIONS) {
    if (deps[companion] !== undefined) found.push(companion);
  }

  // `next` and `astro` ship both modes. Read conservatively here: an SSR adapter is positive evidence of a
  // server, and bare `next` is treated as one because its default mode serves.
  if (deps['next'] !== undefined) found.push('next');
  if (deps['astro'] !== undefined) {
    for (const adapter of SSR_ADAPTERS) if (deps[adapter] !== undefined) found.push(adapter);
  }

  return [...new Set(found)];
}

/** Static site generators this project positively names. Bundlers are excluded — see the header. */
function staticGenerators(deps: Record<string, string>): string[] {
  return STATIC_GENERATORS.filter(
    (generator) => deps[generator.dep] !== undefined && !BUNDLERS_NOT_GENERATORS.has(generator.dep),
  ).map((generator) => generator.label);
}

/**
 * Hand-written server entries: the usual file names, plus whatever `package.json#main` points at, each
 * read for a call that serves. Project-relative names only, so a `main` pointing outside the project is
 * not followed.
 */
function serverEntries(cwd: string, manifest: Manifest): string[] {
  const candidates = new Set(SERVER_ENTRY_CANDIDATES);
  if (typeof manifest.main === 'string' && manifest.main !== '' && !path.isAbsolute(manifest.main)) {
    const main = path.normalize(manifest.main);
    if (!main.startsWith('..')) candidates.add(main);
  }

  const found: string[] = [];
  for (const relative of candidates) {
    const file = path.join(cwd, relative);
    try {
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      const text = readFileSync(file, 'utf8').slice(0, MAX_ENTRY_BYTES);
      if (SERVING_CALL.test(text)) found.push(relative);
    } catch {
      // Unreadable is not evidence either way; the other candidates still decide.
    }
  }

  return found;
}

export function classifyArchitecture(cwd: string): ArchitectureVerdict {
  let manifest: Manifest;
  let shapes: ReturnType<typeof detectDeploymentShapes>;
  try {
    manifest = readManifest(cwd);
    shapes = detectDeploymentShapes(cwd);
  } catch {
    // A project this cannot read says nothing about itself, and silence is not a static build.
    return {
      requestPath: 'unknown',
      evidence: [],
      note: 'This project could not be inspected, so whether it has a request path is unknown.',
    };
  }

  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  const servers = serverDependencies(deps);
  const statics = staticGenerators(deps);

  // Only a shape that SERVES counts towards `server`: a worker entry, or a provider function directory
  // with source in it. A platform config is not one (see the header); a bare root `api/` folder and a
  // wrangler config are ambiguous enough to block `none` without supporting `server`.
  const serving = shapes.filter((shape) => shape.evidence === 'runtime-entry');
  const ambiguous = [
    ...shapes
      .filter((shape) => shape.evidence === 'layout' || RUNTIME_AMBIGUOUS_SHAPES.has(shape.shape))
      .map((shape) => `${shape.shape} (${shape.source})`),
    ...EDGE_RUNTIME_TOOLING.filter((dep) => deps[dep] !== undefined).map((dep) => `edge runtime tooling: ${dep}`),
    ...serverEntries(cwd, manifest).map((file) => `server entry: ${file}`),
  ];

  if (servers.length > 0 || serving.length > 0) {
    return {
      requestPath: 'server',
      evidence: [
        ...servers.map((dep) => `server dependency: ${dep}`),
        ...serving.map((shape) => `serves requests: ${shape.shape} (${shape.source})`),
      ],
      note: 'This project receives requests, so runtime protection applies to them.',
    };
  }

  if (statics.length > 0 && ambiguous.length === 0) {
    return {
      requestPath: 'none',
      evidence: statics.map((label) => `static build: ${label}`),
      note:
        `This project builds a static site (${statics.join(', ')}) and nothing in it receives a request, ` +
        'so there is no request path for a runtime guard to attach to. Dependency monitoring and the ' +
        'disclosure widget still apply; runtime protection does not.',
    };
  }

  return {
    requestPath: 'unknown',
    evidence: [...statics.map((label) => `static build: ${label}`), ...ambiguous.map((source) => `ambiguous: ${source}`)],
    note:
      'Neither a request path nor a purely static build could be identified here. An unparsed framework ' +
      'looks exactly like this, so protection is scaffolded and its wiring left to be finished rather ' +
      'than assumed unnecessary.',
  };
}
