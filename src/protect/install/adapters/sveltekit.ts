// Adapter: SvelteKit. Wires the guard as a server hook (`src/hooks.server.ts` → `handle`).
import { join } from 'node:path';
import { read } from '../util.js';
import { wireSeam, verifySeam, type SeamSpec } from '../seam.js';
import type { Adapter, WireOptions, WireResult, VerifyResult } from '../types.js';

const SPEC: SeamSpec = {
  templateName: 'sveltekit-hooks.ts',
  candidates: ['src/hooks.server.ts', 'src/hooks.server.js'],
  target: 'src/hooks.server.ts',
  marker: 'patchstack-sveltekit',
  planHint: 'add the guard to your `handle` (compose with `sequence()` from "@sveltejs/kit/hooks"), then: npx patchstack-connect protect --check',
  seamLabel: 'SvelteKit server hook',
};

function detect(cwd: string): boolean {
  try {
    const pkg = JSON.parse(read(join(cwd, 'package.json')));
    return Boolean({ ...pkg.dependencies, ...pkg.devDependencies }['@sveltejs/kit']);
  } catch {
    return false;
  }
}

function wire(cwd: string, opts: WireOptions): WireResult {
  return wireSeam(cwd, opts, SPEC);
}

function verify(cwd: string): VerifyResult {
  return verifySeam(cwd, SPEC);
}

export const sveltekitAdapter: Adapter = {
  name: 'sveltekit',
  label: 'SvelteKit',
  detect,
  wire,
  verify,
};
