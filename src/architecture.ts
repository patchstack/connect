import { readFileSync } from 'node:fs';
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
 * This asks a NARROWER question than `map`'s `serverSurface`, and the two differ deliberately on one
 * signal. `serverSurface` describes the app, so a platform config (`netlify.toml`, `vercel.json`) blocks it
 * from calling anything static — the project deploys somewhere, and that is not a thing the analysis can
 * claim to have looked behind. A guard does not need to know where the app deploys; it needs somewhere to
 * be invoked from. A config file is not that, so it does not block the verdict here, and the same static
 * site keeps an honest answer instead of an `unknown` that would scaffold a dead guard.
 *
 * Everything else stays conservative in the same direction `serverSurface` is: `none` requires a static
 * generator to have been NAMED. Absence of server evidence is not evidence of absence — an unparsed
 * framework produces exactly the same silence — so an unrecognised project is `unknown` and still gets the
 * generic scaffold and its wiring plan.
 */
export type RequestPath =
  /** Something in this project receives requests, so a guard has a seam. */
  | 'server'
  /** A static build was identified and nothing here receives a request. */
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
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function declaredDependencies(cwd: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as Manifest;
    return { ...parsed.dependencies, ...parsed.devDependencies };
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

/** Static generators this project positively identifies, each with the dependency that named it. */
function staticGenerators(deps: Record<string, string>): string[] {
  return STATIC_GENERATORS.filter((generator) => deps[generator.dep] !== undefined).map(
    (generator) => generator.label,
  );
}

/**
 * Tooling that builds for an edge runtime, which serves requests without any of the server frameworks
 * above appearing in the manifest.
 *
 * A Worker is a request path — but the same toolchain also publishes purely static Pages projects, and
 * from the manifest the two are identical. So this does not establish a server; it rules out claiming
 * there is none, which leaves the app `unknown` and keeps its guard scaffolded.
 */
const EDGE_RUNTIME_TOOLING = ['wrangler', '@cloudflare/workers-types', 'miniflare'];

/** Deployment shapes that could be hiding a runtime, so a `none` verdict may not be claimed over them. */
const RUNTIME_AMBIGUOUS_SHAPES = new Set(['cloudflare-workers']);

export function classifyArchitecture(cwd: string): ArchitectureVerdict {
  let deps: Record<string, string>;
  let shapes: ReturnType<typeof detectDeploymentShapes>;
  try {
    deps = declaredDependencies(cwd);
    shapes = detectDeploymentShapes(cwd);
  } catch {
    // A project this cannot read says nothing about itself, and silence is not a static build.
    return {
      requestPath: 'unknown',
      evidence: [],
      note: 'This project could not be inspected, so whether it has a request path is unknown.',
    };
  }

  const servers = serverDependencies(deps);
  const statics = staticGenerators(deps);

  // Only a shape that SERVES counts: a worker entry, or a provider function directory with source in it.
  // A platform config is not one (see the header), and a bare root `api/` folder is ambiguous enough that
  // it blocks a `none` verdict below without supporting a `server` one.
  const serving = shapes.filter((shape) => shape.evidence === 'runtime-entry');
  const ambiguous = [
    ...shapes.filter(
      (shape) => shape.evidence === 'layout' || RUNTIME_AMBIGUOUS_SHAPES.has(shape.shape),
    ).map((shape) => `${shape.shape} (${shape.source})`),
    ...EDGE_RUNTIME_TOOLING.filter((dep) => deps[dep] !== undefined).map(
      (dep) => `edge runtime tooling: ${dep}`,
    ),
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
    evidence: [
      ...statics.map((label) => `static build: ${label}`),
      ...ambiguous.map((source) => `ambiguous: ${source}`),
    ],
    note:
      'Neither a request path nor a purely static build could be identified here. An unparsed framework ' +
      'looks exactly like this, so protection is scaffolded and its wiring left to be finished rather ' +
      'than assumed unnecessary.',
  };
}
