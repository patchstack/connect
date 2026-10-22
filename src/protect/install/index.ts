// `patchstack-connect protect` — scaffold the always-on runtime guard into an app.
//
// Stack-specific wiring lives in one adapter per builder/framework shape (see ./adapters/). This
// orchestrator picks the first adapter that matches the app and delegates. If none matches it
// ESCALATES (never silently skips) — the guard engine itself is stack-agnostic, so an unmatched
// app is a gap in auto-wiring coverage to be closed by a new adapter or an agent-assisted install,
// not a reason to leave the app unprotected quietly.

import { relative } from 'node:path';
import { classifyArchitecture } from '../../architecture.js';
import { findSiteUuidUp, log, unbakedGuards } from './util.js';
import { workspacePackageDirs } from './workspaces.js';
import { tanstackSupabaseAdapter } from './adapters/tanstack-supabase.js';
import { tanstackAdapter } from './adapters/tanstack.js';
import { nextAdapter } from './adapters/next.js';
import { sveltekitAdapter } from './adapters/sveltekit.js';
import { astroAdapter } from './adapters/astro.js';
import { reactRouterAdapter } from './adapters/react-router.js';
import { nuxtAdapter } from './adapters/nuxt.js';
import { nestjsAdapter } from './adapters/nestjs.js';
import { fastifyAdapter } from './adapters/fastify.js';
import { expressAdapter } from './adapters/express.js';
import { scaffoldGeneric, wiringPlan, genericVerify, genericScaffoldFiles } from './generic.js';
import { reportingChecks } from './reporting.js';
import { hasResolvableCredential, read } from './util.js';
import { findRulesFile } from '../../build-stamp.js';
import type { Adapter, VerifyCheck, WireOptions, ProtectResult, VerifyReport } from './types.js';

// Registry — order = match priority (most specific first): framework meta-frameworks before the
// bare server libraries (a SvelteKit/Astro app may also carry express/fastify as a transitive dep).
const ADAPTERS: Adapter[] = [
  tanstackSupabaseAdapter,
  tanstackAdapter,
  nextAdapter,
  sveltekitAdapter,
  astroAdapter,
  reactRouterAdapter,
  nuxtAdapter,
  nestjsAdapter,
  fastifyAdapter,
  expressAdapter,
];

/**
 * Wire the first adapter that recognises the app at `cwd`. Returns the wired result, a
 * scaffolded-but-not-fully-wired result when an adapter matched but could not finish, or null when no
 * adapter recognised the app at all.
 *
 * Every adapter that recognises the app is tried, most specific first. One that cannot wire this app and
 * changed nothing makes way for the next: a TanStack Start app whose Supabase layout is not the one the
 * specific adapter is written for is still a TanStack Start app with a server entry.
 */
function tryAdapters(cwd: string, opts: WireOptions): ProtectResult | null {
  const matching = ADAPTERS.filter((a) => a.detect(cwd));
  let first: ProtectResult | null = null;
  for (const candidate of matching) {
    const result = candidate.wire(cwd, opts);
    const verification = candidate.verify(cwd);
    if (result.ok && verification.wired) return { status: 'wired', adapter: candidate.name, changed: result.changed };
    const plan = verification.checks.filter(check => !check.ok && !check.optional).map(check => check.hint ?? check.label).join('\n');
    first ??= { status: 'scaffolded', adapter: candidate.name, changed: result.changed, plan };
    if (result.changed.length > 0) break;
  }

  return first;
}

/**
 * Wire the guard into each workspace package that holds a framework app.
 *
 * A builder's monorepo runs setup at the root — where the prompt and the lockfile are — but the app it
 * serves lives in a package (`apps/web`). The root is not an app, so no adapter matches it, and a generic
 * scaffold left there would never be loaded by the real server. The changed paths are reported relative to
 * the root the command ran in, so the user reads `apps/web/app/root.tsx`, the path they recognise.
 */
function wireWorkspaces(cwd: string, opts: WireOptions): ProtectResult | null {
  const apps = workspacePackageDirs(cwd).filter((dir) => ADAPTERS.some((a) => a.detect(dir)));
  const wired: Array<{ rel: string; result: ProtectResult }> = [];
  for (const dir of apps) {
    const result = tryAdapters(dir, opts);
    if (result !== null) wired.push({ rel: relative(cwd, dir).replace(/\\/g, '/'), result });
  }
  if (wired.length === 0) return null;

  const changed = wired.flatMap(({ rel, result }) =>
    ('changed' in result ? result.changed : []).map((file) => `${rel}/${file}`));
  const adapter = wired.map(({ rel, result }) => `${'adapter' in result ? result.adapter : 'generic'} (${rel})`).join(', ');

  if (wired.every(({ result }) => result.status === 'wired')) {
    log(`wired the guard in the workspace app${wired.length > 1 ? 's' : ''}: ${wired.map((w) => w.rel).join(', ')}`);
    return { status: 'wired', adapter, changed };
  }
  const plan = wired.map(({ result }) => (result.status === 'scaffolded' ? result.plan : '')).filter(Boolean).join('\n');

  return { status: 'scaffolded', adapter, changed, plan };
}

/** Scaffold + wire the runtime guard into the app at `cwd`. Best-effort — never throws. */
export function runProtect(cwd: string, opts: WireOptions = {}): ProtectResult {
  try {
    // Asked before any adapter, because an adapter recognises a framework, not a request path. SvelteKit
    // with `adapter-static` is still SvelteKit to its adapter, which would write a server hook that a
    // static build only ever runs at prerender time — a guard on nothing. A `none` verdict is decisive;
    // the adapters only get to wire an app that could receive a request.
    const architecture = classifyArchitecture(cwd);
    if (architecture.requestPath === 'none') {
      log(architecture.note);
      return {
        status: 'not-applicable',
        reason: architecture.note,
        evidence: architecture.evidence,
        leftovers: genericScaffoldFiles(cwd),
      };
    }

    const atCwd = tryAdapters(cwd, opts);
    if (atCwd?.status === 'wired') return atCwd;

    // No adapter recognised an app at the root the command ran in. Before scaffolding a generic guard
    // there — which the app would never load in a monorepo — look for the app in a workspace package.
    if (atCwd === null) {
      const workspace = wireWorkspaces(cwd, opts);
      if (workspace !== null) return workspace;
    }

    // An adapter matched the root but could not finish wiring it: report that, not a generic scaffold.
    if (atCwd !== null) return atCwd;
  } catch (err) {
    // A wire/detect failure (read-only FS, EACCES, a bad source file) must not crash the CLI —
    // fall through to the generic scaffold + plan so the user still gets something actionable.
    log(`protect failed (${(err as Error)?.message ?? err}); falling back to a generic guard`);
  }

  // No adapter matched (or it failed) — DON'T silently skip. Scaffold the framework-agnostic guard
  // and print a wiring plan the builder's agent (or user) can finish, then verify with `--check`.
  try {
    const { changed, dir } = scaffoldGeneric(cwd, opts);
    const plan = wiringPlan(cwd, dir);
    log(plan);
    return { status: 'scaffolded', adapter: 'generic', changed, plan };
  } catch (err) {
    log(`could not scaffold the guard (${(err as Error)?.message ?? err})`);
    return { status: 'scaffolded', adapter: 'generic', changed: [], plan: '' };
  }
}

/**
 * Stacks whose guard runs where there is no filesystem to read config from.
 *
 * Setup bakes the site UUID into the scaffolded guard, which is enough to identify the site — but the
 * credential that authenticates live rule delivery is in a file these runtimes cannot open, so it has to be
 * an environment variable in the deployment. Without it the guard runs on the rules it shipped with: it
 * screens every request, reports healthy, and never receives another rule.
 */
const RUNTIMES_WITHOUT_CONFIG_FILE = new Set(['tanstack-start', 'nextjs', 'sveltekit', 'astro', 'nuxt', 'react-router', 'generic']);

/** Whether the guard's rules file carries the site's read-only rules credential. */
function bundledRulesReader(cwd: string): boolean {
  try {
    const found = findRulesFile(cwd);
    if (found.kind !== 'one') return false;
    const reader = (JSON.parse(read(found.path)) as { _patchstack?: { rules_reader?: unknown } })._patchstack?.rules_reader;

    return typeof reader === 'string' && /^rr_[0-9a-f]{48}-\d+$/.test(reader);
  } catch {
    return false;
  }
}

/**
 * A note about the deployment credential, when the stack needs one and this machine cannot confirm it.
 *
 * Not a pass and not a failure. The CLI cannot see a hosting platform's environment variables, so calling
 * it either would be inventing an answer — and the previous report simply omitted the question, which is
 * how an app could be told it was fully wired while nothing would ever update its rules.
 */
function credentialNote(cwd: string, adapterName: string): VerifyCheck[] {
  if (!RUNTIMES_WITHOUT_CONFIG_FILE.has(adapterName)) return [];

  if (bundledRulesReader(cwd)) {
    return [
      {
        label: 'live rule updates use the read-only rules credential in the guard rules file',
        ok: true,
        unverifiable: true,
        hint: 'a deployment without PATCHSTACK_API_KEY still fetches live rules with it; set the key there too for detections to be reported',
      },
    ];
  }

  // A credential in the local environment says the developer has one; it says nothing about production,
  // which is where it matters. Either way the answer is the same note.
  const localHint = hasResolvableCredential(cwd)
    ? 'a credential is configured here; set the same one in your deployment'
    : 'no credential found here either — run `npx @patchstack/connect scan` to provision one';

  return [
    {
      label: 'live rule updates need PATCHSTACK_API_KEY in the deployment environment',
      ok: true,
      unverifiable: true,
      hint: `this runtime cannot read .patchstackrc.local.json — ${localHint}. Without it the guard keeps running on the rules it shipped with.`,
    },
  ];
}

/**
 * Whether the guard carries the site this project records, or null when the project records none.
 *
 * A guard still holding the placeholder runs without a site: it blocks with the rules it shipped with,
 * but fetches no rule changes and reports nothing. Setup fills the site in, so this fails only when that
 * did not happen, and names the fix.
 */
function guardSiteCheck(cwd: string): VerifyCheck | null {
  if (findSiteUuidUp(cwd).found !== 'uuid') return null;
  const unbaked = unbakedGuards(cwd);

  return {
    label: 'the guard carries this project\'s Patchstack site',
    ok: unbaked.length === 0,
    hint: `${unbaked.join(', ')} has no site, so it fetches no rule updates and reports nothing — run \`npx @patchstack/connect protect\` from the project root`,
  };
}

/**
 * Verify the guard at `cwd`, or null when no adapter recognises an app there.
 *
 * The adapter that wired this app, when one did; otherwise the most specific one that recognises it, so a
 * half-finished wiring still reports against the right framework.
 */
function verifyAt(cwd: string): VerifyReport | null {
  const matching = ADAPTERS.filter((a) => a.detect(cwd));
  const adapter = matching.find((a) => a.verify(cwd).wired) ?? matching[0];
  if (!adapter) return null;

  const result = adapter.verify(cwd);
  const siteCheck = guardSiteCheck(cwd);

  return {
    stack: adapter.label,
    applicable: true,
    ...result,
    wired: result.wired && (siteCheck === null || siteCheck.ok),
    checks: [...result.checks, ...(siteCheck === null ? [] : [siteCheck]), ...credentialNote(cwd, adapter.name), ...reportingChecks(cwd)],
  };
}

/**
 * Verify the guard is correctly wired (backs `protect --check`). Fail-open — never throws.
 *
 * Wiring decides the exit status; the reporting checks are informational and never do. A deployment that
 * has deliberately switched reporting off is correctly configured, and a check that failed the command
 * over it would teach people to ignore the command.
 */
export function runVerify(cwd: string): VerifyReport {
  try {
    // Same order as `runProtect`: the static verdict is decisive, and reporting is still checked — a
    // static site posts manifests like any other.
    const architecture = classifyArchitecture(cwd);
    if (architecture.requestPath === 'none') {
      return {
        stack: 'static build',
        applicable: false,
        wired: false,
        checks: [
          {
            label: 'runtime protection does not apply to this project',
            ok: true,
            hint: architecture.note,
          },
          ...reportingChecks(cwd),
        ],
      };
    }

    const atCwd = verifyAt(cwd);
    if (atCwd !== null) return atCwd;

    // No adapter recognised an app at the root: in a workspace repo the app is in a package. Report the
    // one that is wired; failing that, the first that has an app, so `--check` describes the real app
    // rather than a generic verdict about the root the command happened to run in.
    let fallback: VerifyReport | null = null;
    for (const dir of workspacePackageDirs(cwd)) {
      const report = verifyAt(dir);
      if (report === null) continue;
      if (report.wired) return report;
      fallback ??= report;
    }
    if (fallback !== null) return fallback;

    const generic = genericVerify(cwd);
    return {
      stack: 'generic',
      applicable: true,
      ...generic,
      checks: [...generic.checks, ...credentialNote(cwd, 'generic'), ...reportingChecks(cwd)],
    };
  } catch (err) {
    return { stack: 'unknown', applicable: true, wired: false, checks: [{ label: 'verification failed', ok: false, hint: String((err as Error)?.message ?? err) }] };
  }
}

export type { Adapter, WireOptions, WireResult, VerifyResult, VerifyReport, ProtectResult } from './types.js';
