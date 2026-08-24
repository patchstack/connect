import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProtect } from '../../src/protect/install/index.js';

const UUID = '3f1a9c2e-1b4d-4c8a-9e2f-7a6b5c4d3e2f';
const dirs: string[] = [];

function fixture(pkg: object, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'ps-site-uuid-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(dir, '.patchstackrc.json'), JSON.stringify({ siteUuid: UUID }));
  for (const [rel, contents] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), contents);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('runtime guard site UUID propagation', () => {
  const cases: Array<{
    name: string;
    pkg: object;
    files?: Record<string, string>;
    guard: string;
  }> = [
    {
      // No TypeScript and no `type: module`, so the guard this project can load is the CommonJS one — and
      // the UUID has to be baked into whichever file the scaffolder actually wrote.
      name: 'generic fallback',
      pkg: { name: 'generic-app' },
      guard: 'patchstack/guard.cjs',
    },
    {
      name: 'Express',
      pkg: { dependencies: { express: '^4.21.2' } },
      files: { 'src/server.ts': "import express from 'express';\nconst app = express();\n" },
      guard: 'src/patchstack/guard.ts',
    },
    {
      name: 'Fastify',
      pkg: { dependencies: { fastify: '^4.26.0' } },
      files: { 'src/server.ts': "import Fastify from 'fastify';\nconst app = Fastify();\n" },
      guard: 'src/patchstack/guard.ts',
    },
    {
      name: 'NestJS',
      pkg: { dependencies: { '@nestjs/core': '^10.0.0' } },
      files: { 'src/main.ts': 'const app = await NestFactory.create(AppModule);\n' },
      guard: 'src/patchstack/guard.ts',
    },
    {
      name: 'Next.js',
      pkg: { dependencies: { next: '^14.0.0' } },
      guard: 'middleware.ts',
    },
    {
      name: 'SvelteKit',
      pkg: { devDependencies: { '@sveltejs/kit': '^2.0.0' } },
      guard: 'src/hooks.server.ts',
    },
    {
      name: 'Astro',
      pkg: { dependencies: { astro: '^4.0.0' } },
      guard: 'src/middleware.ts',
    },
  ];

  for (const testCase of cases) {
    it(`bakes .patchstackrc.json into the ${testCase.name} guard`, () => {
      const dir = fixture(testCase.pkg, testCase.files);
      runProtect(dir);

      const guard = readFileSync(join(dir, testCase.guard), 'utf8');
      expect(guard).toContain(UUID);
      expect(guard).not.toContain('__PATCHSTACK_SITE_UUID__');
    });
  }

  it('keeps the placeholder in demo mode so local demo rules stay active', () => {
    const dir = fixture({ dependencies: { next: '^14.0.0' } });
    runProtect(dir, { demo: true });

    expect(readFileSync(join(dir, 'middleware.ts'), 'utf8')).toContain('__PATCHSTACK_SITE_UUID__');
  });
});
