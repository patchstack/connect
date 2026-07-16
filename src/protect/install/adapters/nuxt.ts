// Adapter: Nuxt (Nitro). Wires the guard as a server middleware file (`server/middleware/`).
// Nuxt runs each file there as independent middleware, so our file coexists with the app's own —
// there's no single hook to compose. Scaffolds a new managed file (never overwrites a divergent one).
import { hasDependency } from '../util.js';
import { wireSeam, verifySeam, type SeamSpec } from '../seam.js';
import type { Adapter, WireOptions, WireResult, VerifyResult } from '../types.js';

const SPEC: SeamSpec = {
  templateName: 'nuxt-middleware.ts',
  candidates: ['server/middleware/patchstack.ts', 'server/middleware/patchstack.js'],
  target: 'server/middleware/patchstack.ts',
  marker: 'patchstack-nuxt',
  planHint: 'add a `server/middleware/` handler that runs the guard, then: npx patchstack-connect protect --check',
  seamLabel: 'Nuxt server middleware',
};

function detect(cwd: string): boolean {
  return hasDependency(cwd, 'nuxt');
}

function wire(cwd: string, opts: WireOptions): WireResult {
  return wireSeam(cwd, opts, SPEC);
}

function verify(cwd: string): VerifyResult {
  return verifySeam(cwd, SPEC);
}

export const nuxtAdapter: Adapter = {
  name: 'nuxt',
  label: 'Nuxt',
  detect,
  wire,
  verify,
};
