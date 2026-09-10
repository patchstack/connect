import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runProtect, runVerify } from '../../src/protect/install/index.js';

describe('protect on a project with no request path', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-protect-static-'));
    writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'site', devDependencies: { '@11ty/eleventy': '^3.0.0' } }),
    );
    writeFileSync(path.join(cwd, 'netlify.toml'), '[build]\n  publish = "_site"\n');
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('installs nothing and says the capability does not apply', () => {
    const result = runProtect(cwd);

    expect(result.status).toBe('not-applicable');
    if (result.status !== 'not-applicable') return;
    expect(result.reason).toContain('no request path');
    expect(result.evidence).toEqual(['static build: eleventy']);
    expect(result.leftovers).toEqual([]);
    expect(existsSync(path.join(cwd, 'patchstack'))).toBe(false);
  });

  it('names a guard an earlier run left behind, without deleting it', () => {
    mkdirSync(path.join(cwd, 'patchstack'));
    writeFileSync(path.join(cwd, 'patchstack', 'guard.cjs'), '// stale');
    writeFileSync(path.join(cwd, 'patchstack', 'rules.json'), '{}');

    const result = runProtect(cwd);

    expect(result.status).toBe('not-applicable');
    if (result.status !== 'not-applicable') return;
    expect(result.leftovers).toEqual(['patchstack/guard.cjs', 'patchstack/rules.json']);
    expect(existsSync(path.join(cwd, 'patchstack', 'guard.cjs'))).toBe(true);
  });

  it('verifies as not applicable rather than not wired', () => {
    const report = runVerify(cwd);

    expect(report.applicable).toBe(false);
    expect(report.wired).toBe(false);
    expect(report.checks[0]).toMatchObject({ ok: true, label: expect.stringContaining('does not apply') });
    // Reporting is still a question for a static site: it posts manifests like any other.
    expect(report.checks.some((check) => check.group === 'reporting')).toBe(true);
  });

  it('still scaffolds for a project it cannot classify', () => {
    writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'mystery', dependencies: { lodash: '^4' } }));

    const result = runProtect(cwd);

    expect(result.status).toBe('scaffolded');
    expect(runVerify(cwd).applicable).toBe(true);
  });
});

describe('a decisive static verdict precedes framework wiring', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-protect-sveltekit-static-'));
    // SvelteKit's adapter would recognise this project by `@sveltejs/kit` alone and write a server
    // hook — which, with the static adapter, only ever runs at prerender time.
    writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({
        name: 'site',
        devDependencies: { '@sveltejs/kit': '^2.0.0', '@sveltejs/adapter-static': '^3.0.0', svelte: '^5.0.0' },
      }),
    );
    mkdirSync(path.join(cwd, 'src'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('installs nothing into a SvelteKit site built with the static adapter', () => {
    const result = runProtect(cwd);

    expect(result.status).toBe('not-applicable');
    expect(existsSync(path.join(cwd, 'src', 'hooks.server.ts'))).toBe(false);
    expect(existsSync(path.join(cwd, 'src', 'patchstack'))).toBe(false);
  });

  it('verifies as not applicable rather than as a SvelteKit app missing its hook', () => {
    const report = runVerify(cwd);

    expect(report.applicable).toBe(false);
    expect(report.stack).toBe('static build');
  });

  it('still wires SvelteKit once the static adapter is gone', () => {
    writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'site', devDependencies: { '@sveltejs/kit': '^2.0.0', svelte: '^5.0.0' } }),
    );

    expect(runProtect(cwd).status).not.toBe('not-applicable');
    expect(runVerify(cwd).applicable).toBe(true);
  });
});
