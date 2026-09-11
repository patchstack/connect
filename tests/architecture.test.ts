import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyArchitecture } from '../src/architecture.js';

describe('classifyArchitecture', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-architecture-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const manifest = (deps: Record<string, string>, devDeps: Record<string, string> = {}): void => {
    writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: deps, devDependencies: devDeps }, null, 2),
    );
  };

  it('finds no request path in a static Eleventy site, even one that deploys to Netlify', () => {
    manifest({}, { '@11ty/eleventy': '^3.0.0' });
    // A platform config is where the app deploys, not something that serves a request.
    writeFileSync(path.join(cwd, 'netlify.toml'), '[build]\n  publish = "_site"\n');

    const verdict = classifyArchitecture(cwd);

    expect(verdict.requestPath).toBe('none');
    expect(verdict.evidence).toEqual(['static build: eleventy']);
    expect(verdict.note).toContain('no request path');
  });

  it('finds a request path from a server framework', () => {
    manifest({ express: '^4.19.0' });

    const verdict = classifyArchitecture(cwd);

    expect(verdict.requestPath).toBe('server');
    expect(verdict.evidence).toContain('server dependency: express');
  });

  it('finds a request path from provider functions with source in them', () => {
    manifest({}, { vite: '^5.0.0' });
    mkdirSync(path.join(cwd, 'netlify', 'functions'), { recursive: true });
    writeFileSync(path.join(cwd, 'netlify', 'functions', 'hello.ts'), 'export default () => new Response("hi");');

    const verdict = classifyArchitecture(cwd);

    expect(verdict.requestPath).toBe('server');
    expect(verdict.evidence.join(' ')).toContain('netlify-functions');
  });

  it('will not call a project static when a root api/ folder holds source', () => {
    manifest({}, { vite: '^5.0.0' });
    mkdirSync(path.join(cwd, 'api'));
    writeFileSync(path.join(cwd, 'api', 'handler.ts'), 'export default (req: Request) => new Response("ok");');

    expect(classifyArchitecture(cwd).requestPath).toBe('unknown');
  });

  it('will not call a project static when edge-runtime tooling is installed', () => {
    manifest({}, { vite: '^5.0.0', wrangler: '^3.0.0' });

    const verdict = classifyArchitecture(cwd);

    expect(verdict.requestPath).toBe('unknown');
    expect(verdict.evidence.join(' ')).toContain('wrangler');
  });

  it('will not call a project static when a wrangler config names a deployment', () => {
    manifest({}, { vite: '^5.0.0' });
    writeFileSync(path.join(cwd, 'wrangler.toml'), 'name = "app"\n');

    expect(classifyArchitecture(cwd).requestPath).toBe('unknown');
  });

  it('treats a SvelteKit site with the static adapter as static, and without it as a server', () => {
    manifest({}, { '@sveltejs/kit': '^2.0.0', '@sveltejs/adapter-static': '^3.0.0' });
    expect(classifyArchitecture(cwd).requestPath).toBe('none');

    manifest({}, { '@sveltejs/kit': '^2.0.0' });
    expect(classifyArchitecture(cwd).requestPath).toBe('server');
  });

  it('is unknown for a project it cannot read, never static', () => {
    expect(classifyArchitecture(cwd).requestPath).toBe('unknown');
  });
});

describe('classifyArchitecture: none needs positive static-only evidence', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-architecture-static-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const manifest = (deps: Record<string, string>, extra: Record<string, unknown> = {}): void => {
    writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'app', devDependencies: deps, ...extra }));
  };

  it('does not call a project static on a bundler alone — vite builds servers too', () => {
    manifest({ vite: '^5.0.0' });
    expect(classifyArchitecture(cwd).requestPath).toBe('unknown');
  });

  it('does not call a project static when a hand-written server sits beside the bundler', () => {
    manifest({ vite: '^5.0.0' });
    writeFileSync(
      path.join(cwd, 'server.mjs'),
      "import { createServer } from 'node:http';\ncreateServer((req, res) => res.end('ok')).listen(3000);\n",
    );

    const verdict = classifyArchitecture(cwd);

    expect(verdict.requestPath).toBe('unknown');
    expect(verdict.evidence).toContain('ambiguous: server entry: server.mjs');
  });

  it('does not call a project static when a generator sits beside a server entry', () => {
    manifest({ '@11ty/eleventy': '^3.0.0' });
    writeFileSync(path.join(cwd, 'src'), '', { flag: 'wx' }); // a file, so src/* candidates are simply absent
    writeFileSync(path.join(cwd, 'index.js'), "const app = require('express')();\napp.listen(8080);\n");

    expect(classifyArchitecture(cwd).requestPath).toBe('unknown');
  });

  it("reads the file package.json#main points at, inside the project only", () => {
    manifest({ '@11ty/eleventy': '^3.0.0' }, { main: 'lib/serve.js' });
    mkdirSync(path.join(cwd, 'lib'));
    writeFileSync(path.join(cwd, 'lib', 'serve.js'), "Bun.serve({ fetch: () => new Response('hi') });\n");
    expect(classifyArchitecture(cwd).requestPath).toBe('unknown');

    // A main outside the project is not followed.
    manifest({ '@11ty/eleventy': '^3.0.0' }, { main: '../elsewhere/serve.js' });
    expect(classifyArchitecture(cwd).requestPath).toBe('none');
  });

  it('still calls a generator with no server anywhere static', () => {
    manifest({ '@11ty/eleventy': '^3.0.0' });
    writeFileSync(path.join(cwd, 'index.js'), "console.log('build helper, serves nothing');\n");
    expect(classifyArchitecture(cwd).requestPath).toBe('none');
  });
});
