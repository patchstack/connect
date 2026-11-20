// Adapter: Express (Node). Scaffolds a guard that matches the entry file's module format, then
// registers the WAF middleware after the app's body parser and before its routes — the guard reads
// the express-parsed req.body, so it must run once the body is populated.
import { hasDependency } from '../util.js';
import { findAppInstance } from '../find-app.js';
import { wireRegister, verifyRegister, type RegisterSpec } from '../register.js';
import type { Adapter } from '../types.js';

// Balanced parentheses up to three levels deep, so a parser's options (`verify: (req, res, buf) => ...`)
// and the arguments around it are read as whole arguments and never run past the `app.use(` call.
const NESTED = '\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\)';
const BALANCED = `(?:[^()]|${NESTED})*`;
const CALL = `[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*\\(${BALANCED}\\)`;

// A body parser that populates req.body, in any of the shapes AI builders emit: express.json() /
// express.urlencoded(), body-parser's bodyParser.json() / .urlencoded(), an aliased parser
// (any `x.json(` / `x.urlencoded(`), or a destructured `json(` / `urlencoded(`.
//
// The parser may follow a mount path or other middleware in the same call, and the call may span lines.
// Only call expressions (`cors()`) may follow it: a bare identifier or inline handler after the parser can
// be a router the parser feeds, which the guard cannot be registered after. Matched from the start of the
// text, so callers pass the source from the line being asked about onwards.
const bodyParserRe = (appVar: string) =>
  new RegExp(
    `^\\s*${appVar}\\.use\\(\\s*(?:${BALANCED},\\s*)?(?:[A-Za-z_$][\\w$]*\\.)?(?:json|urlencoded)\\(${BALANCED}\\)` +
      `(?:\\s*,\\s*${CALL})*\\s*,?\\s*\\)`,
  );

const SPEC: RegisterSpec = {
  appRe: /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*express\(\)/,
  guardTemplate: 'express-guard.ts',
  guardTemplateEsm: 'express-guard.js',
  guardTemplateCjs: 'express-guard.cjs',
  importName: 'patchstackMiddleware',
  call: (v) => `${v}.use(patchstackMiddleware);`,
  callAfter: bodyParserRe,
  requireCallAfter: true,
  label: 'Express app',
  manualHint:
    'add `app.use(patchstackMiddleware)` after your body parser (express.json/urlencoded or body-parser) and before the routes; ' +
    'if the parser and a router share one `app.use(...)` call, give the parser its own `app.use` above the guard',
};

export const expressAdapter: Adapter = {
  name: 'express',
  label: 'Express (Node)',
  detect: (cwd) => hasDependency(cwd, 'express') && findAppInstance(cwd, SPEC.appRe) !== null,
  wire: (cwd, opts) => wireRegister(cwd, opts, SPEC),
  verify: (cwd) => verifyRegister(cwd, SPEC),
};
