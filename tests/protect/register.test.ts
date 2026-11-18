import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const register = resolve('dist/register.js');
const siteUuid = '11111111-1111-4111-8111-111111111111';

describe.skipIf(!existsSync(register))('built Node preload', () => {
  function start(apiKey?: string) {
    const cwd = mkdtempSync(join(tmpdir(), 'ps-register-'));
    try {
      const mockService = `data:text/javascript,${encodeURIComponent(`
        globalThis.fetch = async (url, init) => {
          if (new URL(url).pathname.endsWith('/token')) {
            return Response.json({ access_token: 'synthetic-token' });
          }
          if (new URL(url).pathname === '/monitor/pulse/rules/${siteUuid}'
              && new Headers(init?.headers).get('authorization') === 'Bearer synthetic-token') {
            globalThis.fixtureRulesLoaded = true;
            return Response.json({ firewall: [{
              id: 'fixture-rule',
              rule_v2: [{ parameter: 'get.label', match: { type: 'equals', value: 'fixture-block' } }]
            }], whitelists: [], whitelist_keys: {} });
          }
          throw new Error('Unexpected service request');
        };
      `)}`;
      const entry = pathToFileURL(register).href;
      return spawnSync(process.execPath, ['--input-type=module', '--eval', `
        if (!globalThis.fixtureRulesLoaded) throw new Error('Rules were not loaded before the app started');
        const { protection } = await import(${JSON.stringify(entry)});
        const status = protection.synchronization;
        console.log(JSON.stringify({ siteUuid: status.siteUuid, rules: status.rules.request, origin: status.source.origin }));
      `], {
        cwd,
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${mockService} --import=${entry}`,
          PATCHSTACK_SITE_UUID: siteUuid,
          PATCHSTACK_API_KEY: apiKey,
          PATCHSTACK_PULSE_RULES_URL: 'https://rules.example.test/monitor/pulse',
          PATCHSTACK_MODE: 'block',
          PATCHSTACK_EGRESS: '0',
        },
        encoding: 'utf8',
        timeout: 10_000,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  it('fetches the configured site policy before the app starts', () => {
    const child = start('synthetic-key-1');
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ siteUuid, rules: 1, origin: 'api' });
  });

  it('reports missing host configuration before running the app', () => {
    const child = start();
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('Patchstack preload requires a valid PATCHSTACK_API_KEY');
    expect(child.stdout).toBe('');
  });
});
