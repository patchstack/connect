// Mock of the Patchstack manifest API for field-testing the install flow
// without provisioning real sites. Importable (startMockApi) or standalone
// (`node mock-api.mjs [port]`).
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * Start the mock API on 127.0.0.1. Returns { port, uuid, requests, close }.
 * - POST /monitor/pulse/manifest            → provision: { uuid, stored: true, ... }
 * - POST /monitor/pulse/manifest/<uuid>     → re-scan:   { uuid, stored: false, reason: 'duplicate' }
 * - POST /monitor/pulse/build/<uuid>        → keyless build report: { result: 'reported' }
 * - anything else                           → a placeholder claim page
 * Every request is appended to `requests` as { method, url, body }; `onManifest(url, body)` sees each
 * manifest and build-report post in full.
 */
export function startMockApi({ port = 0, uuid = randomUUID(), onManifest = null } = {}) {
  const requests = [];
  let mappedBuild = null;

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: body.slice(0, 4000), buildId: req.headers['x-patchstack-build'] ?? null });
      if (onManifest && req.method === 'POST' && /^\/monitor\/pulse\/(?:manifest|build\/)/.test(req.url ?? '')) onManifest(req.url, body);

      if (req.method === 'POST' && req.url === '/monitor/pulse/token') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'synthetic-field-token', expires_in: 3600 }));
        return;
      }
      if (req.method === 'POST' && req.url === `/monitor/pulse/input-map/${uuid}`) {
        try { mappedBuild = JSON.parse(body).build_id ?? null; } catch { mappedBuild = null; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: 'stored', revision: 1 }));
        return;
      }
      if (req.method === 'GET' && req.url === `/monitor/pulse/rules/${uuid}`) {
        const matching = mappedBuild && req.headers['x-patchstack-build'] === mappedBuild;
        res.writeHead(200, { 'Content-Type': 'application/json',
          ...(matching ? { 'X-Patchstack-Build-Match': 'match', 'X-Patchstack-Build-ID': mappedBuild } : {}) });
        res.end(JSON.stringify({ firewall: [], whitelists: [], whitelist_keys: {} }));
        return;
      }

      if (req.method === 'POST' && req.url === `/monitor/pulse/build/${uuid}`) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: 'reported' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/monitor/pulse/manifest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ uuid, stored: true, manifest_id: 101, checksum: 'deadbeefcafe', api_key: 'synthetic-field-secret-1' }));
        return;
      }
      if (req.method === 'POST' && req.url?.startsWith('/monitor/pulse/manifest/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ uuid, stored: false, reason: 'duplicate' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>Patchstack claim page (mock)</body></html>');
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        uuid,
        requests,
        endpoint: `http://127.0.0.1:${server.address().port}/monitor/pulse/manifest`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  // Standalone, print each manifest report as it arrives, with the package list reduced to a count.
  const onManifest = (url, body) => {
    try {
      const { packages, ...rest } = JSON.parse(body);
      console.log(`POST ${url}`, { ...rest, packages: packages?.length });
    } catch {
      console.log(`POST ${url} (body is not JSON)`);
    }
  };
  const mock = await startMockApi({ port: Number(process.argv[2] ?? 0), onManifest });
  console.log(`mock patchstack api on ${mock.endpoint} (site uuid ${mock.uuid})`);
}
