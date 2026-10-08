import { afterEach, expect, it, vi } from 'vitest';
import { ACTIVATION_HEADER, activationChallenge, activationResponse, verifyActivationResponse } from '../../src/protect/activation.js';
import { createProtection } from '../../src/protect/runtime.js';
import { checkActivation } from '../../src/activation-check.js';
import type { Config } from '../../src/types.js';

const secret='synthetic-activation-secret-1234';
const site='11111111-1111-4111-8111-111111111111';
const build='a'.repeat(64);
const url='https://preview.example.test/api/contact';
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});

it('authenticates the loaded guard, not a static file or echoed challenge', async () => {
  const p=await createProtection({pulseAuth:secret,buildId:build,rules:{firewall:[]},cache:false,reportDetections:false});
  try {
    const challenge=await activationChallenge(secret,url);
    const req=new Request(url,{method:'OPTIONS',headers:{[ACTIVATION_HEADER]:challenge}});
    const response=await p.fetchGuard()(req);
    expect(response?.status).toBe(200);expect(response?.headers.get('cache-control')).toBe('no-store');
    const body=await response!.text();
    expect(body).not.toContain(secret);
    const status=await verifyActivationResponse(secret,challenge,body,response!.headers.get(ACTIVATION_HEADER));
    expect(status).toMatchObject({buildId:build,mapRules:'unknown',rules:{scopedBlocking:0}});
    expect(await verifyActivationResponse(secret,challenge,body,challenge)).toBeNull();
    expect(await verifyActivationResponse(secret,await activationChallenge(secret,url),body,response!.headers.get(ACTIVATION_HEADER))).toBeNull();
  } finally {await p.stop();}
});

it.each(['wrong-key','expired','different-path','different-method','no-secret','disabled'] as const)('leaves ordinary routing untouched for %s', async scenario=>{
  const challenge=await activationChallenge(scenario==='wrong-key'?'wrong':secret,url,Date.now()-(scenario==='expired'?61000:0));
  const req=new Request(scenario==='different-path'?`${url}/other`:url,{method:scenario==='different-method'?'GET':'OPTIONS',headers:{[ACTIVATION_HEADER]:challenge}});
  const p=await createProtection({pulseAuth:scenario==='no-secret'?'':secret,activationCheck:scenario!=='disabled',cache:false});
  try {expect(await p.fetchGuard()(req)).toBeNull();}finally{await p.stop();}
});

it.each(['express','node'] as const)('answers through the %s seam without reading an application body', async adapter=>{
  const p=await createProtection({pulseAuth:secret,buildId:build,cache:false});
  try {
    const challenge=await activationChallenge(secret,url);
    const req={method:'OPTIONS',url:'/api/contact',headers:{[ACTIVATION_HEADER]:challenge}};
    const headers:Record<string,string>={};let body='';
    const res:any={setHeader:(key:string,value:string)=>{headers[key]=value;}};
    const finished=new Promise<void>(resolve=>{res.end=(value:string)=>{body=value;resolve();};});
    const next=vi.fn();p[adapter]()(req,res,next);await finished;
    expect(next).not.toHaveBeenCalled();expect(await verifyActivationResponse(secret,challenge,body,headers[ACTIVATION_HEADER]!)).toMatchObject({buildId:build});
  }finally{await p.stop();}
});

const config={siteUuid:site,pulseAuth:secret} as Config;
it('checks only the explicit URL, never sends the credential, and rejects stale builds', async()=>{
  let loaded=build;
  const transport=vi.fn(async (target:string,init:RequestInit)=>{
    expect(target).toBe(url);expect(init.redirect).toBe('error');expect(JSON.stringify(init.headers)).not.toContain(secret);
    return (await activationResponse(new Request(target,init),secret,()=>({siteUuid:site,buildId:loaded,mapRules:'ready',source:{ok:true},rules:{request:0,response:0,scopedBlocking:0}})))!;
  });
  vi.stubGlobal('fetch',transport);
  expect(await checkActivation(url,config,'.',build)).toMatchObject({ok:true});
  loaded='b'.repeat(64);expect(await checkActivation(url,config,'.',build)).toMatchObject({ok:false});
  expect(transport).toHaveBeenCalledTimes(2);
});

it.each(['http://preview.example.test/','https://user:pass@example.test/','https://example.test/#fragment'])('rejects unsafe activation targets: %s',async target=>{
  const transport=vi.fn();vi.stubGlobal('fetch',transport);
  expect((await checkActivation(target,config,'.',build)).ok).toBe(false);expect(transport).not.toHaveBeenCalled();
});

it('bounds a transport that ignores abort', async()=>{
  vi.useFakeTimers();vi.stubGlobal('fetch',()=>new Promise(()=>{}));
  const work=checkActivation(url,config,'.',build);
  await vi.advanceTimersByTimeAsync(5001);
  expect(await work).toMatchObject({ok:false,message:expect.stringContaining('timed out')});
});
