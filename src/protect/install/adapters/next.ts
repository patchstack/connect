import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { bakeSiteUuid, hasDependency, read, log, templatesDir } from '../util.js';
import type { Adapter, WireOptions, WireResult, VerifyResult } from '../types.js';
import { copyProjectFileSync, ensureProjectDirectorySync, writeProjectFileSync } from '../../../safe-file.js';
import { composeNextMiddleware, composeNextRoute, nextCompiler, nextSourceWired, standardNextRouting, NEXT_MARKER, ROUTE_MARKER } from './next-source.js';
import { installTemplate } from '../template-upgrade.js';

function middlewareInfo(cwd: string) {
  const candidates = ['middleware.ts', 'middleware.js', 'src/middleware.ts', 'src/middleware.js'];
  const relFile = candidates.find(rel => existsSync(join(cwd, rel)))
    ?? (existsSync(join(cwd, 'src')) ? 'src/middleware.ts' : 'middleware.ts');
  return { relFile, relDir: dirname(relFile), exists: existsSync(join(cwd, relFile)) };
}

function proxyFiles(cwd: string): string[] {
  return ['proxy.ts', 'proxy.js', 'src/proxy.ts', 'src/proxy.js'].filter(file => existsSync(join(cwd, file)));
}

function paths(cwd: string) {
  const mw = middlewareInfo(cwd);
  const ext = mw.relFile.endsWith('.js') ? 'js' : 'ts';
  return { ...mw, rules: join(mw.relDir, 'patchstack.rules.json'), guard: join(mw.relDir, `patchstack.next.${ext}`) };
}

function importFrom(file: string, guard: string): string {
  const rel = relative(dirname(file), guard).replace(/\\/g, '/').replace(/\.ts$/, '');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function routes(cwd: string): { files: string[]; incomplete: boolean } {
  const files: string[] = [];
  let incomplete = false;
  let visited = 0;
  const walk = (rel: string) => {
    if (++visited > 5000) { incomplete = true; return; }
    const full = join(cwd, rel);
    if (lstatSync(full).isSymbolicLink()) { incomplete = true; return; }
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (entry.name.startsWith('_') || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (entry.isSymbolicLink()) { incomplete = true; continue; }
      const child = join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && /^route\.(?:tsx?|jsx?)$/.test(entry.name)) files.push(child);
    }
  };
  for (const root of ['app', 'src/app']) {
    if (!existsSync(join(cwd, root))) continue;
    if (root.startsWith('src/') && lstatSync(join(cwd, 'src')).isSymbolicLink()) { incomplete = true; continue; }
    try { walk(root); } catch { incomplete = true; }
  }
  return { files: files.sort(), incomplete };
}

// URL-normalization overrides and custom routing need framework-specific review before widening.
function customRouting(cwd: string, ts: NonNullable<ReturnType<typeof nextCompiler>>): boolean {
  return ['js', 'mjs', 'ts', 'cjs'].some(ext => {
    const file = join(cwd, `next.config.${ext}`);
    return existsSync(file) && !standardNextRouting(ts, file, read(file));
  });
}

function sharedGuardPresent(file: string): boolean {
  if (!existsSync(file)) return false;
  const source = read(file);
  return source.includes('export async function getPatchstackProtection')
    && source.includes('export async function screenPatchstackResponse')
    && source.includes('import { createProtection } from "@patchstack/connect/protect"');
}

function wire(cwd: string, opts: WireOptions): WireResult {
  const proxies = proxyFiles(cwd);
  if (proxies.length) {
    log(`left ${proxies.join(', ')} untouched: Next.js proxy integration requires manual wiring. Do not add middleware alongside a proxy; protect --check reports this gap.`);
    return { ok: false, changed: [] };
  }
  const templates = templatesDir();
  const mw = paths(cwd);
  ensureProjectDirectorySync(cwd, join(cwd, mw.relDir));
  const changed: string[] = [];
  if (opts.demo || !existsSync(join(cwd, mw.rules))) {
    copyProjectFileSync(cwd, join(templates, opts.demo ? 'demo-rules.json' : 'rules.json'), join(cwd, mw.rules));
    changed.push(mw.rules);
  }
  const ts = nextCompiler(cwd);
  const guardPath = join(cwd, mw.guard);
  const guardConflict = existsSync(guardPath) && !sharedGuardPresent(guardPath);
  const ensureGuard = () => {
    if (existsSync(guardPath)) {
      if (mw.guard.endsWith('.ts') && installTemplate(cwd, mw.guard, 'next-guard.ts')) changed.push(mw.guard);
      return;
    }
    const source = read(join(templates, 'next-guard.ts'));
    writeProjectFileSync(cwd, guardPath, mw.guard.endsWith('.js')
      ? ts!.transpileModule(source, { compilerOptions: { target: ts!.ScriptTarget.ES2022, module: ts!.ModuleKind.ESNext } }).outputText
      : source);
    if (!opts.demo) bakeSiteUuid(cwd, mw.guard);
    changed.push(mw.guard);
  };

  const existing = mw.exists ? read(join(cwd, mw.relFile)) : '';
  if (!mw.exists) {
    copyProjectFileSync(cwd, join(templates, 'next-middleware.ts'), join(cwd, mw.relFile));
    if (!opts.demo) bakeSiteUuid(cwd, mw.relFile);
    changed.push(mw.relFile);
    log(`scaffolded ${mw.relFile} (request-phase guard)`);
  } else if (existing.includes(NEXT_MARKER) || existing.includes('#region patchstack-next (')) {
    if (existing.includes('#region patchstack-next (') && installTemplate(cwd, mw.relFile, 'next-middleware.ts')) changed.push(mw.relFile);
    log(`${mw.relFile} already has a Patchstack guard — left as-is`);
    if (ts && existing.includes(NEXT_MARKER)) ensureGuard();
  } else {
    const composed = ts && !guardConflict && !customRouting(cwd, ts) && composeNextMiddleware(ts, mw.relFile, existing, importFrom(mw.relFile, mw.guard));
    if (composed) {
      ensureGuard();
      writeProjectFileSync(cwd, join(cwd, mw.relFile), composed);
      changed.push(mw.relFile);
      log(`composed ${mw.relFile}: request guard first; existing middleware keeps its original matcher scope`);
    } else {
      log(`left ${mw.relFile} untouched: middleware/export/matcher shape needs manual integration${ts ? '' : ' (install typescript to enable source-aware composition)'}. Add a guard before application middleware and preserve its routing scope; protect --check reports this gap.`);
    }
  }

  const inventory = routes(cwd);
  for (const file of inventory.files) {
    const source = read(join(cwd, file));
    if (source.includes(ROUTE_MARKER)) {
      if (ts) ensureGuard();
      continue;
    }
    const composed = ts && !guardConflict && /\.(?:ts|js)$/.test(file)
      && composeNextRoute(ts, file, source, importFrom(file, mw.guard));
    if (composed) {
      ensureGuard();
      writeProjectFileSync(cwd, join(cwd, file), composed);
      changed.push(file);
      log(`wired ${file} (request checks + response filtering)`);
    } else {
      log(`left ${file} untouched: wrap its request and final Response manually; protect --check reports this response-filtering gap.`);
    }
  }
  if (guardConflict) log(`${mw.guard} already exists but is not a recognized helper — left untouched; resolve the filename conflict before integrating handlers.`);
  if (inventory.incomplete) log('App Router inventory was incomplete — review skipped paths manually.');
  log('Next middleware cannot inspect downstream response bodies. Route-handler filtering does not cover rendered pages, Server Actions, or Pages API routes. Keep Next.js patched: a middleware bypass also bypasses a middleware guard.');
  return { ok: true, changed: [...new Set(changed)] };
}

function verify(cwd: string): VerifyResult {
  const proxies = proxyFiles(cwd);
  if (proxies.length) return {
    wired: false,
    checks: [{ label: 'Next.js proxy wiring requires manual verification', ok: false,
      hint: `review ${proxies.join(', ')}; automatic proxy integration is not supported. Next.js cannot use middleware and proxy together.` }],
  };
  const mw = paths(cwd);
  const ts = nextCompiler(cwd);
  const source = mw.exists ? read(join(cwd, mw.relFile)) : '';
  const shared = sharedGuardPresent(join(cwd, mw.guard));
  const legacy = source.includes('#region patchstack-next (')
    && source.includes('await protection.fetchGuard()(request)') && source.includes('if (blocked) return blocked')
    && source.includes('matcher: "/:path*"');
  const composed = ts && shared && !customRouting(cwd, ts) && nextSourceWired(ts, mw.relFile, source, importFrom(mw.relFile, mw.guard));
  const present = !!(legacy || composed);
  const rulesPresent = existsSync(join(cwd, mw.rules));
  const inventory = routes(cwd);
  const missing = inventory.files.filter(file => !(ts && shared
    && nextSourceWired(ts, file, read(join(cwd, file)), importFrom(file, mw.guard), true)));
  return {
    wired: present && rulesPresent && missing.length === 0 && !inventory.incomplete,
    checks: [
      { label: 'Next middleware request guard has a catch-all matcher', ok: present,
        hint: `run \`patchstack-connect protect\`; review any unsupported middleware shape in ${mw.relFile}` },
      { label: 'fallback rules co-located with the guard', ok: rulesPresent, hint: 'run `patchstack-connect protect`' },
      { label: `App Router request/response wiring: ${inventory.files.length - missing.length}/${inventory.files.length} route files`,
        ok: missing.length === 0 && !inventory.incomplete,
        hint: `run protect again after adding routes; manually integrate unsupported handlers: ${missing.join(', ') || 'inventory incomplete'}` },
      { label: 'rendered pages, Server Actions and Pages API response filtering are not verified', ok: true, unverifiable: true,
        hint: 'middleware cannot screen the downstream response; use a supported server boundary or add response filtering to those handlers' },
      { label: 'live rule delivery and enforcement are not established by source inspection', ok: true, unverifiable: true,
        hint: 'inspect the running guard’s ruleSource and mode; a request reaching middleware does not prove rules were fetched, accepted, or enforced. Framework middleware bypasses require a patched Next.js or upstream protection.' },
    ],
  };
}

export const nextAdapter: Adapter = {
  name: 'nextjs', label: 'Next.js', detect: cwd => hasDependency(cwd, 'next'), wire, verify,
};
