// Local-registry mode (`run.mjs --local`): the agent installs THIS checkout instead of the published
// package, through the same `npm install @patchstack/connect` / `npx @patchstack/connect` it would run
// against npm. The install prompt is unchanged; only the registry the package managers resolve against is.
//
// - packLocalBuild() runs `npm pack` (which runs `prepare`, i.e. the build) and re-stamps the tarball's
//   version to the patch after the published `latest`, so what the agent sees is an ordinary next release.
// - startLocalRegistry() serves that one package and forwards every other request to the upstream registry,
//   so the agent's other installs, `npm view` of unrelated packages and audit lookups behave normally.
// - registryEnv() is the environment that points npm, npx, pnpm and bun at the local registry, with a fresh
//   cache so a previously cached published copy cannot be resolved instead.
//
// What this cannot reproduce: npm registry signatures and provenance attestations. The local tarball has
// neither, so `npm audit signatures` and provenance checks report it as unsigned. A refusal citing that is a
// property of this mode, not of the docs under test.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const PACKAGE_NAME = '@patchstack/connect';
export const DEFAULT_UPSTREAM = 'https://registry.npmjs.org';

// Never forwarded upstream: hop-by-hop headers, and credentials, which belong to whatever registry the
// agent's npm config names and must not be relayed to another one.
const DROPPED_REQUEST_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'authorization', 'cookie']);
// fetch() has already decoded the body, so the upstream's encoding and length no longer describe it.
const DROPPED_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

/** The patch release after `version`, ignoring any prerelease suffix. */
export function nextPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!match) throw new Error(`Not a semver version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/** The published `latest` for the package, or null when the upstream cannot be reached. */
export async function publishedLatest(upstream = DEFAULT_UPSTREAM) {
  try {
    const response = await fetch(`${upstream}/${PACKAGE_NAME.replace('/', '%2f')}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    return (await response.json())['dist-tags']?.latest ?? null;
  } catch {
    return null;
  }
}

/**
 * Rewrite the version inside an npm tarball. Returns the new tarball's bytes and the files the harness
 * needs from it: the manifest the registry serves, and the AGENT-INSTALL.md a round must have unpacked.
 */
export function restampTarball(tarballPath, version) {
  const stage = mkdtempSync(path.join(tmpdir(), 'ps-local-pack-'));
  try {
    execFileSync('tar', ['-xzf', tarballPath, '-C', stage]);
    const manifestPath = path.join(stage, 'package', 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.version = version;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const out = path.join(stage, 'restamped.tgz');
    execFileSync('tar', ['-czf', out, '-C', stage, 'package']);
    let docs = null;
    try { docs = readFileSync(path.join(stage, 'package', 'AGENT-INSTALL.md'), 'utf8'); } catch { /* checked by the caller */ }
    return { tarball: readFileSync(out), manifest, docs };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function gitDescribe(repoRoot) {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim() !== '';
    return { sha, dirty };
  } catch {
    return { sha: null, dirty: null };
  }
}

/** Build and pack the checkout at `repoRoot`, stamped as the next release after the published one. */
export async function packLocalBuild({ repoRoot, upstream = DEFAULT_UPSTREAM }) {
  const out = mkdtempSync(path.join(tmpdir(), 'ps-local-tgz-'));
  try {
    execFileSync('npm', ['pack', '--pack-destination', out], { cwd: repoRoot, stdio: 'pipe' });
    const file = readdirSync(out).find((name) => name.endsWith('.tgz'));
    if (!file) throw new Error('npm pack produced no tarball');
    const latest = await publishedLatest(upstream);
    const packedVersion = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
    const version = latest !== null ? nextPatch(latest) : packedVersion;
    const build = restampTarball(path.join(out, file), version);
    if (!build.docs) throw new Error('The packed tarball has no AGENT-INSTALL.md');
    return { ...build, version, publishedLatest: latest, git: gitDescribe(repoRoot) };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** npm's registry document for a single-version package. */
export function packument({ manifest, tarball }, registryUrl) {
  const name = manifest.name;
  const version = manifest.version;
  const basename = name.split('/').pop();
  const now = new Date().toISOString();
  return {
    _id: name,
    name,
    description: manifest.description,
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        ...manifest,
        _id: `${name}@${version}`,
        dist: {
          tarball: `${registryUrl}/${name}/-/${basename}-${version}.tgz`,
          shasum: createHash('sha1').update(tarball).digest('hex'),
          integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
        },
      },
    },
    time: { created: now, modified: now, [version]: now },
    repository: manifest.repository,
    license: manifest.license,
    readme: '',
  };
}

/** Which local resource a request path names, or null to forward it upstream. */
export function routeLocal(urlPath, manifest) {
  const pathname = decodeURIComponent(urlPath.split('?')[0]);
  const name = manifest.name;
  if (pathname === `/${name}`) return { kind: 'packument' };
  if (pathname === `/${name}/latest` || pathname === `/${name}/${manifest.version}`) return { kind: 'version' };
  if (pathname === `/${name}/-/${name.split('/').pop()}-${manifest.version}.tgz`) return { kind: 'tarball' };
  // Any other version of this package does not exist here, rather than resolving to the published one.
  if (pathname.startsWith(`/${name}/`)) return { kind: 'missing' };
  return null;
}

/**
 * Serve `build` on 127.0.0.1 and forward everything else to `upstream`. Each request is appended to
 * `requests` as { method, url, served: 'local' | 'upstream' | 'error' }.
 */
export function startLocalRegistry({ build, upstream = DEFAULT_UPSTREAM, port = 0 }) {
  const requests = [];
  let url = null;

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const route = routeLocal(req.url ?? '/', build.manifest);
      if (route !== null) {
        requests.push({ method: req.method, url: req.url, served: 'local' });
        if (route.kind === 'tarball') {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': build.tarball.length });
          res.end(build.tarball);
          return;
        }
        if (route.kind === 'missing') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        const doc = packument(build, url);
        const body = route.kind === 'packument' ? doc : doc.versions[build.manifest.version];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }

      try {
        const headers = Object.fromEntries(
          Object.entries(req.headers).filter(([key]) => !DROPPED_REQUEST_HEADERS.has(key.toLowerCase())),
        );
        const response = await fetch(`${upstream}${req.url}`, {
          method: req.method,
          headers,
          body: chunks.length > 0 && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined,
          redirect: 'follow',
        });
        const body = Buffer.from(await response.arrayBuffer());
        const responseHeaders = {};
        response.headers.forEach((value, key) => {
          if (!DROPPED_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders[key] = value;
        });
        requests.push({ method: req.method, url: req.url, served: 'upstream', status: response.status });
        res.writeHead(response.status, responseHeaders);
        res.end(body);
      } catch (error) {
        requests.push({ method: req.method, url: req.url, served: 'error' });
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `upstream unreachable: ${error.cause?.code ?? error.message}` }));
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      url = `http://127.0.0.1:${server.address().port}`;
      resolve({ url, requests, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

/** Environment that resolves npm, npx, pnpm and bun installs through `registryUrl`, with a fresh cache. */
export function registryEnv(registryUrl, cacheDir) {
  return {
    npm_config_registry: `${registryUrl}/`,
    NPM_CONFIG_REGISTRY: `${registryUrl}/`,
    BUN_CONFIG_REGISTRY: `${registryUrl}/`,
    npm_config_cache: path.join(cacheDir, 'npm'),
    BUN_INSTALL_CACHE_DIR: path.join(cacheDir, 'bun'),
    npm_config_store_dir: path.join(cacheDir, 'pnpm-store'),
  };
}
