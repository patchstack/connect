// Adapter: NestJS. Wires the guard in the bootstrap file — `app.use(patchstackMiddleware)` right
// after `NestFactory.create(...)`. Nest's INestApplication.use() accepts Express-style middleware
// (the default platform), so this reuses the framework-agnostic guard rather than a Nest module +
// decorators. On the Fastify platform the guard is still fail-open; response screening isn't wired.
import { hasDependency } from '../util.js';
import { findAppInstance } from '../find-app.js';
import { wireRegister, verifyRegister, type RegisterSpec } from '../register.js';
import type { Adapter } from '../types.js';

const SPEC: RegisterSpec = {
  appRe: /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+NestFactory\.create/,
  guardTemplate: 'generic-guard.ts',
  importName: 'patchstackMiddleware',
  call: (v) => `${v}.use(patchstackMiddleware);`,
  label: 'NestJS app',
  manualHint: 'add `app.use(patchstackMiddleware)` right after your NestFactory.create(...) call',
};

export const nestjsAdapter: Adapter = {
  name: 'nestjs',
  label: 'NestJS',
  detect: (cwd) => hasDependency(cwd, '@nestjs/core') && findAppInstance(cwd, SPEC.appRe) !== null,
  wire: (cwd, opts) => wireRegister(cwd, opts, SPEC),
  verify: (cwd) => verifyRegister(cwd, SPEC),
};
