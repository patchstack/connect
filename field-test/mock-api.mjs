// Mock of the Patchstack manifest API for field-testing the install flow
// without provisioning real sites. Importable (startMockApi) or standalone
// (`node mock-api.mjs [port]`).
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * Start the mock API on 127.0.0.1. Returns { port, uuid, requests, close }.
 * - POST /monitor/pulse/manifest            → provision: { uuid, stored: true, ... }
 * - POST /monitor/pulse/manifest/<uuid>     → re-scan:   { uuid, stored: false, reason: 'duplicate' }
 * - anything else                           → a placeholder claim page
 * Every request is appended to `requests` as { method, url, body }.
 */
export function startMockApi({ port = 0, uuid = randomUUID() } = {}) {
  const requests = [];

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: body.slice(0, 4000) });

      if (req.method === 'POST' && req.url === '/monitor/pulse/manifest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ uuid, stored: true, manifest_id: 101, checksum: 'deadbeefcafe' }));
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
  const mock = await startMockApi({ port: Number(process.argv[2] ?? 0) });
  console.log(`mock patchstack api on ${mock.endpoint} (site uuid ${mock.uuid})`);
}
