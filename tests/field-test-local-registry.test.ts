import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  nextPatch,
  registryEnv,
  restampTarball,
  routeLocal,
  startLocalRegistry,
} from '../field-test/local-registry.mjs';

const manifest = { name: '@patchstack/connect', version: '9.9.9', description: 'Synthetic.' };
const build = { manifest, tarball: Buffer.from('synthetic tarball bytes'), docs: 'Synthetic docs.' };
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function startUpstream() {
  const seen: Array<{ url?: string; headers: IncomingHttpHeaders }> = [];
  const server: Server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ upstream: req.url }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
  return { url: `http://127.0.0.1:${address.port}`, seen };
}

async function startRegistry(upstream: string) {
  const registry = await startLocalRegistry({ build, upstream });
  cleanups.push(registry.close);
  return registry;
}

describe('nextPatch', () => {
  it('bumps the patch and drops a prerelease suffix', () => {
    expect(nextPatch('0.5.34')).toBe('0.5.35');
    expect(nextPatch('1.2.3-rc.1')).toBe('1.2.4');
    expect(() => nextPatch('latest')).toThrow();
  });
});

describe('routeLocal', () => {
  it('claims every path of the package under test and nothing else', () => {
    expect(routeLocal('/@patchstack%2fconnect', manifest)).toEqual({ kind: 'packument' });
    expect(routeLocal('/@patchstack%2Fconnect', manifest)).toEqual({ kind: 'packument' });
    expect(routeLocal('/@patchstack/connect', manifest)).toEqual({ kind: 'packument' });
    expect(routeLocal('/@patchstack/connect/latest', manifest)).toEqual({ kind: 'version' });
    expect(routeLocal('/@patchstack/connect/-/connect-9.9.9.tgz', manifest)).toEqual({ kind: 'tarball' });
    expect(routeLocal('/@patchstack/connect/-/connect-0.5.34.tgz', manifest)).toEqual({ kind: 'missing' });
    expect(routeLocal('/@patchstack/connect-other', manifest)).toBeNull();
    expect(routeLocal('/react', manifest)).toBeNull();
  });
});

describe('local registry', () => {
  it('serves the build with an integrity that matches the tarball it serves', async () => {
    const upstream = await startUpstream();
    const registry = await startRegistry(upstream.url);

    const doc = await (await fetch(`${registry.url}/@patchstack%2fconnect`)).json();
    expect(doc['dist-tags'].latest).toBe('9.9.9');
    const dist = doc.versions['9.9.9'].dist;
    expect(dist.tarball).toBe(`${registry.url}/@patchstack/connect/-/connect-9.9.9.tgz`);

    const bytes = Buffer.from(await (await fetch(dist.tarball)).arrayBuffer());
    expect(bytes.equals(build.tarball)).toBe(true);
    expect(dist.integrity).toBe(`sha512-${createHash('sha512').update(bytes).digest('base64')}`);
    expect(upstream.seen).toHaveLength(0);
  });

  it('does not fall back to the upstream for another version of the package', async () => {
    const upstream = await startUpstream();
    const registry = await startRegistry(upstream.url);
    const response = await fetch(`${registry.url}/@patchstack/connect/-/connect-0.5.34.tgz`);
    expect(response.status).toBe(404);
    expect(upstream.seen).toHaveLength(0);
  });

  it('forwards other packages upstream without relaying credentials', async () => {
    const upstream = await startUpstream();
    const registry = await startRegistry(upstream.url);
    const response = await fetch(`${registry.url}/react`, {
      headers: { authorization: 'Bearer synthetic-token', cookie: 'a=b', 'npm-command': 'install' },
    });
    expect(await response.json()).toEqual({ upstream: '/react' });
    expect(upstream.seen[0].headers.authorization).toBeUndefined();
    expect(upstream.seen[0].headers.cookie).toBeUndefined();
    expect(upstream.seen[0].headers['npm-command']).toBe('install');
    expect(registry.requests).toEqual([{ method: 'GET', url: '/react', served: 'upstream', status: 200 }]);
  });

  it('answers 502 when the upstream is unreachable', async () => {
    const registry = await startRegistry('http://127.0.0.1:1');
    expect((await fetch(`${registry.url}/react`)).status).toBe(502);
    expect(registry.requests[0].served).toBe('error');
  });
});

describe('restampTarball', () => {
  it('rewrites the version and returns the packed docs', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'restamp-test-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, 'package'));
    writeFileSync(path.join(dir, 'package', 'package.json'), JSON.stringify(manifest));
    writeFileSync(path.join(dir, 'package', 'AGENT-INSTALL.md'), 'Synthetic docs.');
    const tgz = path.join(dir, 'in.tgz');
    execFileSync('tar', ['-czf', tgz, '-C', dir, 'package']);

    const result = restampTarball(tgz, '1.0.1');
    expect(result.manifest.version).toBe('1.0.1');
    expect(result.docs).toBe('Synthetic docs.');

    const out = path.join(dir, 'out');
    mkdirSync(out);
    writeFileSync(path.join(dir, 'out.tgz'), result.tarball);
    execFileSync('tar', ['-xzf', path.join(dir, 'out.tgz'), '-C', out]);
    expect(execFileSync('node', ['-p', "require('./package/package.json').version"], { cwd: out, encoding: 'utf8' }).trim()).toBe('1.0.1');
  });
});

describe('registryEnv', () => {
  it('points every package manager at the registry with caches under the given directory', () => {
    const env = registryEnv('http://127.0.0.1:4873', '/tmp/cache');
    expect(env.npm_config_registry).toBe('http://127.0.0.1:4873/');
    expect(env.BUN_CONFIG_REGISTRY).toBe('http://127.0.0.1:4873/');
    for (const key of ['npm_config_cache', 'BUN_INSTALL_CACHE_DIR', 'npm_config_store_dir'] as const) {
      expect(env[key].startsWith('/tmp/cache/')).toBe(true);
    }
  });
});
