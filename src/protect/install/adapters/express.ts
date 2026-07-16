// Adapter: Express (Node). Scaffolds a guard that matches the entry file's module format, then
// registers the WAF middleware after the app's body parser and before its routes — the guard reads
// the express-parsed req.body, so it must run once the body is populated. Apps with no body parser
// fall back to a self-buffering guard (express-node-guard) mounted right after app creation.
import { hasDependency } from '../util.js';
import { findAppInstance } from '../find-app.js';
import { wireRegister, verifyRegister, type RegisterSpec } from '../register.js';
import type { Adapter } from '../types.js';

// A body parser that populates req.body, in any of the shapes AI builders emit: express.json() /
// express.urlencoded(), body-parser's bodyParser.json() / .urlencoded(), an aliased parser
// (any `x.json(` / `x.urlencoded(`), or a destructured `json(` / `urlencoded(`.
const bodyParserRe = (appVar: string) =>
  new RegExp(`^\\s*${appVar}\\.use\\(\\s*(?:[A-Za-z_$][\\w$]*\\.)?(?:json|urlencoded)\\(`, 'm');

const SPEC: RegisterSpec = {
  appRe: /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*express\(\)/,
  guardTemplate: 'express-guard.ts',
  guardTemplateEsm: 'express-guard.js',
  guardTemplateCjs: 'express-guard.cjs',
  // No body parser → no parsed req.body to read after, so mount a self-buffering guard right after
  // app creation (before the routes) instead of skipping the app.
  fallbackGuardTemplate: 'express-node-guard.ts',
  fallbackGuardTemplateEsm: 'express-node-guard.js',
  fallbackGuardTemplateCjs: 'express-node-guard.cjs',
  importName: 'patchstackMiddleware',
  call: (v) => `${v}.use(patchstackMiddleware);`,
  callAfter: bodyParserRe,
  requireCallAfter: true,
  label: 'Express app',
  manualHint: 'add `app.use(patchstackMiddleware)` after your body parser (express.json/urlencoded or body-parser) and before the routes',
};

export const expressAdapter: Adapter = {
  name: 'express',
  label: 'Express (Node)',
  detect: (cwd) => hasDependency(cwd, 'express') && findAppInstance(cwd, SPEC.appRe) !== null,
  wire: (cwd, opts) => wireRegister(cwd, opts, SPEC),
  verify: (cwd) => verifyRegister(cwd, SPEC),
};
