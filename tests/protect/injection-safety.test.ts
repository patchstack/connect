import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { runProtect, runVerify } from '../../src/protect/install/index.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
function project(dependencies: Record<string, string>, files: Record<string, string>) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const cwd = mkdtempSync(join(tmpdir(), 'ps-injection-'));
  dirs.push(cwd);
  for (const [file, source] of Object.entries({ 'package.json': JSON.stringify({ type: 'module', dependencies }), ...files })) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), source);
  }
  return cwd;
}
const read = (cwd: string, file: string) => readFileSync(join(cwd, file), 'utf8');
const syntaxErrors = (source: string) => (ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true) as ts.SourceFile & {parseDiagnostics: unknown[]}).parseDiagnostics;

describe('complete-statement registration', () => {
  it.each(['ts', 'js'])('preserves multiline imports and parsers in %s', ext => {
    const file = `src/server.${ext}`;
    const cwd = project({ express: '^5' }, { [file]: `import express, {
  json,
} from 'express';
const app = express();
app.use(json({
  limit: '1mb',
}));
app.use(express.urlencoded({ extended: false }));
app.post('/submit', handler);
` });
    runProtect(cwd);
    const source = read(cwd, file);
    expect(syntaxErrors(source)).toEqual([]);
    expect(source.indexOf('app.use(patchstackMiddleware)')).toBeGreaterThan(source.indexOf('extended: false'));
    expect(runVerify(cwd).wired).toBe(true);
    runProtect(cwd);
    expect(read(cwd, file)).toBe(source);
  });

  it.each([
    ['fastify', "import fastify from 'fastify';\nconst app = fastify({\n  logger: true,\n});\napp.listen({port:3000});\n"],
    ['@nestjs/core', "import { NestFactory } from '@nestjs/core';\nasync function bootstrap() {\nconst app = await NestFactory.create(\n AppModule,\n {rawBody: true},\n);\nawait app.listen(3000);\n}\nbootstrap();\n"],
    ['@nestjs/core', "import { NestFactory } from '@nestjs/core';\nasync function main(){ const app = await NestFactory.create(AppModule); app.use(express.json()); await app.listen(3000); }\nmain();\n"],
  ])('preserves multiline %s initialization', (dependency, source) => {
    const cwd = project({ [dependency]: '*' }, { 'src/server.ts': source });
    runProtect(cwd);
    expect(syntaxErrors(read(cwd, 'src/server.ts'))).toEqual([]);
    expect(runVerify(cwd).wired).toBe(true);
  });

  it('reports an unprefixed router above the guard', () => {
    const cwd = project({ express: '^5' }, { 'server.ts': "import express from 'express';\nconst app = express();\napp.use(router);\napp.use(express.json());\n" });
    expect(runProtect(cwd).status).toBe('scaffolded');
    expect(runVerify(cwd).wired).toBe(false);
  });

  it('does not overwrite a customized helper on a rerun', () => {
    const cwd = project({ express: '^5' }, { 'server.ts': "import express from 'express';\nconst app = express();\napp.use(express.json());\n" });
    runProtect(cwd);
    const file = 'patchstack/guard.ts';
    const customized = read(cwd, file) + '\n// Application-specific configuration.\n';
    writeFileSync(join(cwd, file), customized);
    runProtect(cwd);
    expect(read(cwd, file)).toBe(customized);
  });
});

const client = `export function createSupabaseFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("apikey", supabaseKey);
    return fetch(input, { ...init, headers });
  };
}`;
const start = `import { createMiddleware, createStart } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
export const startInstance = createStart(() => ({
 requestMiddleware : [],
}));`;
const clientFile = 'src/integrations/supabase/client.ts';
function tanstack(startSource = start, clientSource = client) {
  return project({ '@tanstack/react-start': '^1' }, { 'src/start.ts': startSource, [clientFile]: clientSource });
}

describe('TanStack paired edits', () => {
  it('accepts formatting variations and reuses an existing request import', () => {
    const cwd = tanstack();
    expect(runProtect(cwd).status).toBe('wired');
    const source = read(cwd, 'src/start.ts');
    expect(source.match(/import \{ getRequest \}/g)).toHaveLength(1);
    expect(syntaxErrors(source)).toEqual([]);
    runProtect(cwd);
    expect(read(cwd, 'src/start.ts')).toBe(source);
  });

  it.each([
    start.replace('requestMiddleware : []', 'requestMiddleware: middlewareFromConfig'),
    start.replace('requestMiddleware : []', '...externalConfig, requestMiddleware: []'),
    start.replace('createStart(() => ({', 'createStart(dynamicConfig, () => ({'),
  ])('does not redirect the client when the server cannot be composed', source => {
    const cwd = tanstack(source);
    expect(runProtect(cwd).status).toBe('scaffolded');
    expect(read(cwd, clientFile)).toBe(client);
    expect(read(cwd, 'src/start.ts')).toBe(source);
    expect(runVerify(cwd).wired).toBe(false);
  });

  it('does not change the server when the client is unsupported', () => {
    const cwd = tanstack(start, 'export const client = createClient(url, key);');
    expect(runProtect(cwd).status).toBe('scaffolded');
    expect(read(cwd, 'src/start.ts')).toBe(start);
  });

  it('preserves Request bodies, headers, overrides and cancellation when tunneling', async () => {
    const cwd = tanstack();
    runProtect(cwd);
    const source = ts.transpileModule(read(cwd, clientFile), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace('export ', '');
    const fetched: Request[] = [];
    const fetcher = new Function('window', 'fetch', source + '; return createSupabaseFetch("public-test-key");')(
      { location:{origin:'https://app.example'} }, async (request: Request) => { fetched.push(request); return new Response('ok'); },
    ) as typeof fetch;
    const controller = new AbortController();
    const input = new Request('https://backend.example/rest/v1/items', {method:'POST',body:'original',headers:{authorization:'Bearer synthetic'},signal:controller.signal});
    await fetcher(input, {body:'overridden'});
    const forwarded = fetched[0]!;
    expect(forwarded.url).toBe('https://app.example/_patchstack/guard');
    expect(forwarded.method).toBe('POST');
    expect(await forwarded.text()).toBe('overridden');
    expect(forwarded.headers.get('authorization')).toBe('Bearer synthetic');
    expect(forwarded.headers.get('x-ps-target')).toBe(input.url);
    controller.abort();
    expect(forwarded.signal.aborted).toBe(true);
    await fetcher('https://backend.example/rest/v1/items');
    expect(fetched[1]!.method).toBe('GET');
    expect(fetched[1]!.body).toBeNull();
  });
});
