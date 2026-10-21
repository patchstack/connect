// React Router gates route `middleware` behind a future flag, and ignores the export without it: a guard
// wired as root middleware then runs on nothing. The flag's name moved with the version —
// `unstable_middleware` (7.3–7.8), `v8_middleware` (7.9+), and the default in v8 — so wiring the guard has
// to turn on the one this project's version reads, in react-router.config.ts, or the guard is inert.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type tsType from 'typescript';
import { read } from './util.js';
import { sourceCompiler, parsedSource, type Compiler } from './syntax.js';
import { writeProjectFileSync } from '../../safe-file.js';

const CONFIG_FILES = [
  'react-router.config.ts', 'react-router.config.mts', 'react-router.config.cts',
  'react-router.config.js', 'react-router.config.mjs', 'react-router.config.cjs',
  'react-router.config.tsx', 'react-router.config.jsx',
];

/** The react-router version in force: the installed package (exact), else the declared range's lower bound. */
function reactRouterVersion(cwd: string): { major: number; minor: number } | null {
  const parse = (value: unknown): { major: number; minor: number } | null => {
    const m = /(\d+)\.(\d+)\./.exec(String(value ?? ''));
    return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
  };
  try {
    const installed = (createRequire(join(cwd, 'package.json'))('react-router/package.json') as { version?: string }).version;
    const v = parse(installed);
    if (v) return v;
  } catch { /* not resolvable from here — fall back to the declaration */ }
  try {
    const pkg = JSON.parse(read(join(cwd, 'package.json'))) as {
      dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.devDependencies, ...pkg.dependencies };
    return parse(deps['react-router'] ?? deps['@react-router/dev']);
  } catch {
    return null;
  }
}

/**
 * The future flag this project's react-router needs to run route middleware, or null when it needs none —
 * v8 (middleware is the default) or a version too old to have it. Null is also returned when the version
 * cannot be read, because guessing a flag name that the running version does not recognise is worse than
 * leaving it: the guard would still be silent, and the config would carry a key that means nothing.
 */
export function middlewareFlagFor(cwd: string): string | null {
  const v = reactRouterVersion(cwd);
  if (v === null || v.major >= 8 || v.major < 7) return null;

  return v.minor >= 9 ? 'v8_middleware' : 'unstable_middleware';
}

/** The react-router.config.* file in this project, or null when it has none. */
export function reactRouterConfigFile(cwd: string): string | null {
  return CONFIG_FILES.find((file) => existsSync(join(cwd, file))) ?? null;
}

/** The object literal a `react-router.config` default-exports, unwrapping `satisfies`/`as`/`defineConfig(...)`. */
function defaultExportObject(ts: Compiler, tree: tsType.SourceFile): tsType.ObjectLiteralExpression | null {
  for (const node of tree.statements) {
    if (!ts.isExportAssignment(node) || node.isExportEquals) continue;
    let expr: tsType.Expression = node.expression;
    while (ts.isSatisfiesExpression(expr) || ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr)) {
      expr = expr.expression;
    }
    // `defineConfig({...})` — the config object is the first argument.
    if (ts.isCallExpression(expr) && expr.arguments.length > 0 && ts.isObjectLiteralExpression(expr.arguments[0]!)) {
      return expr.arguments[0] as tsType.ObjectLiteralExpression;
    }
    if (ts.isObjectLiteralExpression(expr)) return expr;
  }

  return null;
}

/** A named property of an object literal, or undefined. */
function property(ts: Compiler, obj: tsType.ObjectLiteralExpression, name: string): tsType.PropertyAssignment | undefined {
  return obj.properties.find((p): p is tsType.PropertyAssignment =>
    ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name) as
    tsType.PropertyAssignment | undefined;
}

export type FlagOutcome = 'enabled' | 'already' | 'not-needed' | 'no-config' | 'manual';

/** Whether react-router.config already turns on `flag`. */
export function hasMiddlewareFlag(cwd: string, flag: string): boolean {
  const rel = reactRouterConfigFile(cwd);
  const ts = sourceCompiler(cwd);
  if (rel === null || !ts) return false;
  const tree = parsedSource(ts, rel, read(join(cwd, rel)));
  if (!tree) return false;
  const obj = defaultExportObject(ts, tree);
  if (!obj) return false;
  const future = property(ts, obj, 'future');
  if (!future || !ts.isObjectLiteralExpression(future.initializer)) return false;

  return property(ts, future.initializer, flag) !== undefined;
}

/**
 * Turn on the middleware future flag in react-router.config, so the wired middleware actually runs.
 *
 * Edits the default-exported config object: adds `<flag>: true` to an existing `future` block, or adds a
 * `future` block when there is none. Reports `manual` when the config is shaped in a way it will not edit
 * blind (a factory function, a spread, no config file), so the caller can print the one line to add rather
 * than risk rewriting a config it does not understand.
 */
export function ensureMiddlewareFlagEnabled(cwd: string, flag: string): FlagOutcome {
  const rel = reactRouterConfigFile(cwd);
  if (rel === null) return 'no-config';
  const ts = sourceCompiler(cwd);
  if (!ts) return 'manual';
  const source = read(join(cwd, rel));
  const tree = parsedSource(ts, rel, source);
  if (!tree) return 'manual';
  const obj = defaultExportObject(ts, tree);
  if (!obj) return 'manual';

  const future = property(ts, obj, 'future');
  let next: string;
  if (future === undefined) {
    const at = obj.getStart(tree) + 1; // just inside the config object's `{`
    next = `${source.slice(0, at)}\n  future: { ${flag}: true },${source.slice(at)}`;
  } else if (ts.isObjectLiteralExpression(future.initializer)) {
    if (property(ts, future.initializer, flag) !== undefined) return 'already';
    const at = future.initializer.getStart(tree) + 1; // just inside the `future` object's `{`
    next = `${source.slice(0, at)} ${flag}: true,${source.slice(at)}`;
  } else {
    return 'manual'; // `future` is something other than an object literal — leave it to the author
  }

  if (!parsedSource(ts, rel, next)) return 'manual';
  writeProjectFileSync(cwd, join(cwd, rel), next);

  return 'enabled';
}
