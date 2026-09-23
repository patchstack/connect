// Adapter: Astro. Wires the guard as middleware (`src/middleware.ts` → `onRequest`).
import { hasDependency } from '../util.js';
import { wireSeam, verifySeam, type SeamSpec } from '../seam.js';
import type { Adapter, WireOptions, WireResult, VerifyResult } from '../types.js';

const SPEC: SeamSpec = {
  templateName: 'astro-middleware.ts',
  candidates: ['src/middleware.ts', 'src/middleware.js', 'src/middleware/index.ts', 'src/middleware/index.js'],
  target: 'src/middleware.ts',
  marker: 'patchstack-astro',
  planHint: 'add the guard to your `onRequest` (compose with `sequence()` from "astro:middleware"), then: npx patchstack-connect protect --check',
  seamLabel: 'Astro middleware',
};

function detect(cwd: string): boolean {
  return hasDependency(cwd, 'astro');
}

function wire(cwd: string, opts: WireOptions): WireResult {
  return wireSeam(cwd, opts, SPEC);
}

function verify(cwd: string): VerifyResult {
  return verifySeam(cwd, SPEC);
}

export const astroAdapter: Adapter = {
  name: 'astro',
  label: 'Astro',
  detect,
  wire,
  verify,
};
