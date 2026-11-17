import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);
const root = resolve();
const cli = join(root, 'dist/cli.js');
const sites = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const artifact = 'deployment.json';

function makeApp(cwd: string, route: string) {
  mkdirSync(join(cwd, 'node_modules/@patchstack'), { recursive: true });
  symlinkSync(root, join(cwd, 'node_modules/@patchstack/connect'), 'junction');
  symlinkSync(join(root, 'node_modules/express'), join(cwd, 'node_modules/express'), 'junction');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({
    name: 'hosted-fixture', type: 'module', dependencies: { express: '5.3.0' },
  }));
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify({
    name: 'hosted-fixture', version: '1.0.0', lockfileVersion: 3,
    packages: { '': { name: 'hosted-fixture' }, 'node_modules/express': { version: '5.3.0' } },
  }));
  writeFileSync(join(cwd, 'server.js'), `
    import express from 'express';
    import { expressProtection, protection } from '@patchstack/connect/register';

    const app = express();
    app.use(express.json());
    app.use(expressProtection);
    app.post('${route}', (req, res) => res.json({ label: req.body.label }));

    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => server.once('listening', resolve).once('error', reject));
    try {
      const results = [];
      for (const label of ['site-1', 'site-2', 'ordinary']) {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '${route}', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'fixture.example' },
          body: JSON.stringify({ label }),
        });
        results.push(response.status);
        if (response.ok && (await response.json()).label !== label) throw new Error('Unexpected app response');
      }
      console.log(JSON.stringify({ results, status: protection.synchronization }));
    } finally {
      server.close();
      await protection.stop();
    }
  `);
}

it.skipIf(!existsSync(join(root, 'dist/register.js')))('reports, deploys and rolls back isolated hosted apps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hosted-connect-'));
  const requests: { action: string; site: string; body: Record<string, unknown> }[] = [];
  const maps = new Map<string, string>();
  let rejectUpload = false;
  let rulesUnavailable = false;
  const api = createServer(async (req, res) => {
    const [, , , action, site] = (req.url ?? '').split('/');
    let input = '';
    for await (const chunk of req) input += chunk;
    const body = input ? JSON.parse(input) : {};
    const send = (code: number, data: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.url === '/api/logs/log') return send(200, { result: 'accepted' });
    if (action === 'token' && body.client_secret === 'synthetic-key' && ['1', '2'].includes(body.client_id)) {
      return send(200, { access_token: 'fixture-' + body.client_id });
    }
    const client = sites.indexOf(site!) + 1;
    if (!client || req.headers.authorization !== 'Bearer fixture-' + client) return send(401, {});
    requests.push({ action: action!, site: site!, body });
    if (action === 'manifest') return send(200, { uuid: site, stored: true });
    if (action === 'input-map') {
      if (rejectUpload) return send(503, {});
      maps.set(site!, body.build_id);
      return send(200, { result: 'stored', revision: 1 });
    }
    if (action === 'rules') {
      if (rulesUnavailable) return send(503, {});
      const build = maps.get(site!);
      if (build && req.headers['x-patchstack-build'] === build) {
        res.setHeader('X-Patchstack-Build-Match', 'match');
        res.setHeader('X-Patchstack-Build-ID', build);
        res.setHeader('X-Patchstack-Map-Rules', 'ready');
      }
      return send(200, { firewall: [{
        id: 'fixture-' + client, build_scope: build,
        rule_v2: [{ parameter: 'post.label', match: { type: 'equals', value: 'site-' + client } }],
      }], whitelists: [], whitelist_keys: {} });
    }
    if (action === 'live' || action === 'detections') return send(200, { result: 'accepted' });
    return send(404, {});
  });
  try {
    await new Promise<void>((done, reject) => api.once('error', reject).listen(0, '127.0.0.1', done));
    const base = 'http://127.0.0.1:' + (api.address() as AddressInfo).port + '/monitor/pulse';
    const options = (cwd: string, site: number, nodeOptions = '') => ({
      cwd, timeout: 15_000,
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        NODE_OPTIONS: nodeOptions,
        PATCHSTACK_ENDPOINT: base + '/manifest', PATCHSTACK_PULSE_RULES_URL: base + '/',
        PATCHSTACK_API_KEY: 'synthetic-key-' + (site + 1), PATCHSTACK_SITE_UUID: sites[site],
        PATCHSTACK_ENVIRONMENT: 'production', PATCHSTACK_MODE: 'block', PATCHSTACK_DEPLOYMENT_FILE: artifact,
      },
    });
    const deploy = async (cwd: string, site: number) => {
      const env = options(cwd, site);
      // The explicit deployment path must also work from a host's npm prebuild hook.
      await run(process.execPath, [cli, 'prepare-deploy'], {
        ...env, env: { ...env.env, npm_lifecycle_event: 'prebuild' },
      });
      const data = readFileSync(join(cwd, artifact), 'utf8');
      expect(data).not.toContain('synthetic-key');
      return JSON.parse(data);
    };
    const start = async (cwd: string, site: number) => {
      const { stdout } = await run(process.execPath, ['server.js'],
        options(cwd, site, '--import=@patchstack/connect/register'));
      return JSON.parse(stdout.trim().split('\n').at(-1)!);
    };

    const a = join(dir, 'a');
    const b = join(dir, 'b');
    makeApp(a, '/submit');
    makeApp(b, '/submit');
    const [first, second] = await Promise.all([deploy(a, 0), deploy(b, 1)]);
    const [liveA, liveB] = await Promise.all([start(a, 0), start(b, 1)]);
    expect(liveA).toMatchObject({ results: [403, 200, 200], status: { siteUuid: sites[0], matched: true, buildId: first.buildId } });
    expect(liveB).toMatchObject({ results: [200, 403, 200], status: { siteUuid: sites[1], matched: true, buildId: second.buildId } });
    for (const [index, deployment] of [first, second].entries()) {
      const site = sites[index];
      expect(requests).toContainEqual(expect.objectContaining({ action: 'manifest', site,
        body: expect.objectContaining({ packages: expect.arrayContaining([{ name: 'express', version: '5.3.0' }]) }) }));
      expect(requests).toContainEqual(expect.objectContaining({ action: 'input-map', site,
        body: expect.objectContaining({ build_id: deployment.buildId, endpoints: expect.arrayContaining([
          expect.objectContaining({ route: '/submit' }),
        ]) }) }));
      expect(requests).toContainEqual(expect.objectContaining({ action: 'live', site,
        body: expect.objectContaining({ checksum: deployment.manifestChecksum }) }));
      expect(requests).toContainEqual(expect.objectContaining({ action: 'detections', site,
        body: expect.objectContaining({ detections: expect.arrayContaining([
          expect.objectContaining({ rule_id: 'fixture-' + (index + 1), enforced: true }),
        ]) }) }));
    }
    const egressOptions = options(a, 0, '--import=@patchstack/connect/register');
    await run(process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import { protection } from '@patchstack/connect/register';
      assert.equal((await protection.refresh()).ok, true);
      assert.equal(protection.synchronization.matched, true);
      await assert.rejects(fetch(process.env.PATCHSTACK_PULSE_RULES_URL), /blocked an outbound request/);
      await protection.stop();
    `], { ...egressOptions, env: { ...egressOptions.env, PATCHSTACK_EGRESS: '1' } });

    await expect(start(a, 1)).rejects.toThrow('must contain a completed build for PATCHSTACK_SITE_UUID');
    rulesUnavailable = true;
    expect(await start(a, 0)).toMatchObject({ results: [403, 200, 200], status: { source: { origin: 'cache', ok: false } } });
    rulesUnavailable = false;

    const next = join(dir, 'a-next');
    makeApp(next, '/submit-v2');
    const updated = await deploy(next, 0);
    expect(updated.buildId).not.toBe(first.buildId);
    expect(await start(next, 0)).toMatchObject({ results: [403, 200, 200], status: { matched: true, buildId: updated.buildId } });
    expect(await start(a, 0)).toMatchObject({ results: [200, 200, 200], status: { matched: false, buildId: first.buildId } });

    const buildOptions = options(a, 0);
    await run(process.execPath, [cli, 'prepare-deploy', '--out', 'other.json'], buildOptions);
    expect(JSON.parse(readFileSync(join(a, 'other.json'), 'utf8'))).toEqual(first);
    await expect(run(process.execPath, [cli, 'prepare-deploy', '--out'], buildOptions)).rejects.toThrow('--out requires');
    expect(JSON.parse(readFileSync(join(a, artifact), 'utf8'))).toEqual(first);
    await expect(run(process.execPath, [cli, 'prepare-deploy'], {
      ...buildOptions, env: { ...buildOptions.env, PATCHSTACK_API_KEY: undefined },
    })).rejects.toThrow('requires PATCHSTACK_SITE_UUID and PATCHSTACK_API_KEY');
    expect(readFileSync(join(a, artifact), 'utf8')).toBe('null\n');

    rejectUpload = true;
    await expect(deploy(next, 0)).rejects.toThrow('no deployment metadata was produced');
    await expect(start(next, 0)).rejects.toThrow('must contain a completed build for PATCHSTACK_SITE_UUID');
  } finally {
    await new Promise<void>((done) => {
      api.close(() => done());
      api.closeAllConnections();
    });
    rmSync(dir, { recursive: true, force: true });
  }
}, 25_000);
