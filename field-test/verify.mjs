import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readText(file) {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

/** Source verification only: invokes the installed CLI without starting the application. */
function verifyProtection(fixtureDir, endpoint) {
  const cli = path.join(fixtureDir, 'node_modules', '@patchstack', 'connect', 'dist', 'cli.js');
  const result = spawnSync(process.execPath, [cli, 'protect', '--check'], {
    cwd: fixtureDir,
    env: { ...process.env, PATCHSTACK_ENDPOINT: endpoint, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  const output = result.stdout ?? '';
  const notApplicable = output.includes('no guard to wire — this project has no request path');
  const wired = output.includes('guard is wired ✓');
  return {
    pass: result.status === 0 && (wired || notApplicable),
    detail: result.status === 0 && notApplicable
      ? 'not applicable: no server request path; this does not establish runtime protection'
      : result.status === 0 && wired
        ? 'installed CLI verified source wiring; runtime traversal and deployment are not checked'
        : `installed protect --check did not establish wiring (exit ${result.status ?? 'unavailable'})`,
  };
}

/** Score the files and API requests left by an agent in the HTML-shell fixtures. */
export function verify(fixtureDir, mock, agentOutput, baselineScripts) {
  const pkg = readJsonSafe(path.join(fixtureDir, 'package.json')) ?? {};
  const rc = readJsonSafe(path.join(fixtureDir, '.patchstackrc.json')) ?? {};
  const scripts = pkg.scripts ?? {};
  const dep = pkg.dependencies?.['@patchstack/connect'];
  const devDep = pkg.devDependencies?.['@patchstack/connect'];
  const provisionPosts = mock.requests.filter(
    (request) => request.method === 'POST' && request.url === '/monitor/pulse/manifest',
  ).length;
  const scanWired = ['prebuild', 'build'].some((key) =>
    (scripts[key] ?? '').includes('patchstack-connect scan'),
  );
  const markWired = ['postbuild', 'build'].some((key) =>
    (scripts[key] ?? '').includes('patchstack-connect mark-build'),
  );

  const shippedDocs = path.join(fixtureDir, 'node_modules', '@patchstack', 'connect', 'AGENT-INSTALL.md');
  const packageVersion = readJsonSafe(path.join(path.dirname(shippedDocs), 'package.json'))?.version ?? null;
  let unpackedBytes = 0;
  try {
    const stat = statSync(shippedDocs);
    if (stat.isFile()) unpackedBytes = stat.size;
  } catch { /* Missing or unreadable docs cannot establish an unpacked package. */ }
  const unpacked = unpackedBytes > 0;

  // These fixtures render index.html; a UUID in configuration or a README is not widget wiring.
  const html = readText(path.join(fixtureDir, 'index.html')).replace(/<!--[\s\S]*?-->/g, '');
  const widgetTags = [...html.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]).filter(
    (tag) => /\bsrc\s*=\s*(["'])https:\/\/cdn\.patchstack\.com\/patchstack-widget\.js\1/i.test(tag),
  );
  const widgetUuid = widgetTags[0]?.match(/\bdata-site-uuid\s*=\s*(["'])(.*?)\1/i)?.[2];
  const changedDevScripts = [...new Set([...Object.keys(baselineScripts), ...Object.keys(scripts)])]
    .filter((key) => /^(?:(?:pre|post)?dev(?::|$)|(?:pre|post)?build:dev(?::|$))/.test(key))
    .filter((key) => scripts[key] !== baselineScripts[key]);
  const claimUrl = `${new URL(mock.endpoint).origin}/monitor/claim?site=${encodeURIComponent(mock.uuid)}`;
  const outputUrls = agentOutput.match(/https?:\/\/[^\s<>"'`]+/g) ?? [];

  const checks = {
    installed: {
      pass: typeof dep === 'string' && dep.length > 0 && devDep === undefined && unpacked,
      detail: !unpacked ? 'package docs were not unpacked'
        : devDep !== undefined ? 'package must be in dependencies, not devDependencies'
          : dep === undefined ? 'missing regular dependency declaration'
            : `regular dependency declared; package docs unpacked (${unpackedBytes}B)`,
    },
    provisioned: {
      pass: rc.siteUuid === mock.uuid,
      detail: rc.siteUuid === mock.uuid ? 'config carries the mock site UUID' : 'mock site UUID missing from config',
    },
    provisionedOnce: {
      pass: provisionPosts === 1,
      detail: `${provisionPosts} provisioning POST(s); expected exactly one`,
    },
    hooksWired: {
      pass: scanWired && markWired,
      detail: `scan wired=${scanWired}, mark-build wired=${markWired}`,
    },
    dependencyScanWired: {
      pass: (scripts.postinstall ?? '').includes('patchstack-connect scan'),
      detail: 'dependency-install scan present in postinstall',
    },
    devScriptsPreserved: {
      pass: changedDevScripts.length === 0,
      detail: changedDevScripts.length === 0 ? 'development scripts unchanged' : `changed: ${changedDevScripts.join(', ')}`,
    },
    sandboxNotPersisted: {
      pass: rc.environment !== 'sandbox' &&
        !Object.values(scripts).some((script) => /PATCHSTACK_ENVIRONMENT\s*=\s*["']?sandbox\b/.test(script)) &&
        !['.env', '.env.local', '.env.production', '.env.production.local'].some((file) =>
          /^\s*(?:export\s+)?PATCHSTACK_ENVIRONMENT\s*=\s*["']?sandbox\b/m.test(readText(path.join(fixtureDir, file)))),
      detail: 'no sandbox override in config, package scripts, or shared/production env files',
    },
    widgetInstalled: {
      pass: widgetTags.length === 1,
      detail: `${widgetTags.length} widget script tag(s) in the rendered HTML shell; expected one`,
    },
    widgetTokenMatches: {
      pass: widgetTags.length === 1 && widgetUuid === mock.uuid,
      detail: 'the widget tag itself carries the provisioned site UUID',
    },
    protectionVerified: verifyProtection(fixtureDir, mock.endpoint),
    claimUrlSurfaced: {
      pass: outputUrls.some((url) => {
        try {
          const parsed = new URL(url.replace(/[).,;]+$/, ''));
          return parsed.origin === new URL(claimUrl).origin && parsed.pathname === '/monitor/claim' &&
            parsed.searchParams.get('site') === mock.uuid;
        } catch { return false; }
      }),
      detail: 'the mock dashboard URL for this site appears in agent output',
    },
    noProductionLeak: {
      pass: !agentOutput.includes('api.patchstack.com/monitor/claim'),
      detail: 'no production claim URL surfaced (this does not establish network isolation)',
    },
  };
  const refused = !checks.provisioned.pass && /\b(?:refus\w*|declin\w*|stall\w*)\b/i.test(agentOutput);
  return {
    checks, refused,
    passed: Object.values(checks).filter((check) => check.pass).length,
    total: Object.keys(checks).length,
    audited: unpacked,
    packageVersion,
  };
}
