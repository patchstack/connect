// Adapter: Express (Node). Scaffolds a guard that matches the entry file's module format, then
// registers parsed-body middleware after express.json() and before the application's routes.
import { hasDependency } from '../util.js';
import { findAppInstance } from '../find-app.js';
import { wireRegister, verifyRegister, type RegisterSpec } from '../register.js';
import type { Adapter } from '../types.js';

const jsonParserRe = (appVar: string) => new RegExp(`^\\s*${appVar}\\.use\\(\\s*express\\.json\\(`, 'm');

const SPEC: RegisterSpec = {
  appRe: /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*express\(\)/,
  guardTemplate: 'express-guard.ts',
  guardTemplateEsm: 'express-guard.js',
  guardTemplateCjs: 'express-guard.cjs',
  importName: 'patchstackMiddleware',
  call: (v) => `${v}.use(patchstackMiddleware);`,
  callAfter: jsonParserRe,
  requireCallAfter: true,
  label: 'Express app',
  manualHint: 'add `app.use(patchstackMiddleware)` after your JSON body parser and before the routes',
};

export const expressAdapter: Adapter = {
  name: 'express',
  label: 'Express (Node)',
  detect: (cwd) => hasDependency(cwd, 'express') && findAppInstance(cwd, SPEC.appRe) !== null,
  wire: (cwd, opts) => wireRegister(cwd, opts, SPEC),
  verify: (cwd) => verifyRegister(cwd, SPEC),
};
