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
import { nestjsAdapter } from './adapters/nestjs.js';
import { fastifyAdapter } from './adapters/fastify.js';
import { expressAdapter } from './adapters/express.js';
import { scaffoldGeneric, wiringPlan, genericVerify } from './generic.js';
import type { Adapter, WireOptions, ProtectResult, VerifyReport } from './types.js';

// Registry — order = match priority (most specific first): framework meta-frameworks before the
// bare server libraries (a SvelteKit/Astro app may also carry express/fastify as a transitive dep).
const ADAPTERS: Adapter[] = [
  tanstackSupabaseAdapter,
  nextAdapter,
  sveltekitAdapter,
  astroAdapter,
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

/** Verify the guard is correctly wired (backs `protect --check`). Fail-open — never throws. */
export function runVerify(cwd: string): VerifyReport {
  try {
    const adapter = ADAPTERS.find((a) => a.detect(cwd));
    if (adapter) return { stack: adapter.label, ...adapter.verify(cwd) };
    return { stack: 'generic', ...genericVerify(cwd) };
  } catch (err) {
    return { stack: 'unknown', wired: false, checks: [{ label: 'verification failed', ok: false, hint: String((err as Error)?.message ?? err) }] };
  }
}

export type { Adapter, WireOptions, WireResult, VerifyResult, VerifyReport, ProtectResult } from './types.js';
