import { afterEach, expect, it, vi } from 'vitest';
import { resolveRules } from '../../src/protect/rules/source.js';
import { clearPulseToken } from '../../src/pulse-token.js';

afterEach(() => { vi.unstubAllGlobals(); clearPulseToken(); });

it('revalidates readiness on a 304 instead of persisting a previous ready answer', async () => {
  const build = 'a'.repeat(64);
  let cached: any = null;
  const store: any = { read: async () => cached, write: async (value: unknown) => { cached = value; } };
  let state: string | null = 'pending';
  let first = true;
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.endsWith('/token')) return Response.json({access_token:'synthetic-token',expires_in:3600});
    const headers = new Headers({'ETag':'"synthetic-policy"','X-Patchstack-Build-Match':'match','X-Patchstack-Build-ID':build});
    if (state !== null) headers.set('X-Patchstack-Map-Rules', state);
    if (!first) return new Response(null, {status:304,headers});
    first = false;
    return Response.json({firewall:[]}, {headers});
  });
  const resolve = () => resolveRules({siteUuid:'synthetic-site',buildId:build,pulseRulesUrl:'https://api.example.test/monitor/pulse'},store,{pulseAuth:'synthetic-test-key'});
  expect((await resolve()).synchronization?.mapRules).toBe('pending');
  state = 'ready';
  expect((await resolve()).synchronization?.mapRules).toBe('ready');
  state = null;
  expect((await resolve()).synchronization?.mapRules).toBe('unknown');
  expect(cached).not.toHaveProperty('synchronization');
  vi.stubGlobal('fetch', async () => { throw new Error('offline'); });
  const offline = await resolve();
  expect(offline.source.ok).toBe(false);
  expect(offline.synchronization).toBeUndefined();
});
