import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setupProtection, wireBuildScripts } from '../src/setup.js';

describe('wireBuildScripts', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-setup-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function writePackage(value: unknown): void {
    writeFileSync(path.join(cwd, 'package.json'), `${JSON.stringify(value, null, 2)}\n`);
  }

  function readPackage(): { scripts: Record<string, string> } {
    return JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
  }

  it('adds lifecycle hooks for npm without replacing existing hooks', () => {
    writePackage({
      scripts: { build: 'vite build', prebuild: 'npm run lint', postbuild: 'echo complete' },
    });

    const result = wireBuildScripts(cwd, 'npm');

    expect(result).toMatchObject({ changed: true, strategy: 'lifecycle-hooks' });
    expect(readPackage().scripts).toMatchObject({
      build: 'vite build',
      postinstall: 'patchstack-connect scan',
      prebuild: 'patchstack-connect scan && npm run lint',
      postbuild: 'echo complete && patchstack-connect mark-build',
    });
  });

  it('clears a previous map stamp before an existing prebuild can write the next one', () => {
    writePackage({
      scripts: { build: 'vite build', prebuild: 'patchstack-connect map --upload' },
    });

    wireBuildScripts(cwd, 'npm');

    expect(readPackage().scripts.prebuild).toBe(
      'patchstack-connect scan && patchstack-connect map --upload',
    );
  });

  it('moves an existing trailing scan ahead of the prebuild command', () => {
    writePackage({
      scripts: {
        build: 'vite build',
        prebuild: 'patchstack-connect map --upload && patchstack-connect scan',
      },
    });

    wireBuildScripts(cwd, 'npm');

    expect(readPackage().scripts.prebuild).toBe(
      'patchstack-connect scan && patchstack-connect map --upload',
    );
  });

  it('chains directly around a Bun build', () => {
    writePackage({ scripts: { build: 'vite build' } });

    const result = wireBuildScripts(cwd, 'bun');

    expect(result).toMatchObject({ changed: true, strategy: 'build-chain' });
    expect(readPackage().scripts.build).toBe(
      'patchstack-connect scan && vite build && patchstack-connect mark-build',
    );
    expect(readPackage().scripts.postinstall).toBe('patchstack-connect scan');
  });

  it('moves an existing Bun scan ahead of map upload without duplicating it', () => {
    writePackage({
      scripts: {
        build:
          'patchstack-connect map --upload && patchstack-connect scan && vite build && patchstack-connect mark-build',
      },
    });

    wireBuildScripts(cwd, 'bun');

    expect(readPackage().scripts.build).toBe(
      'patchstack-connect scan && patchstack-connect map --upload && vite build && patchstack-connect mark-build',
    );
  });

  it('is idempotent', () => {
    writePackage({ scripts: { build: 'vite build' } });

    wireBuildScripts(cwd, 'pnpm');
    const second = wireBuildScripts(cwd, 'pnpm');

    expect(second.changed).toBe(false);
    expect(readPackage().scripts.postinstall).toBe('patchstack-connect scan');
    expect(readPackage().scripts.prebuild).toBe('patchstack-connect scan');
    expect(readPackage().scripts.postbuild).toBe('patchstack-connect mark-build');
  });

  it('does not duplicate a scan already first in a semicolon hook', () => {
    writePackage({
      scripts: {
        build: 'vite build',
        prebuild: 'patchstack-connect scan; patchstack-connect map --upload',
      },
    });

    const result = wireBuildScripts(cwd, 'npm');

    expect(result.changed).toBe(true); // the other hooks are still added
    expect(readPackage().scripts.prebuild).toBe(
      'patchstack-connect scan; patchstack-connect map --upload',
    );
  });

  it('adds a dependency-install scan when no build script exists', () => {
    writePackage({ scripts: { test: 'vitest', postinstall: 'prisma generate' } });
    const result = wireBuildScripts(cwd, 'npm');

    expect(result).toMatchObject({ changed: true, strategy: 'postinstall-only' });
    expect(readPackage().scripts.postinstall).toBe(
      'prisma generate && patchstack-connect scan',
    );
  });

  it('creates a scripts object for the dependency-install scan', () => {
    writePackage({ name: 'no-scripts' });
    mkdirSync(path.join(cwd, 'src'));

    const result = wireBuildScripts(cwd, 'yarn');

    expect(result.strategy).toBe('postinstall-only');
    expect(readPackage().scripts.postinstall).toBe('patchstack-connect scan');
  });
});

describe('setupProtection', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-setup-protect-'));
    writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@patchstack/connect': '^0.3.19',
          '@tanstack/react-start': '^1.0.0',
        },
      }),
    );
    writeFileSync(
      path.join(cwd, '.patchstackrc.json'),
      JSON.stringify({ siteUuid: '550e8400-e29b-41d4-a716-446655440000' }),
    );
    mkdirSync(path.join(cwd, 'src', 'integrations', 'supabase'), { recursive: true });
    writeFileSync(
      path.join(cwd, 'src', 'start.ts'),
      `import { createStart, createMiddleware } from "@tanstack/react-start";\n\nexport const startInstance = createStart(() => ({\n  requestMiddleware: [],\n}));\n`,
    );
    writeFileSync(
      path.join(cwd, 'src', 'integrations', 'supabase', 'client.ts'),
      `import { createClient } from '@supabase/supabase-js';\nfunction createSupabaseFetch(supabaseKey: string): typeof fetch {\n  return (input, init) => {\n    const headers = new Headers();\n    headers.set('apikey', supabaseKey);\n    return fetch(input, { ...init, headers });\n  };\n}\n`,
    );
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('wires and verifies the Lovable TanStack + Supabase seam after provisioning', () => {
    const result = setupProtection(cwd);

    expect(result.install).toMatchObject({ status: 'wired', adapter: 'tanstack-supabase' });
    expect(result.verification).toMatchObject({
      stack: 'TanStack Start + Supabase',
      wired: true,
    });
    expect(
      readFileSync(path.join(cwd, 'src', 'integrations', 'patchstack', 'guard.ts'), 'utf8'),
    ).toContain('550e8400-e29b-41d4-a716-446655440000');
  });

  it('is idempotent when setup is re-run', () => {
    setupProtection(cwd);
    const startAfterFirstRun = readFileSync(path.join(cwd, 'src', 'start.ts'), 'utf8');

    const second = setupProtection(cwd);

    expect(second.verification.wired).toBe(true);
    expect(readFileSync(path.join(cwd, 'src', 'start.ts'), 'utf8')).toBe(startAfterFirstRun);
  });
});
