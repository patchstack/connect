// Adapter: Express (Node). Scaffolds the framework-agnostic guard and wires it as the first
// middleware — `app.use(patchstackMiddleware)` right after the `express()` app is created.
import { hasDependency } from '../util.js';
import { findAppInstance } from '../find-app.js';
import { wireRegister, verifyRegister, type RegisterSpec } from '../register.js';
import type { Adapter } from '../types.js';

const SPEC: RegisterSpec = {
  appRe: /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*express\(\)/,
  guardTemplate: 'generic-guard.ts',
  importName: 'patchstackMiddleware',
  call: (v) => `${v}.use(patchstackMiddleware);`,
  label: 'Express app',
  manualHint: 'add `app.use(patchstackMiddleware)` right after you create your express() app',
};

export const expressAdapter: Adapter = {
  name: 'express',
  label: 'Express (Node)',
  detect: (cwd) => hasDependency(cwd, 'express') && findAppInstance(cwd, SPEC.appRe) !== null,
  wire: (cwd, opts) => wireRegister(cwd, opts, SPEC),
  verify: (cwd) => verifyRegister(cwd, SPEC),
};
