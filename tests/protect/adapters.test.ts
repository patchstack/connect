import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProtect, runVerify } from '../../src/protect/install/index.js';

const read = (dir: string, rel: string) => readFileSync(path.join(dir, rel), 'utf8');
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), p));

describe('Express adapter', () => {
  function expressApp(): string {
    const dir = tmp('ps-express-');
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { express: '^4.19.0' } }));
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src/server.ts'), "import express from 'express';\nconst app = express();\napp.listen(3000);\n");
    return dir;
  }

  it('scaffolds the guard and wires app.use(patchstackMiddleware) after the express() app', () => {
    const dir = expressApp();
    try {
      const res: any = runProtect(dir);
      expect(res.status).toBe('wired');
      expect(res.adapter).toBe('express');
      expect(existsSync(path.join(dir, 'src/patchstack/guard.ts'))).toBe(true);
      const server = read(dir, 'src/server.ts');
      expect(server).toContain('import { patchstackMiddleware } from "./patchstack/guard";');
      expect(server).toContain('app.use(patchstackMiddleware);');
      expect(server.indexOf('const app = express()')).toBeLessThan(server.indexOf('app.use(patchstackMiddleware)'));
      expect(runVerify(dir).wired).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent (re-run does not duplicate the middleware)', () => {
    const dir = expressApp();
    try {
      runProtect(dir);
      runProtect(dir);
      expect(count(read(dir, 'src/server.ts'), 'app.use(patchstackMiddleware)')).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Next.js adapter', () => {
  it('scaffolds middleware.ts + co-located rules when none exists', () => {
    const dir = tmp('ps-next-');
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { next: '^14.0.0' } }));
    try {
      const res: any = runProtect(dir);
      expect(res.status).toBe('wired');
      expect(res.adapter).toBe('nextjs');
      const mw = read(dir, 'middleware.ts');
      expect(mw).toContain('patchstack-next');
      expect(mw).toContain('config = { matcher:');
      expect(existsSync(path.join(dir, 'patchstack.rules.json'))).toBe(true);
      expect(runVerify(dir).wired).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT overwrite an existing middleware (scaffolds rules + leaves it, verify not wired)', () => {
    const dir = tmp('ps-next2-');
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { next: '^14.0.0' } }));
    const ownMiddleware = 'export function middleware() { /* my own */ }\n';
    writeFileSync(path.join(dir, 'middleware.ts'), ownMiddleware);
    try {
      runProtect(dir);
      expect(read(dir, 'middleware.ts')).toBe(ownMiddleware); // untouched
      expect(existsSync(path.join(dir, 'patchstack.rules.json'))).toBe(true); // rules still scaffolded
      expect(runVerify(dir).wired).toBe(false); // guard not in their middleware
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SvelteKit adapter', () => {
  it('scaffolds src/hooks.server.ts + co-located rules when none exists', () => {
    const dir = tmp('ps-svelte-');
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', devDependencies: { '@sveltejs/kit': '^2.0.0' } }));
    try {
      const res: any = runProtect(dir);
      expect(res.status).toBe('wired');
      expect(res.adapter).toBe('sveltekit');
      const hooks = read(dir, 'src/hooks.server.ts');
      expect(hooks).toContain('patchstack-sveltekit');
      expect(hooks).toContain('export const handle');
      expect(existsSync(path.join(dir, 'src/patchstack.rules.json'))).toBe(true);
      expect(runVerify(dir).wired).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT overwrite an existing hooks.server.ts (verify not wired)', () => {
    const dir = tmp('ps-svelte2-');
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', devDependencies: { '@sveltejs/kit': '^2.0.0' } }));
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    const own = 'export const handle = async ({ event, resolve }) => resolve(event);\n';
    writeFileSync(path.join(dir, 'src/hooks.server.ts'), own);
    try {
      runProtect(dir);
      expect(read(dir, 'src/hooks.server.ts')).toBe(own); // untouched
      expect(existsSync(path.join(dir, 'src/patchstack.rules.json'))).toBe(true);
      expect(runVerify(dir).wired).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Astro adapter', () => {
  it('scaffolds src/middleware.ts + co-located rules when none exists', () => {
    const dir = tmp('ps-astro-');
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { astro: '^4.0.0' } }));
    try {
      const res: any = runProtect(dir);
      expect(res.status).toBe('wired');
      expect(res.adapter).toBe('astro');
      const mw = read(dir, 'src/middleware.ts');
      expect(mw).toContain('patchstack-astro');
      expect(mw).toContain('export const onRequest');
      expect(existsSync(path.join(dir, 'src/patchstack.rules.json'))).toBe(true);
      expect(runVerify(dir).wired).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Fastify adapter', () => {
  function fastifyApp(): string {
    const dir = tmp('ps-fastify-');
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { fastify: '^4.26.0' } }));
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src/server.ts'), "import Fastify from 'fastify';\nconst app = fastify();\napp.listen({ port: 3000 });\n");
    return dir;
  }

  it('scaffolds the plugin and registers app.register(patchstackFastify) after the fastify() app', () => {
    const dir = fastifyApp();
    try {
      const res: any = runProtect(dir);
      expect(res.status).toBe('wired');
      expect(res.adapter).toBe('fastify');
      expect(read(dir, 'src/patchstack/guard.ts')).toContain('patchstackFastify');
      const server = read(dir, 'src/server.ts');
      expect(server).toContain('import { patchstackFastify } from "./patchstack/guard";');
      expect(server).toContain('app.register(patchstackFastify);');
      expect(server.indexOf('const app = fastify()')).toBeLessThan(server.indexOf('app.register(patchstackFastify)'));
      expect(runVerify(dir).wired).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent (re-run does not duplicate the registration)', () => {
    const dir = fastifyApp();
    try {
      runProtect(dir);
      runProtect(dir);
      expect(count(read(dir, 'src/server.ts'), 'app.register(patchstackFastify)')).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('NestJS adapter', () => {
  function nestApp(): string {
    const dir = tmp('ps-nest-');
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { '@nestjs/core': '^10.0.0' } }));
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(
      path.join(dir, 'src/main.ts'),
      "import { NestFactory } from '@nestjs/core';\nimport { AppModule } from './app.module';\nasync function bootstrap() {\n  const app = await NestFactory.create(AppModule);\n  await app.listen(3000);\n}\nbootstrap();\n",
    );
    return dir;
  }

  it('scaffolds the guard and wires app.use(patchstackMiddleware) after NestFactory.create', () => {
    const dir = nestApp();
    try {
      const res: any = runProtect(dir);
      expect(res.status).toBe('wired');
      expect(res.adapter).toBe('nestjs');
      expect(existsSync(path.join(dir, 'src/patchstack/guard.ts'))).toBe(true);
      const main = read(dir, 'src/main.ts');
      expect(main).toContain('import { patchstackMiddleware } from "./patchstack/guard";');
      expect(main).toContain('app.use(patchstackMiddleware);');
      expect(main.indexOf('NestFactory.create')).toBeLessThan(main.indexOf('app.use(patchstackMiddleware)'));
      expect(runVerify(dir).wired).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent (re-run does not duplicate the middleware)', () => {
    const dir = nestApp();
    try {
      runProtect(dir);
      runProtect(dir);
      expect(count(read(dir, 'src/main.ts'), 'app.use(patchstackMiddleware)')).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
