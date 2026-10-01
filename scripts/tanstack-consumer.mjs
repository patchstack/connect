// Optional networked consumer check: only synthetic source and a local package tarball are used.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), 'ps-tanstack-consumer-'));
const write = (file, text) => { mkdirSync(dirname(join(scratch,file)),{recursive:true}); writeFileSync(join(scratch,file),text); };
const run = (command,args,cwd=scratch) => execFileSync(command,args,{cwd,stdio:'pipe',timeout:180000});
try {
  const packed = JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',scratch],root).toString())[0].filename;
  write('package.json',JSON.stringify({private:true,type:'module',dependencies:{
    '@patchstack/connect':`file:./${packed}`, '@tanstack/react-start':'1.168.60', react:'^19.0.0', 'react-dom':'^19.0.0',
    typescript:'5.9.3', '@types/react':'^19.0.0', '@types/react-dom':'^19.0.0', '@types/node':'^22.0.0',
  }}));
  run('npm',['install','--ignore-scripts','--no-audit','--no-fund']);
  const cli = join(scratch,'node_modules/@patchstack/connect/dist/cli.js');
  const tsc = join(scratch,'node_modules/typescript/bin/tsc');
  const flags = ['--noEmit','--strict','--skipLibCheck','--module','ESNext','--moduleResolution','Bundler','--target','ES2022','--resolveJsonModule','--esModuleInterop','--lib','ES2022,DOM'];
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
  console.error(error.stdout?.toString() ?? error.message);
  console.error(error.stderr?.toString() ?? '');
  process.exitCode=1;
} finally { rmSync(scratch,{recursive:true,force:true}); }
