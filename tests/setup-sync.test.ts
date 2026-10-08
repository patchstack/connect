import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncSetupProtection } from '../src/setup-sync.js';
import { setupProtection } from '../src/setup.js';
import { readBuildStamp } from '../src/build-id.js';
import { findRulesFile } from '../src/build-stamp.js';
import { clearPulseToken } from '../src/pulse-token.js';
import { makeStore } from '../src/protect/rules/store.js';
import type { Config } from '../src/types.js';

const uuid = '550e8400-e29b-41d4-a716-446655440000';
const base = 'https://api.example.test/monitor/pulse';
const bundle = (rules: unknown[] = []) => ({ firewall: rules, whitelists: [], whitelist_keys: {} });
const rule = { id: 'synthetic-request', phase: 'request', action: 'block', rule_v2: [{ parameter: 'post.message', match: { type: 'contains', value: 'synthetic-attack' } }] };
let cwd: string;
let config: Config;
let calls: Array<{ url: string; init: RequestInit }>;
let mapStatus: number;
let ruleStatus: number;
let delivered: unknown;
let confirm: boolean;
let readiness: string | null;

beforeEach(() => {
  clearPulseToken();
  cwd = mkdtempSync(join(tmpdir(), 'ps-setup-sync-'));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ type: 'module', dependencies: { express: '^4.21.2' } }));
  writeFileSync(join(cwd, '.patchstackrc.json'), JSON.stringify({ siteUuid: uuid }));
  writeFileSync(join(cwd, 'server.js'), "import express from 'express';\nconst app = express();\napp.use(express.json());\napp.post('/contact', (req,res) => res.json({message:req.body.message}));\napp.listen(3000);\n");
  expect(setupProtection(cwd).verification.wired).toBe(true);
  config = { siteUuid: uuid, endpoint: `${base}/manifest`, endpointTrusted: true, pulseAuth: 'synthetic-secret-1', apiKey: 'synthetic-secret-1', timeoutMs: 1000, environment: 'local', widget: true } as Config;
  calls = []; mapStatus = 200; ruleStatus = 200; delivered = bundle([rule]); confirm = true;
  readiness = null;
  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
    calls.push({url: String(url), init});
    if (String(url).endsWith('/token')) return Response.json({access_token:'synthetic-token', expires_in:3600});
    if (String(url).includes('/input-map/')) return Response.json({result:'stored', revision:1}, {status:mapStatus});
    if (String(url).includes('/rules/')) {
      const id = new Headers(init.headers).get('X-Patchstack-Build');
      return Response.json(delivered, {status:ruleStatus, headers: {
        ...(id && confirm ? {'X-Patchstack-Build-Match':'match', 'X-Patchstack-Build-ID':id} : {}),
        ...(readiness ? {'X-Patchstack-Map-Rules':readiness} : {}),
      }});
    }
    throw new Error('unexpected network path');
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); clearPulseToken(); rmSync(cwd, {recursive:true, force:true}); });

function cache() { return JSON.parse(readFileSync(join(cwd,'.patchstack/patchstack-rules.json'),'utf8')); }
function uploaded() { return JSON.parse(String(calls.find(c => c.url.includes('/input-map/'))!.init.body)); }

describe('one-command setup synchronization', () => {
  it('distinguishes pending, ready-empty, and an older service without readiness', async () => {
    delivered = bundle();
    readiness = 'pending';
    expect((await syncSetupProtection(cwd, config, {waitMs:0})).rules).toMatchObject({ok:true, count:0, mapRules:'pending'});
    readiness = 'ready';
    expect((await syncSetupProtection(cwd, config)).rules).toMatchObject({ok:true, count:0, mapRules:'ready'});
    readiness = null;
    expect((await syncSetupProtection(cwd, config)).rules.mapRules).toBe('unknown');
  });

  it('does not accept readiness without confirmation of the requested map', async () => {
    readiness = 'ready'; confirm = false;
    expect((await syncSetupProtection(cwd, config)).rules.mapRules).toBe('unknown');
  });

  it('waits for explicitly pending generation without requiring another map upload', async () => {
    readiness = 'pending';
    const respond = globalThis.fetch;
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      const response = await respond(...args);
      if (String(args[0]).includes('/rules/')) readiness = 'ready';
      return response;
    });
    expect((await syncSetupProtection(cwd, config, {waitMs:1500})).rules.mapRules).toBe('ready');
    expect(calls.filter(c => c.url.includes('/input-map/'))).toHaveLength(1);
    expect(calls.filter(c => c.url.includes('/rules/'))).toHaveLength(2);
  });
  it('uploads after scaffolding, then fetches request and response rules using the same identity', async () => {
    delivered = bundle([rule, {...rule, id:'synthetic-output', phase:'response', rule_v2:[{parameter:'response.body', match:{type:'contains',value:'synthetic-output'}}]}]);
    const result = await syncSetupProtection(cwd, config);
    expect(result.map.upload?.result).toBe('stored');
    expect(result.map.endpoints).toBeGreaterThan(0);
    expect(result.rules).toMatchObject({ok:true, count:2, origin:'api'});
    const map = uploaded();
    expect(map.build_id).toMatch(/^[a-f0-9]{64}$/);
    const location = findRulesFile(cwd);
    expect(location.kind).toBe('one');
    expect(readBuildStamp(JSON.parse(readFileSync((location as {path:string}).path,'utf8')))).toBe(map.build_id);
    const pull = calls.find(c => c.url.includes('/rules/'))!;
    expect(new Headers(pull.init.headers).get('Authorization')).toBe('Bearer synthetic-token');
    expect(new Headers(pull.init.headers).get('X-Patchstack-Build')).toBe(map.build_id);
    expect(calls.indexOf(pull)).toBeGreaterThan(calls.findIndex(c => c.url.includes('/input-map/')));
    expect(cache()).toMatchObject({buildId:map.build_id, matchedBuildId:map.build_id, source:`site:${uuid}@${base}`});
    expect(readFileSync(join(cwd,'.gitignore'),'utf8')).toContain('.patchstack/');
    expect(JSON.stringify(map)).not.toContain('synthetic-secret');
    expect(JSON.stringify(cache())).not.toContain('synthetic-secret');
    expect(calls.some(c => /detections|logs|build\//.test(c.url))).toBe(false);
  });

  it('does not treat an absent server build verdict as confirmation', async () => {
    confirm = false;
    const result = await syncSetupProtection(cwd, config);
    expect(result.rules.ok).toBe(true);
    expect(cache().matchedBuildId).toBeNull();
  });

  it('is stable on repeat setup and rebinds changed input names', async () => {
    const first = await syncSetupProtection(cwd, config);
    expect((await syncSetupProtection(cwd, config)).map.buildId).toBe(first.map.buildId);
    const source = readFileSync(join(cwd,'server.js'),'utf8');
    writeFileSync(join(cwd,'server.js'),source.replace('req.body.message','req.body.text'));
    expect((await syncSetupProtection(cwd, config)).map.buildId).not.toBe(first.map.buildId);
  });

  it.each([401,403,422,500])('reports map rejection %s without skipping broad rule retrieval', async status => {
    mapStatus = status; confirm = false;
    const result = await syncSetupProtection(cwd, config);
    expect(result.map.upload?.result).toBe('failed');
    expect(result.rules.ok).toBe(true);
    expect(cache().matchedBuildId).toBeNull();
  });

  it('reports an empty successful policy separately from failed delivery', async () => {
    delivered = bundle();
    expect((await syncSetupProtection(cwd, config)).rules).toMatchObject({ok:true,count:0});
    ruleStatus = 401;
    expect((await syncSetupProtection(cwd, config)).rules).toMatchObject({ok:false,count:0,origin:'cache'});
  });

  it('rejects invalid updates atomically and preserves last-known-good', async () => {
    await syncSetupProtection(cwd, config);
    delivered = bundle([{id:'bad',rule_v2:[{parameter:'post.x',match:{type:'regex',value:'/(/'}}]}]);
    expect((await syncSetupProtection(cwd, config)).rules).toMatchObject({ok:false,origin:'cache',count:1});
    expect(cache().bundle.firewall[0].id).toBe('synthetic-request');
  });

  it('never authenticates rule fetches at an implicit environment endpoint', async () => {
    vi.stubEnv('PATCHSTACK_PULSE_RULES_URL','https://another.example.test/monitor/pulse');
    expect((await syncSetupProtection(cwd, config)).rules.ok).toBe(true);
    expect(calls.every(c => c.url.startsWith(base))).toBe(true);
  });

  it('default-endpoint cache is readable by the ordinary guard', async () => {
    config.endpoint = 'https://api.patchstack.com/monitor/pulse/manifest';
    await syncSetupProtection(cwd, config);
    const stored = await makeStore({siteUuid:uuid,cacheDir:join(cwd,'.patchstack')}).read();
    expect(stored?.source).toBe(`site:${uuid}@`);
  });

  it('refuses untrusted endpoints without any network requests', async () => {
    config.endpointTrusted = false;
    const result = await syncSetupProtection(cwd, config);
    expect(result.rules.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('reports missing credentials and does not attempt a rules pull', async () => {
    config.pulseAuth = null;
    expect((await syncSetupProtection(cwd, config)).rules.error).toContain('PATCHSTACK_API_KEY');
    expect(calls.some(c => c.url.includes('/rules/'))).toBe(false);
  });

  it('preserves a symlinked cache target', async () => {
    mkdirSync(join(cwd,'.patchstack'));
    writeFileSync(join(cwd,'unrelated.json'),'unchanged');
    symlinkSync(join(cwd,'unrelated.json'),join(cwd,'.patchstack/patchstack-rules.json'));
    await syncSetupProtection(cwd,config);
    expect(readFileSync(join(cwd,'unrelated.json'),'utf8')).toBe('unchanged');
  });

  it('uploads client-only import inventory without claiming runtime binding', async () => {
    const location = findRulesFile(cwd) as {path:string};
    rmSync(location.path);
    rmSync(join(cwd,'server.js'));
    const result = await syncSetupProtection(cwd, config);
    expect(result.map).toMatchObject({endpoints:0, buildId:null, upload:{result:'stored'}});
    expect(new Headers(calls.find(c => c.url.includes('/rules/'))!.init.headers).has('X-Patchstack-Build')).toBe(false);
  });
});
