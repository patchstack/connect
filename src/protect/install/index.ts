// `patchstack-connect protect` — scaffold the always-on runtime guard into an app.
//
// Stack-specific wiring lives in one adapter per builder/framework shape (see ./adapters/). This
// orchestrator picks the first adapter that matches the app and delegates. If none matches it
// ESCALATES (never silently skips) — the guard engine itself is stack-agnostic, so an unmatched
// app is a gap in auto-wiring coverage to be closed by a new adapter or an agent-assisted install,
// not a reason to leave the app unprotected quietly.

import { log } from './util.js';
import { tanstackSupabaseAdapter } from './adapters/tanstack-supabase.js';
import { nextAdapter } from './adapters/next.js';
import { sveltekitAdapter } from './adapters/sveltekit.js';
import { astroAdapter } from './adapters/astro.js';
import { nuxtAdapter } from './adapters/nuxt.js';
import { nestjsAdapter } from './adapters/nestjs.js';
import { fastifyAdapter } from './adapters/fastify.js';
import { expressAdapter } from './adapters/express.js';
import { scaffoldGeneric, wiringPlan, genericVerify } from './generic.js';
import { reportingChecks } from './reporting.js';
import { hasResolvableCredential } from './util.js';
import type { Adapter, VerifyCheck, WireOptions, ProtectResult, VerifyReport } from './types.js';

// Registry — order = match priority (most specific first): framework meta-frameworks before the
// bare server libraries (a SvelteKit/Astro app may also carry express/fastify as a transitive dep).
const ADAPTERS: Adapter[] = [
  tanstackSupabaseAdapter,
  nextAdapter,
  sveltekitAdapter,
  astroAdapter,
  nuxtAdapter,
  nestjsAdapter,
  fastifyAdapter,
  expressAdapter,
];

/** Scaffold + wire the runtime guard into the app at `cwd`. Best-effort — never throws. */
export function runProtect(cwd: string, opts: WireOptions = {}): ProtectResult {
  let adapter;
  try {
    adapter = ADAPTERS.find((a) => a.detect(cwd));
    if (adapter) {
      const result = adapter.wire(cwd, opts);
      return { status: 'wired', adapter: adapter.name, changed: result.changed };
    }
  } catch (err) {
    // A wire/detect failure (read-only FS, EACCES, a bad source file) must not crash the CLI —
    // fall through to the generic scaffold + plan so the user still gets something actionable.
    log(`adapter ${adapter?.name ?? ''} failed (${(err as Error)?.message ?? err}); falling back to a generic guard`);
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
const RUNTIMES_WITHOUT_CONFIG_FILE = new Set(['next', 'sveltekit', 'astro', 'nuxt', 'generic']);

/**
 * A note about the deployment credential, when the stack needs one and this machine cannot confirm it.
 *
 * Not a pass and not a failure. The CLI cannot see a hosting platform's environment variables, so calling
 * it either would be inventing an answer — and the previous report simply omitted the question, which is
 * how an app could be told it was fully wired while nothing would ever update its rules.
 */
function credentialNote(cwd: string, adapterName: string): VerifyCheck[] {
  if (!RUNTIMES_WITHOUT_CONFIG_FILE.has(adapterName)) return [];

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
 * Verify the guard is correctly wired (backs `protect --check`). Fail-open — never throws.
 *
 * Wiring decides the exit status; the reporting checks are informational and never do. A deployment that
 * has deliberately switched reporting off is correctly configured, and a check that failed the command
 * over it would teach people to ignore the command.
 */
export function runVerify(cwd: string): VerifyReport {
  try {
    const adapter = ADAPTERS.find((a) => a.detect(cwd));
    if (adapter) {
      const result = adapter.verify(cwd);
      return {
        stack: adapter.label,
        ...result,
        checks: [...result.checks, ...credentialNote(cwd, adapter.name), ...reportingChecks(cwd)],
      };
    }
    const generic = genericVerify(cwd);
    return {
      stack: 'generic',
      ...generic,
      checks: [...generic.checks, ...credentialNote(cwd, 'generic'), ...reportingChecks(cwd)],
    };
  } catch (err) {
    return { stack: 'unknown', wired: false, checks: [{ label: 'verification failed', ok: false, hint: String((err as Error)?.message ?? err) }] };
  }
}

export type { Adapter, WireOptions, WireResult, VerifyResult, VerifyReport, ProtectResult } from './types.js';
