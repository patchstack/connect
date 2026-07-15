// Adapter: Fastify (Node). Scaffolds the Fastify guard plugin and registers it on the app —
// `app.register(patchstackFastify)` right after the `fastify()` instance is created.
import { hasDependency } from '../util.js';
import { findAppInstance } from '../find-app.js';
import { wireRegister, verifyRegister, type RegisterSpec } from '../register.js';
import type { Adapter } from '../types.js';

const SPEC: RegisterSpec = {
  appRe: /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:fastify|Fastify)\(/,
  guardTemplate: 'fastify-plugin.ts',
  importName: 'patchstackFastify',
  call: (v) => `${v}.register(patchstackFastify);`,
  label: 'Fastify app',
  manualHint: 'add `app.register(patchstackFastify)` right after you create your fastify() app',
};

export const fastifyAdapter: Adapter = {
  name: 'fastify',
  label: 'Fastify (Node)',
  detect: (cwd) => hasDependency(cwd, 'fastify') && findAppInstance(cwd, SPEC.appRe) !== null,
  wire: (cwd, opts) => wireRegister(cwd, opts, SPEC),
  verify: (cwd) => verifyRegister(cwd, SPEC),
};
