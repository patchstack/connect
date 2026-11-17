import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const register = resolve('dist/register.js');
const siteUuid = '11111111-1111-4111-8111-111111111111';

describe.skipIf(!existsSync(register))('built Node preload', () => {
  function start(apiKey?: string, app = `
    const status = protection.synchronization;
    console.log(JSON.stringify({ siteUuid: status.siteUuid, rules: status.rules.request, origin: status.source.origin }));
  `) {
    const cwd = mkdtempSync(join(tmpdir(), 'ps-register-'));
    try {
      const mockService = `data:text/javascript,${encodeURIComponent(`
        const fetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
          if (new URL(url).hostname === '127.0.0.1') return fetch(url, init);
          if (new URL(url).pathname.endsWith('/token')) {
            return Response.json({ access_token: 'synthetic-token' });
          }
          if (new URL(url).pathname === '/monitor/pulse/rules/${siteUuid}'
              && new Headers(init?.headers).get('authorization') === 'Bearer synthetic-token') {
            globalThis.fixtureRulesLoaded = true;
            return Response.json({ firewall: [{
              id: 'fixture-rule',
              rule_v2: [{ parameter: 'post.label', match: { type: 'equals', value: 'fixture-block' } }]
            }, {
              id: 'fixture-mask',
              phase: 'response',
              action: 'redact',
              rule_v2: [{ parameter: 'response.header.x-fixture', match: { type: 'regex', value: '/fixture-value/' } }]
            }], whitelists: [], whitelist_keys: {} });
          }
          throw new Error('Unexpected service request');
        };
      `)}`;
      const entry = pathToFileURL(register).href;
      return spawnSync(process.execPath, ['--input-type=module', '--eval', `
        if (!globalThis.fixtureRulesLoaded) throw new Error('Rules were not loaded before the app started');
        const { protection, expressProtection } = await import(${JSON.stringify(entry)});
        ${app}
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
          PATCHSTACK_DEPLOYMENT_FILE: undefined,
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

  it('screens parsed requests and responses through an Express middleware mount', () => {
    const child = start('synthetic-key-1', `
      const { default: express } = await import(${JSON.stringify(pathToFileURL(require.resolve('express')).href)});
      const app = express();
      app.use(express.json());
      app.use(expressProtection);
      app.post('/', (req, res) => res.set('X-Fixture', 'fixture-value').json({ label: req.body.label }));
      const server = app.listen(0, '127.0.0.1');
      await new Promise((resolve, reject) => {
        server.once('listening', resolve).once('error', reject);
      });
      try {
        const post = (label) => fetch('http://127.0.0.1:' + server.address().port, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }),
        });
        const blocked = await post('fixture-block');
        const allowed = await post('fixture-allow');
        console.log(JSON.stringify([blocked.status, allowed.status, await allowed.json(), allowed.headers.get('X-Fixture')]));
      } finally {
        server.close();
        await protection.stop();
      }
    `);
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim().split('\n').at(-1)!);
    expect(result.slice(0, 3)).toEqual([403, 200, { label: 'fixture-allow' }]);
    expect(result[3]).toEqual(expect.any(String));
    expect(result[3]).not.toContain('fixture-value');
  });

  it('reports missing host configuration before running the app', () => {
    const child = start();
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('Patchstack preload requires a valid PATCHSTACK_API_KEY');
    expect(child.stdout).toBe('');
  });
});
