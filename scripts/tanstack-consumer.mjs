// Synthetic source against the real public framework and the package artifact; no live API calls.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), 'ps-tanstack-consumer-'));
const write = (file, text) => { mkdirSync(dirname(join(scratch,file)),{recursive:true}); writeFileSync(join(scratch,file),text); };
const run = (command,args,cwd=scratch) => execFileSync(command,args,{cwd,stdio:'pipe',timeout:180000});
try {
  const tarballFlag = process.argv.indexOf('--tarball');
  const packed = tarballFlag >= 0 ? resolve(process.argv[tarballFlag + 1])
    : join(scratch,JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',scratch],root).toString())[0].filename);
  write('package.json',JSON.stringify({private:true,type:'module',dependencies:{
    '@patchstack/connect':`file:${packed}`, '@tanstack/react-start':'1.168.60', react:'^19.0.0', 'react-dom':'^19.0.0',
    typescript:'5.9.3', '@types/react':'^19.0.0', '@types/react-dom':'^19.0.0', '@types/node':'^22.0.0',
  }}));
  run('npm',['install','--ignore-scripts','--no-audit','--no-fund']);
  const cli = join(scratch,'node_modules/@patchstack/connect/dist/cli.js');
  const tsc = join(scratch,'node_modules/typescript/bin/tsc');
  const flags = ['--noEmit','--strict','--skipLibCheck','--module','ESNext','--moduleResolution','Bundler','--target','ES2022','--resolveJsonModule','--esModuleInterop','--lib','ES2022,DOM'];
  const config = `import {defineConfig} from 'vite';
import {tanstackStart} from '@tanstack/react-start/plugin/vite';
export default defineConfig({plugins:[tanstackStart()]});`;
  write('vite.config.ts', config);
  for (const extension of ['mts', 'mjs']) {
    const file = `src/server.${extension}`;
    const source = 'export default {fetch() {return new Response("Unauthorized", {status:401});}};';
    write(file, source);
    run(process.execPath,[cli,'protect']);
    assert.equal(existsSync(join(scratch,'src/server.ts')), false, 'must not shadow the existing server');
    assert.equal(readFileSync(join(scratch,file),'utf8'), source);
    assert.throws(() => run(process.execPath,[cli,'protect','--check']));
    rmSync(join(scratch,file));
  }
  write('start-options.ts','export default {srcDirectory:"web"};');
  write('vite.config.ts',"import options from './start-options';\n" + config.replace('tanstackStart()', 'tanstackStart(options)'));
  run(process.execPath,[cli,'protect']);
  assert.equal(existsSync(join(scratch,'src/server.ts')), false, 'must not assume an imported configuration uses src/server.ts');
  assert.throws(() => run(process.execPath,[cli,'protect','--check']));
  write('vite.config.ts',config);
  run(process.execPath,[cli,'protect']);
  run(process.execPath,[cli,'protect','--check']);
  run(process.execPath,[tsc,...flags,'src/server.ts']);
  write('src/start.ts',`import {createStart, createMiddleware} from '@tanstack/react-start';
export const startInstance = createStart(() => ({requestMiddleware: []}));\n`);
  write('src/integrations/supabase/client.ts',`export function createSupabaseFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('apikey', supabaseKey);
    return fetch(input, {...init,headers});
  };
}\n`);
  write('tsconfig.json',JSON.stringify({compilerOptions:{strict:true,skipLibCheck:true,module:'ESNext',moduleResolution:'Bundler',target:'ES2022',resolveJsonModule:true,esModuleInterop:true,lib:['ES2022','DOM'],baseUrl:'.',paths:{'@/*':['src/*']}},include:['src/**/*.ts']}));
  run(process.execPath,[cli,'protect']);
  run(process.execPath,[cli,'protect','--check']);
  run(process.execPath,[tsc,'--noEmit']);
  console.log('TanStack consumer: native entry and middleware composition passed against real framework types.');
} catch (error) {
  console.error((error.stdout?.toString() ?? error.message).replaceAll(scratch,'<fixture>').replaceAll(root,'<repository>'));
  console.error((error.stderr?.toString() ?? '').replaceAll(scratch,'<fixture>').replaceAll(root,'<repository>'));
  process.exitCode=1;
} finally { rmSync(scratch,{recursive:true,force:true}); }
