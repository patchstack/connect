import { join } from 'node:path';
import { buildRulesUrl, DEFAULT_ENDPOINT } from './client.js';
import { ensureIgnored } from './config.js';
import { assertConnectableEndpoint, isCanonicalUuid } from './endpoint-policy.js';
import { runMapDetailed, type MapResult, type MapOptions } from './map-command.js';
import { resolveRules } from './protect/rules/source.js';
import { makeStore } from './protect/rules/store.js';
import type { Config } from './types.js';

export interface SetupSyncResult {
  map: MapResult;
  rules: {
    ok: boolean;
    count: number;
    origin: string;
    mapRules: 'ready' | 'pending' | 'unknown';
    error?: string;
  };
  notices: string[];
  warnings: string[];
}

/** The explicit setup workflow: source edits first, mapping second, authenticated rule pull last. */
export async function syncSetupProtection(cwd: string, config: Config, { waitMs = 10_000, mapOptions = {} }: {
  waitMs?: number; mapOptions?: Pick<MapOptions, 'isCurrent' | 'previousBuildId'>;
} = {}): Promise<SetupSyncResult> {
  const notices: string[] = [];
  const warnings: string[] = [];
  let map: MapResult;
  try {
    map = await runMapDetailed(new Map<string, string | true>([['dir', cwd], ['upload', true]]), {
      ...mapOptions, config, setup: true, log: line => notices.push(line),
    });
  } catch {
    map = { code: 1, error: 'Could not analyse or bind the map; check the project files and permissions.' };
  }
  const unavailable = (error: string): SetupSyncResult => ({
    map, rules: { ok: false, count: 0, origin: 'empty', mapRules: 'unknown', error }, notices, warnings,
  });
  if (!isCanonicalUuid(config.siteUuid)) return unavailable('No site UUID is configured.');
  if (!config.pulseAuth) return unavailable('Set PATCHSTACK_API_KEY or run patchstack-connect login to fetch live rules.');

  try {
    const rulesUrl = buildRulesUrl(config.endpoint, config.siteUuid);
    assertConnectableEndpoint(config, rulesUrl);
    const base = rulesUrl.slice(0, rulesUrl.lastIndexOf('/rules/'));
    const defaultRules = buildRulesUrl(DEFAULT_ENDPOINT, config.siteUuid);
    if (rulesUrl !== defaultRules && process.env.PATCHSTACK_PULSE_RULES_URL !== base) {
      warnings.push('A custom rules service was used for setup. Set PATCHSTACK_PULSE_RULES_URL to the same Pulse base in the server environment for runtime updates.');
    }
    const options = {
      siteUuid: config.siteUuid,
      // Match the ordinary guard's default cache identity; explicit endpoints remain isolated.
      pulseRulesUrl: base,
      cacheDir: join(cwd, '.patchstack'),
      buildId: map.buildId ?? undefined,
      onError: () => notices.push('Some rules could not be refreshed or are detect-only; verify delivery after starting the app.'),
    };
    const ignored = await ensureIgnored(cwd, '.patchstack/', 'Patchstack local runtime cache');
    if (!ignored.ignored) warnings.push('The local rule cache is not git-ignored. Keep .patchstack/ out of version control.');
    // Use the runtime's validator, source-scoped cache and build-verdict handling without creating a
    // running guard: setup must not install global hooks, start refresh timers, or execute the app.
    const store = makeStore({ ...options, pulseRulesUrl: rulesUrl === defaultRules ? undefined : base });
    let bundle = await resolveRules(options, store, {
      pulseAuth: config.pulseAuth, timeoutMs: Math.min(config.timeoutMs, 10_000),
    });
    // A successful empty lookup can mean generation is still pending. Wait only for an explicit
    // pending response; old services remain usable without being described as synchronized.
    const deadline = Date.now() + Math.max(0, Math.min(waitMs, 30_000));
    while (bundle.source.ok && bundle.synchronization?.mapRules === 'pending' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      bundle = await resolveRules(options, store, {
        pulseAuth: config.pulseAuth, timeoutMs: Math.min(config.timeoutMs, remaining),
      });
    }
    return {
      map, notices, warnings,
      rules: { ok: bundle.source.ok, origin: bundle.source.origin, count: bundle.firewall.length,
        mapRules: bundle.synchronization?.mapRules ?? 'unknown',
        ...(bundle.source.ok ? {} : { error: bundle.source.reason ?? 'Live rules could not be fetched.' }) },
    };
  } catch {
    return unavailable('Live rules could not be fetched. Check the endpoint, authentication and project permissions.');
  }
}
