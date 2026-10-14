import { afterEach, expect, it, vi } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';
import { requestRefresh } from '../../src/protect/rules/request-refresh.js';
import { clearPulseToken } from '../../src/pulse-token.js';

const build = 'a'.repeat(64);
const rule = {id:'synthetic',build_scope:build,rule_v2:[{parameter:'get.q',match:{type:'contains',value:'attack'}}]};
const options = {siteUuid:'11111111-1111-4111-8111-111111111111',pulseAuth:'synthetic-credential-1234',pulseRulesUrl:'https://api.example.test/monitor/pulse',buildId:build,cache:false,reportManifest:false,reportDetections:false,mode:'block',onError:()=>{}};
afterEach(() => {vi.useRealTimers();vi.unstubAllGlobals();vi.unstubAllEnvs();clearPulseToken();});

function service() {
  let rules: unknown[] = [];
  let readiness = 'pending';
  let offline = false;
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/token')) return Response.json({access_token:'synthetic-token',expires_in:3600});
    if (offline) return new Response('',{status:503});
    return Response.json({firewall:rules},{headers:{'X-Patchstack-Build-Match':'match','X-Patchstack-Build-ID':build,'X-Patchstack-Map-Rules':readiness}});
  });
  vi.stubGlobal('fetch',fetch);
  return {fetch, publish:()=>{rules=[rule];readiness='ready';},offline:()=>{offline=true;}};
}

it('refreshes before evaluating resumed Fetch requests and shares a concurrent burst', async () => {
  vi.useFakeTimers();
  const api = service();
  const p = await createProtection({...options,requestRefreshMs:1000});
  try {
    expect(p.synchronization.mapRules).toBe('pending');
    const before = api.fetch.mock.calls.length;
    api.publish(); vi.setSystemTime(Date.now()+2000);
    const results = await Promise.all(Array.from({length:20},()=>p.fetchGuard()(new Request('https://app.example.test/?q=attack'))));
    expect(results.every(response=>response?.status===403)).toBe(true);
    expect(api.fetch.mock.calls.length-before).toBe(1);
    expect(p.synchronization).toMatchObject({buildId:build,matched:true,mapRules:'ready',rules:{scoped:1,scopedBlocking:1}});
    api.offline();
    await p.refresh();
    expect(p.synchronization).toMatchObject({buildId:build,matched:false,mapRules:'unknown',source:{ok:false,origin:'cache'}});
    await p.stopRefresh();
    const stopped = api.fetch.mock.calls.length;
    vi.setSystemTime(Date.now()+100000);
    await p.fetchGuard()(new Request('https://app.example.test/'));
    expect(api.fetch.mock.calls.length).toBe(stopped);
    await p.refresh();
    expect(api.fetch.mock.calls.length).toBe(stopped+1);
  } finally { await p.stop(); }
});

it.each(['express','node'] as const)('refreshes a resumed %s request before screening', async adapter => {
  vi.useFakeTimers(); const api=service();
  const p = await createProtection({...options,requestRefreshMs:1000});
  try {
    api.publish(); vi.setSystemTime(Date.now()+2000);
    const req = {method:'GET',url:'/?q=attack',originalUrl:'/?q=attack',headers:{},query:{q:'attack'},body:{},socket:{remoteAddress:'127.0.0.1'}};
    const response: any = {statusCode:200,setHeader:vi.fn()};
    const end = new Promise<void>(resolve=> {response.end=()=>resolve();response.json=()=>resolve();response.send=()=>resolve();});
    response.status=(code:number)=>{response.statusCode=code;return response;};response.type=()=>response;
    const next=vi.fn(); p[adapter]()(req,response,next);
    await end;
    expect(response.statusCode).toBe(403);expect(next).not.toHaveBeenCalled();
  } finally {await p.stop();}
});

it('bounds a hung request refresh, backs off and stops without holding subsequent app requests', async () => {
  vi.useFakeTimers();
  const tick = vi.fn(()=>new Promise(()=>{}));
  const scheduler = requestRefresh(tick,{intervalMs:1000,timeoutMs:100});
  expect(scheduler.check()).toBeNull();
  vi.setSystemTime(Date.now()+1000);
  const first=scheduler.check(); expect(scheduler.check()).toBe(first);
  await vi.advanceTimersByTimeAsync(101);await first;
  expect(scheduler.check()).toBeNull(); expect(tick).toHaveBeenCalledOnce();
  scheduler.stop();vi.setSystemTime(Date.now()+100000);expect(scheduler.check()).toBeNull();
});

it('does not create request-driven traffic for a manual-only guard', async () => {
  vi.useFakeTimers();const api=service();const p=await createProtection(options);
  try {const before=api.fetch.mock.calls.length;vi.setSystemTime(Date.now()+1000000);await p.fetchGuard()(new Request('https://app.example.test/'));expect(api.fetch.mock.calls.length).toBe(before);}
  finally {await p.stop();}
});

it('queues an explicit refresh behind a request refresh without overlapping or losing it', async () => {
  vi.useFakeTimers(); const api=service();
  const p=await createProtection({...options,requestRefreshMs:1000});
  let release!:()=>void;
  const paused=new Promise<void>(resolve=>{release=resolve;});
  let attempts=0;
  vi.stubGlobal('fetch',async(url:string)=>{attempts++;if(attempts===1)await paused;return api.fetch(url);});
  try {
    vi.setSystemTime(Date.now()+2000);
    const request=p.fetchGuard()(new Request('https://app.example.test/'));
    await vi.advanceTimersByTimeAsync(0);expect(attempts).toBe(1);
    const manual=p.refresh();await vi.advanceTimersByTimeAsync(0);expect(attempts).toBe(1);
    release();await Promise.all([request,manual]);expect(attempts).toBe(2);
  } finally {release();await p.stop();}
});

it('does not adopt a newly written stamp through a mutable bundled rules object', async () => {
  const api=service();
  const rules:any={firewall:[],_patchstack:{build_id:build}};
  const p=await createProtection({...options,buildId:undefined,rules});
  try {
    rules._patchstack.build_id='b'.repeat(64);
    await p.refresh();
    expect(p.synchronization.buildId).toBe(build);
    expect(p.synchronization.matched).toBe(true);
    expect(api.fetch).toHaveBeenCalled();
  } finally {await p.stop();}
});
