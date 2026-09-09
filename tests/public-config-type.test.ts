import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * `Config` is exported from the package entry point, so a consumer can build one and hand it to
 * `scanAndReport` or `postManifest`. Adding a REQUIRED field to it stops that consumer compiling on an
 * upgrade, even though nothing about their code became wrong — the push omits a field it was not given.
 *
 * So this compiles a consumer written against the shape as it shipped, the way that consumer's own `tsc`
 * would. It is the check that a new field on `Config` was added as optional.
 */
const SCRATCH = path.join(process.cwd(), '.public-types-check');

function compiles(source: string): { ok: boolean; output: string } {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(path.join(SCRATCH, 'consumer.ts'), source, 'utf8');

  try {
    execFileSync(
      path.join(process.cwd(), 'node_modules/.bin/tsc'),
      ['--noEmit', '--strict', '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler', 'consumer.ts'],
      { cwd: SCRATCH, encoding: 'utf8', stdio: 'pipe' },
    );
    return { ok: true, output: '' };
  } catch (err) {
    return { ok: false, output: String((err as { stdout?: string }).stdout ?? err) };
  }
}

describe('the exported Config stays buildable by an existing consumer', () => {
  afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

  it('compiles a Config literal written before siteUrl and siteName existed', () => {
    const result = compiles(`
      import type { Config } from '../src/types.js';

      export const config: Config = {
        siteUuid: '550e8400-e29b-41d4-a716-446655440000',
        apiKey: 'k',
        pulseAuth: 'k',
        endpoint: 'https://api.patchstack.com/monitor/pulse/manifest',
        timeoutMs: 30_000,
        environment: 'production',
        widget: true,
      };
    `);

    expect(result.output).toBe('');
    expect(result.ok).toBe(true);
    // Spawning a real `tsc` is slow, and slower again alongside the rest of the suite.
  }, 60_000);

  it('still rejects a Config that is missing a field the package has always required', () => {
    // Guards the guard: a check that accepts anything would pass the test above for the wrong reason.
    const result = compiles(`
      import type { Config } from '../src/types.js';

      export const config: Config = {
        siteUuid: null,
        apiKey: null,
        pulseAuth: null,
        endpoint: 'https://api.patchstack.com/monitor/pulse/manifest',
        timeoutMs: 30_000,
        environment: 'production',
      };
    `);

    expect(result.ok).toBe(false);
    expect(result.output).toContain('widget');
  }, 60_000);
});
