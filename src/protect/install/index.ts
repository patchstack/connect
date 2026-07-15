// `patchstack-connect protect` — scaffold the always-on runtime guard into an app.
//
// Stack-specific wiring lives in one adapter per builder/framework shape (see ./adapters/). This
// orchestrator picks the first adapter that matches the app and delegates. If none matches it
// ESCALATES (never silently skips) — the guard engine itself is stack-agnostic, so an unmatched
// app is a gap in auto-wiring coverage to be closed by a new adapter or an agent-assisted install,
// not a reason to leave the app unprotected quietly.

import { log } from './util.js';
import { tanstackSupabaseAdapter } from './adapters/tanstack-supabase.js';
import type { Adapter, WireOptions, ProtectResult } from './types.js';

// Registry — order = match priority. Add new stacks here.
const ADAPTERS: Adapter[] = [tanstackSupabaseAdapter];

/** Scaffold + wire the runtime guard into the app at `cwd`. Best-effort — never throws. */
export function runProtect(cwd: string, opts: WireOptions = {}): ProtectResult {
  const adapter = ADAPTERS.find((a) => a.detect(cwd));

  if (!adapter) {
    log(
      `no built-in adapter matched this app's stack. Auto-wire currently supports: ` +
        `${ADAPTERS.map((a) => a.label).join(', ')}. The guard engine is stack-agnostic; ` +
        `wiring for this stack needs a new adapter or an agent-assisted install (see AGENT-INSTALL.md) — not skipped silently.`,
    );
    return { status: 'unsupported', supported: ADAPTERS.map((a) => a.name) };
  }

  const result = adapter.wire(cwd, opts);
  return { status: 'wired', adapter: adapter.name, changed: result.changed };
}

export type { Adapter, WireOptions, WireResult, ProtectResult } from './types.js';
