import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { resolveConfig } from './config.js';
import { syncSetupProtection } from './setup-sync.js';
import { reportManifest } from './protect/refresh-manifest.js';
import { isComponentFile } from './map/sources.js';

const ignored = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor']);

/** Metadata only. Never read environment values or follow directory symlinks. */
export function sourceSnapshot(cwd: string): string {
  const hash = createHash('sha256');
  let entries = 0;
  function visit(directory: string, depth: number): void {
    if (depth > 30) throw new Error('Source tree exceeds the development watcher depth limit.');
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || ignored.has(entry.name) || entry.isSymbolicLink()) continue;
      if (++entries > 20_000) throw new Error('Source tree exceeds the development watcher entry limit.');
      const file = join(directory, entry.name);
      if (entry.isDirectory()) { visit(file, depth + 1); continue; }
      if (!entry.isFile() || (!isComponentFile(entry.name) && !/\.(?:[cm]?[jt]sx?|json|ya?ml|lock|lockb)$/.test(entry.name))) continue;
      if (/^(?:patchstack\.)?rules\.json$/.test(entry.name)) continue;
      const stat = statSync(file);
      hash.update(`${relative(cwd, file).split(sep).join('/')}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.size}\n`);
    }
  }
  visit(cwd, 0);
  return hash.digest('hex');
}

export interface SyncAttempt { current: () => boolean; previousBuildId?: string }
/** buildId acknowledges an accepted map, even when the package report still needs a retry. */
export interface SyncOutcome { ok: boolean; buildId?: string }

/** One in-flight analysis/upload, coalesced source changes, bounded retry cadence, no app restarts. */
export function startDevelopmentSync(cwd: string, options: {
  snapshot?: () => string;
  sync?: (attempt: SyncAttempt) => Promise<SyncOutcome>;
  pollMs?: number;
  debounceMs?: number;
  minIntervalMs?: number;
  log?: (message: string) => void;
} = {}): { stop(): void; tick(): Promise<void> } {
  const snapshot = options.snapshot ?? (() => sourceSnapshot(cwd));
  const log = options.log ?? console.error;
  const sync = options.sync ?? (async (attempt: SyncAttempt): Promise<SyncOutcome> => {
    let manifestOk = true;
    await reportManifest(cwd).catch(() => {
      manifestOk = false;
      log('patchstack: package sync unavailable; continuing with map sync and retrying packages after the sync interval.');
    });
    const config = await resolveConfig({ cwd });
    const result = await syncSetupProtection(cwd, config, { waitMs: 0,
      mapOptions: { isCurrent: attempt.current, previousBuildId: attempt.previousBuildId },
    });
    const mapOk = result.map.unchangedLocal === true || ['stored', 'unchanged'].includes(result.map.upload?.result ?? '');
    log(`patchstack: packages ${manifestOk ? 'synchronized' : 'pending retry'}; development map ${mapOk ? 'uploaded or unchanged' : 'not synchronized'}; rules ${result.rules.ok ? result.rules.mapRules : 'unavailable'}.`);
    return { ok: manifestOk && mapOk, buildId: mapOk ? result.map.buildId ?? undefined : undefined };
  });
  let stopped = false;
  let running = false;
  let observed: string | undefined;
  let completed: string | undefined;
  let changedAt = 0;
  let nextAttempt = 0;
  let previousBuildId: string | undefined;
  let warned = false;
  const debounce = options.debounceMs ?? 1000;
  // The default map-ingest budget is build-oriented. Coalesce active editing rather than uploading
  // every save; failures use the same minimum interval, so an outage cannot create a retry storm.
  const interval = options.minIntervalMs ?? 180_000;
  async function tick(): Promise<void> {
    if (stopped || running) return;
    if (warned && Date.now() < nextAttempt) return;
    try {
      const current = snapshot();
      const now = Date.now();
      if (current !== observed) { observed = current; changedAt = now; }
      if (current === completed || now - changedAt < debounce || now < nextAttempt) return;
      running = true;
      nextAttempt = now + interval;
      const isCurrent = () => !stopped && snapshot() === current;
      const result = await sync({ current: isCurrent, previousBuildId });
      if (isCurrent()) {
        if (result.ok) completed = current;
        if (result.buildId) previousBuildId = result.buildId;
      }
      warned = false;
    } catch {
      if (!warned) log('patchstack: development synchronization unavailable; the app continues running. Retrying after the sync interval.');
      warned = true;
      nextAttempt = Date.now() + interval;
    } finally { running = false; }
  }
  const timer = setInterval(() => { void tick(); }, options.pollMs ?? 1000);
  timer.unref();
  void tick();
  return { stop: () => { stopped = true; clearInterval(timer); }, tick };
}
