import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { runProtect, runVerify } from '../../src/protect/install/index.js';
import { composeTanstackEntry } from '../../src/protect/install/adapters/tanstack.js';
import { composeNextMiddleware } from '../../src/protect/install/adapters/next-source.js';

const dirs: string[] = [];
const read = (cwd: string,file:string) => readFileSync(join(cwd,file),'utf8');
function put(cwd:string,file:string,source:string) { mkdirSync(dirname(join(cwd,file)),{recursive:true}); writeFileSync(join(cwd,file),source); }
function fixture(dependencies: Record<string,string>) {
  vi.spyOn(console,'log').mockImplementation(()=>{});
  const cwd = mkdtempSync(join(tmpdir(),'ps-framework-')); dirs.push(cwd);
  put(cwd,'package.json',JSON.stringify({type:'module',dependencies}));
  return cwd;
}
function tanstack() {
  const cwd = fixture({'@tanstack/react-start':'^1.168.0'});
  put(cwd,'node_modules/@tanstack/react-start/package.json',JSON.stringify({name:'@tanstack/react-start',exports:{'./package.json':'./package.json','./server-entry':{import:'./server.js'}}}));
  return cwd;
}
const viteConfig = (options = '') => `import {defineConfig} from 'vite';
import {tanstackStart} from '@tanstack/react-start/plugin/vite';
export default defineConfig({plugins:[tanstackStart(${options})]});`;
afterEach(()=>{ dirs.splice(0).forEach(cwd=>rmSync(cwd,{recursive:true,force:true})); vi.restoreAllMocks(); });

describe('native TanStack server boundary',()=>{
  it('does not depend on a Supabase client or start.ts and is idempotent',()=>{
    const cwd=tanstack();
    expect(runProtect(cwd).status).toBe('wired');
    expect(read(cwd,'src/server.ts')).toContain('protectFetch(handler.fetch.bind(handler))');
    expect(existsSync(join(cwd,'src/start.ts'))).toBe(false);
    expect(existsSync(join(cwd,'src/integrations/supabase/client.ts'))).toBe(false);
    const source=read(cwd,'src/server.ts'); runProtect(cwd);
    expect(read(cwd,'src/server.ts')).toBe(source);
    expect(runVerify(cwd).wired).toBe(true);
  });
  it.each([
    'fetch(request: Request, options: {context:unknown}) { return handler.fetch(request, options); }',
    'async fetch(request: Request, options: {context:unknown}) { return handler.fetch(request, options); }',
    'fetch: handler.fetch.bind(handler)',
    'fetch',
  ])('composes a literal handler: %s',property=>{
    const source=`import handler, {createServerEntry} from '@tanstack/react-start/server-entry';\nconst fetch = handler.fetch;\nexport default createServerEntry({${property}, scheduled() { return 1; }});`;
    const composed=composeTanstackEntry(ts,source)!;
    expect(composed).toContain('protectFetch(');
    expect(composed).toContain('scheduled() { return 1; }');
    expect((ts.createSourceFile('server.ts',composed,ts.ScriptTarget.Latest,true) as any).parseDiagnostics).toEqual([]);
  });
  it.each(['...options, fetch: handler.fetch','get fetch() { return handler.fetch; }','fetch: handler.fetch, fetch: other','[key]: handler.fetch'])('preserves unsupported configurations: %s',property=>{
    const cwd=tanstack();
    const source=`import {createServerEntry} from '@tanstack/react-start/server-entry';\nexport default createServerEntry({${property}});`;
    put(cwd,'src/server.ts',source);
    expect(runProtect(cwd).status).toBe('scaffolded');
    expect(read(cwd,'src/server.ts')).toBe(source);
  });
  it('refuses ambiguous entry configuration and reports a removed wrapper',()=>{
    const cwd=tanstack();
    put(cwd,'vite.config.ts','export default { server: { entry: "custom.ts" } };');
    expect(runProtect(cwd).status).toBe('scaffolded');
    expect(existsSync(join(cwd,'src/server.ts'))).toBe(false);
    put(cwd,'vite.config.ts',viteConfig()); runProtect(cwd);
    put(cwd,'src/server.ts',read(cwd,'src/server.ts').replace('fetch: protectFetch(handler.fetch.bind(handler))','fetch: handler.fetch.bind(handler)'));
    expect(runVerify(cwd).wired).toBe(false);
  });

  it.each(['js','mts','mjs','tsx','jsx','cts','cjs'])('never shadows an existing server.%s entry', ext => {
    const cwd = tanstack();
    const source = 'export default { fetch() { return new Response("Unauthorized", {status:401}); } };';
    put(cwd, `src/server.${ext}`, source);
    put(cwd, 'vite.config.ts', viteConfig());
    expect(runProtect(cwd).status).toBe('scaffolded');
    expect(existsSync(join(cwd, 'src/server.ts'))).toBe(false);
    expect(read(cwd, `src/server.${ext}`)).toBe(source);
    expect(runVerify(cwd).wired).toBe(false);
  });

  it.each([
    viteConfig('options'),
    viteConfig('getOptions()'),
    viteConfig('{...options}'),
    viteConfig('{srcDirectory}'),
    viteConfig('{"srcDirectory":"web"}'),
    viteConfig('{[key]:"web"}'),
    viteConfig('{server:{entry:"custom"}}'),
    viteConfig().replace('defineConfig({plugins:[tanstackStart()]})', 'defineConfig(config)'),
    viteConfig().replace('defineConfig({plugins:[tanstackStart()]})', 'defineConfig(() => ({plugins:[tanstackStart()]}))'),
    viteConfig().replace('plugins:[tanstackStart()]', '...config,plugins:[tanstackStart()]'),
    viteConfig().replace('plugins:[tanstackStart()]', 'plugins:plugins'),
    viteConfig().replace('plugins:[tanstackStart()]', 'plugins:[...plugins,tanstackStart()]'),
    'export {default} from "./shared-config";',
  ])('does not assume default entries from dynamic configuration: %s', config => {
    const cwd = tanstack();
    put(cwd, 'vite.config.ts', "import options from './start-options';\n" + config);
    put(cwd, 'start-options.ts', 'export default {srcDirectory:"web"};');
    const source = 'export default {fetch(){ return new Response("custom"); }};';
    put(cwd, 'web/server.ts', source);
    expect(runProtect(cwd).status).toBe('scaffolded');
    expect(existsSync(join(cwd, 'src/server.ts'))).toBe(false);
    expect(read(cwd, 'web/server.ts')).toBe(source);
    expect(runVerify(cwd).wired).toBe(false);
  });

  it.each(['ts','js','mts','mjs'])('accepts literal defaults and import aliases in vite.config.%s', ext => {
    const cwd = tanstack();
    const config = viteConfig('{}').replace('{defineConfig}', '{defineConfig as config}').replace('defineConfig(', 'config(')
      .replace('{tanstackStart}', '{tanstackStart as start}').replace('tanstackStart(', 'start(');
    put(cwd, `vite.config.${ext}`, config);
    expect(runProtect(cwd).status).toBe('wired');
    expect(runVerify(cwd).wired).toBe(true);
  });

  it.each([
    'defineConfig()',
    'defineConfig({})',
    'defineConfig({tanstackStart:{}, vite:{build:{sourcemap:true}}})',
  ])('accepts a config wrapper that adds tanstackStart() with its defaults: %s', call => {
    const cwd = tanstack();
    put(cwd, 'vite.config.ts', `import {defineConfig} from '@lovable.dev/vite-tanstack-config';\nexport default ${call};`);
    expect(runProtect(cwd).status).toBe('wired');
    expect(read(cwd, 'src/server.ts')).toContain('protectFetch(handler.fetch.bind(handler))');
    expect(runVerify(cwd).wired).toBe(true);
  });

  it.each([
    'defineConfig({tanstackStart:{srcDirectory:"web"}})',
    'defineConfig({tanstackStart:{server:{entry:"custom"}}})',
    'defineConfig({tanstackStart:options})',
    'defineConfig({...options})',
    'defineConfig(options)',
    'defineConfig({plugins:[tanstackStart()]})',
  ])('does not assume default entries from a config wrapper that may move them: %s', call => {
    const cwd = tanstack();
    const start = call.includes('tanstackStart(') ? "import {tanstackStart} from '@tanstack/react-start/plugin/vite';\n" : '';
    put(cwd, 'vite.config.ts', "import {defineConfig} from '@lovable.dev/vite-tanstack-config';\n" + start +
      `import options from './start-options';\nexport default ${call};`);
    expect(runProtect(cwd).status).toBe('scaffolded');
    expect(existsSync(join(cwd, 'src/server.ts'))).toBe(false);
  });

  it.each(['vite.config.cjs','vite.config.cts','app.config.ts','rsbuild.config.ts'])('preserves unsupported configuration in %s', file => {
    const cwd = tanstack();
    put(cwd, file, 'module.exports = require("./options");');
    expect(runProtect(cwd).status).toBe('scaffolded');
    expect(existsSync(join(cwd, 'src/server.ts'))).toBe(false);
  });

  it('invalidates verification if configuration changes after wiring', () => {
    const cwd = tanstack();
    put(cwd, 'vite.config.ts', viteConfig());
    expect(runProtect(cwd).status).toBe('wired');
    const entry = read(cwd, 'src/server.ts');
    put(cwd, 'vite.config.ts', viteConfig('options'));
    expect(runVerify(cwd).wired).toBe(false);
    expect(runProtect(cwd).status).toBe('scaffolded');
    expect(read(cwd, 'src/server.ts')).toBe(entry);
  });

  it('does not create an entry that imports a custom Fetch helper', () => {
    const cwd = tanstack();
    const helper = 'export const protectFetch = (handler: unknown) => handler;';
    put(cwd, 'src/patchstack/guard.ts', helper);
    expect(runProtect(cwd).status).toBe('scaffolded');
    expect(existsSync(join(cwd, 'src/server.ts'))).toBe(false);
    expect(read(cwd, 'src/patchstack/guard.ts')).toBe(helper);
    expect(runVerify(cwd).wired).toBe(false);
  });
});

describe('version-aware Next proxy',()=>{
  it('creates proxy, not middleware, on Next 16 and retains Next 15 middleware',()=>{
    for(const major of [15,16]) {
      const cwd=fixture({next:`^${major}.0.0`});
      expect(runProtect(cwd).status).toBe('wired');
      expect(existsSync(join(cwd,major===16?'proxy.ts':'middleware.ts'))).toBe(true);
      expect(existsSync(join(cwd,major===16?'middleware.ts':'proxy.ts'))).toBe(false);
      expect(runVerify(cwd).wired).toBe(true);
    }
  });
  it.each(['proxy.ts','proxy.js','src/proxy.ts','src/proxy.js'])('preserves an existing scoped %s',file=>{
    const cwd=fixture({next:'^16.0.0'});
    put(cwd,file,'export function proxy(request) { return Response.redirect(new URL("/login",request.url)); }\nexport const config={matcher:"/admin/:path*"};');
    runProtect(cwd);
    expect(read(cwd,file)).toContain('getPatchstackProtection');
    expect(read(cwd,file)).toContain('/admin');
    expect(runVerify(cwd).wired).toBe(true);
    const source=read(cwd,file); runProtect(cwd); expect(read(cwd,file)).toBe(source);
  });
  it('refuses conflicting entries and custom URL-normalization flags',()=>{
    const cwd=fixture({next:'^16.0.0'});
    const source='export function proxy(request) { return; }';
    put(cwd,'proxy.ts',source); put(cwd,'next.config.ts','export default { skipProxyUrlNormalize: true };');
    runProtect(cwd); expect(read(cwd,'proxy.ts')).toBe(source); expect(runVerify(cwd).wired).toBe(false);
    put(cwd,'middleware.ts','export function middleware() {}');
    expect(runProtect(cwd).changed).toEqual([]);
  });
  it('guards proxy requests outside the original application matcher',()=>{
    const source='export function proxy(request) { return Response.redirect(new URL("/login", request.url)); }\nexport const config = { matcher: "/admin/:path*" };';
    const result=composeNextMiddleware(ts,'proxy.ts',source,'./guard')!;
    expect(result.indexOf('if (psBlocked) return psBlocked')).toBeLessThan(result.indexOf('new RegExp(pattern)'));
  });
});

describe('TanStack Start + Supabase when the Supabase client is not the layout the tunnel is written for', () => {
  // A generated client that builds the Supabase client directly, with no fetch wrapper to tunnel through.
  const GENERATED_CLIENT = "import { createClient } from '@supabase/supabase-js';\n" +
    "const SUPABASE_URL = 'https://example.supabase.co';\nconst SUPABASE_PUBLISHABLE_KEY = 'public-anon-key';\n" +
    'export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: true } });\n';
  const START = 'import { createStart, createMiddleware } from "@tanstack/react-start";\n' +
    'export const startInstance = createStart(() => ({ functionMiddleware: [], requestMiddleware: [] }));\n';

  function lovableApp(start: string) {
    const cwd = tanstack();
    put(cwd, 'src/start.ts', start);
    put(cwd, 'src/integrations/supabase/client.ts', GENERATED_CLIENT);
    return cwd;
  }

  it('still wires the guard into requests and server functions, and leaves the client untouched', () => {
    const cwd = lovableApp(START);

    const result = runProtect(cwd);
    const report = runVerify(cwd);

    expect(result.status).toBe('wired');
    expect(read(cwd, 'src/start.ts')).toContain('requestMiddleware: [patchstackGuard');
    expect(read(cwd, 'src/start.ts')).toContain('functionMiddleware: [patchstackFunctionGuard');
    expect(read(cwd, 'src/integrations/supabase/client.ts')).toBe(GENERATED_CLIENT);
    expect(existsSync(join(cwd, 'src/integrations/patchstack/rules.json'))).toBe(true);
    expect(report.wired).toBe(true);
    expect(report.checks.find((c) => c.label.startsWith('Supabase browser traffic'))).toMatchObject({ ok: false, optional: true });
  });

  it('falls back to the server entry when src/start.ts is not a layout it can patch either', () => {
    const start = 'import { createStart } from "@tanstack/react-start";\nconst options = () => ({});\nexport const startInstance = createStart(options);\n';
    const cwd = lovableApp(start);
    put(cwd, 'vite.config.ts', 'import { defineConfig } from "@lovable.dev/vite-tanstack-config";\nexport default defineConfig();\n');

    const result = runProtect(cwd);

    expect(result).toMatchObject({ status: 'wired', adapter: 'tanstack-start' });
    expect(read(cwd, 'src/server.ts')).toContain('protectFetch(handler.fetch.bind(handler))');
    expect(read(cwd, 'src/start.ts')).toBe(start);
    expect(read(cwd, 'src/integrations/supabase/client.ts')).toBe(GENERATED_CLIENT);
    expect(existsSync(join(cwd, 'src/integrations/patchstack/guard.ts'))).toBe(false);
    expect(runVerify(cwd)).toMatchObject({ wired: true, stack: 'TanStack Start' });
  });
});

describe('TanStack Start deployed as a Cloudflare Worker', () => {
  const cloudflareConfig = `import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
export default defineConfig(({ command }) => ({
  server: { host: "::", port: 8080 },
  plugins: [...(command === "build" ? [cloudflare({ viteEnvironment: { name: "ssr" } })] : []), tanstackStart({ server: { entry: './server.ts' } })],
}));`;
  const wrangler = (main: string) => `/** Worker settings. */
{
\t"name": "app",
\t// the Worker's entry module
\t"main": "${main}",
\t"compatibility_flags": ["nodejs_compat"]
}`;
  function worker(main = '@tanstack/react-start/server-entry') {
    const cwd = tanstack();
    put(cwd, 'vite.config.ts', cloudflareConfig);
    put(cwd, 'wrangler.jsonc', wrangler(main));
    return cwd;
  }

  it('points the Worker at the guarded entry, keeping the rest of its config, and then reports it wired', () => {
    const cwd = worker();
    expect(runProtect(cwd).status).toBe('wired');
    expect(read(cwd, 'src/server.ts')).toContain('protectFetch(handler.fetch.bind(handler))');
    expect(read(cwd, 'wrangler.jsonc')).toBe(wrangler('./src/server.ts'));
    expect(runVerify(cwd).wired).toBe(true);

    const files = [read(cwd, 'src/server.ts'), read(cwd, 'wrangler.jsonc')];
    runProtect(cwd);
    expect([read(cwd, 'src/server.ts'), read(cwd, 'wrangler.jsonc')]).toEqual(files);
  });

  it('accepts a hand-wired entry in another quote style, and names the Worker entry as what is missing', () => {
    const cwd = worker();
    expect(runProtect(cwd).status).toBe('wired');
    put(cwd, 'src/server.ts', `import handler, { createServerEntry } from '@tanstack/react-start/server-entry';
import { protectFetch } from './patchstack/guard';

export default createServerEntry({ fetch: protectFetch(handler.fetch.bind(handler)) });
`);
    put(cwd, 'wrangler.jsonc', wrangler('@tanstack/react-start/server-entry'));

    const before = runVerify(cwd);
    expect(before.wired).toBe(false);
    expect(before.checks[0]!.hint).toContain('`main` in wrangler.jsonc');

    expect(runProtect(cwd).status).toBe('wired');
    expect(read(cwd, 'wrangler.jsonc')).toBe(wrangler('./src/server.ts'));
    expect(runVerify(cwd).wired).toBe(true);
  });

  it('leaves a Worker with its own entry module alone', () => {
    const cwd = worker('./worker/index.ts');
    expect(runProtect(cwd).status).not.toBe('wired');
    expect(read(cwd, 'wrangler.jsonc')).toBe(wrangler('./worker/index.ts'));
    expect(existsSync(join(cwd, 'src/server.ts'))).toBe(false);
  });

  it('says live rules come from the bundled read-only credential when the rules file carries one', () => {
    const cwd = worker();
    runProtect(cwd);
    const rules = JSON.parse(read(cwd, 'src/patchstack/rules.json'));
    put(cwd, 'src/patchstack/rules.json', JSON.stringify({ ...rules, _patchstack: { ...rules._patchstack, rules_reader: `rr_${'a'.repeat(48)}-7` } }));

    const labels = runVerify(cwd).checks.map(check => check.label);
    expect(labels).toContain('live rule updates use the read-only rules credential in the guard rules file');
    expect(labels).not.toContain('live rule updates need PATCHSTACK_API_KEY in the deployment environment');
  });
});
