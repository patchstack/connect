import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {createProtection} from '../../src/protect/runtime.js';

function load(factory: unknown, processValue?: unknown) {
  const environment = arguments.length > 1 ? processValue : {env:{}};
  const source = readFileSync(new URL('../../src/protect/templates/fetch-guard.ts',import.meta.url),'utf8').replace(/^import .*$/gm,'').replace(/export /g,'');
  const compiled = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  return new Function('createProtection','fallbackRules','sentinelAnswer','VERIFY_HEADER','process',compiled+'\nreturn protectFetch;')(factory,{firewall:[],whitelists:[]},async()=>null,'x-test-verify',environment);
}

describe('generated Fetch guard',()=>{
  it('preserves body, receiver, host arguments, status and response scope without a process global',async()=>{
    const active = await createProtection({rules:{firewall:[{id:'synthetic-output',phase:'response',action:'redact',when:{path:'/contact'},rule_v2:[{parameter:'response.body',match:{type:'contains',value:'synthetic-secret'}}]}],whitelists:[]},mode:'block',reportDetections:false});
    const factoryOptions: any[]=[];
    const protect=load(async(opts:unknown)=>{factoryOptions.push(opts);return active;},undefined);
    const env={PATCHSTACK_API_KEY:'synthetic-credential',PATCHSTACK_SITE_UUID:'00000000-0000-4000-8000-000000000001'};
    const execution={waitUntil:()=>{}};
    const server={label:'server',fetch:protect(async function(this:any,request:Request,bindings:unknown,ctx:unknown){
      expect(this.label).toBe('server'); expect(bindings).toBe(env); expect(ctx).toBe(execution);
      return new Response(await request.text(),{status:201,headers:{'content-type':'text/plain','x-app':'unchanged'}});
    })};
    try {
      const request=()=>new Request('https://app.example/contact',{method:'POST',body:'synthetic-secret'});
      const responses=await Promise.all([server.fetch(request(),env,execution),server.fetch(request(),env,execution)]);
      expect(factoryOptions).toHaveLength(1);
      expect(factoryOptions[0].pulseAuth).toBe('synthetic-credential');
      expect(factoryOptions[0].refreshMs).toBe(300000);
      for(const response of responses) { expect(response.status).toBe(201);expect(await response.text()).not.toContain('synthetic-secret');expect(response.headers.get('x-app')).toBe('unchanged'); }
    } finally { active.stop(); }
  });

  it('retries a failed initialization without swallowing or repeating application exceptions',async()=>{
    let builds=0,calls=0;
    const active = await createProtection({rules:{firewall:[],whitelists:[]},mode:'block',reportDetections:false});
    const protect=load(async()=>{if(++builds===1)throw new Error('synthetic unavailable');return active;});
    const wrapped=protect(()=>{calls++;throw new Error('application error');});
    try {
      for(let i=0;i<2;i++)await expect(wrapped(new Request('https://app.example/'))).rejects.toThrow('application error');
      expect(builds).toBe(2);expect(calls).toBe(2);
    } finally { active.stop(); }
  });
});
