#!/usr/bin/env bun

import { buildWirePayload } from '../src/normalize.ts';
import { scanLockfile } from '../src/parsers/index.ts';

const DEFAULT_URL = 'https://api.patchstack.com/monitor/pulse/manifest';
const DEFAULT_TIMEOUT_MS = 30_000;

type TestEnvironment = 'production' | 'sandbox';

interface Options {
  url: string;
  siteUuid?: string;
  provisioning: boolean;
  timeoutMs: number;
  environment: TestEnvironment;
  dryRun: boolean;
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));

  const manifest = await scanLockfile(process.cwd());
  for (const warning of manifest.warnings ?? []) {
    console.warn(`patchstack test: ${warning}`);
  }

  const { payload, stats } = buildWirePayload(manifest);
  const body = { ...payload, environment: options.environment };

  console.log(`Manifest test URL: ${options.url}`);
  console.log(`Site UUID:         ${options.siteUuid ?? '(auto-provision)'}`);
  console.log(`Environment:       ${options.environment}`);
  console.log(
    `Payload:           ${payload.packages.length} package version(s), ${stats.uniqueNames} package name(s)`,
  );

  if (options.dryRun) {
    console.log('');
    console.log('--dry-run: not posting. Payload preview:');
    printPayloadPreview(body);
    return 0;
  }

  const response = await fetch(options.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': '@patchstack/connect manifest-test',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs),
  });

  const text = await response.text();
  const responseBody = parseResponseBody(text);
  console.log('');
  console.log(`Response: ${response.status} ${response.statusText}`);
  if (text.length > 0) {
    console.log(formatResponseBody(text, responseBody));
  }

  if (response.ok && options.provisioning) {
    const uuid = getResponseUuid(responseBody);
    if (uuid !== null) {
      console.log('');
      console.log(`Provisioned site UUID: ${uuid}`);
      console.log(
        `Re-test this site with: bun run test:manifest -- --endpoint ${stripSiteUuidFromManifestUrl(options.url)} --site-uuid ${uuid}`,
      );
    }
  }

  return response.ok ? 0 : 1;
}

function parseOptions(args: string[]): Options {
  let url =
    process.env.PATCHSTACK_TEST_MANIFEST_URL ??
    process.env.PATCHSTACK_ENDPOINT ??
    DEFAULT_URL;
  let siteUuid =
    process.env.PATCHSTACK_TEST_SITE_UUID ??
    process.env.PATCHSTACK_SITE_UUID;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }

    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (arg === '--url' || arg === '--endpoint') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${arg} requires a URL value.`);
      }
      url = next;
      i++;
      continue;
    }

    if (arg === '--site-uuid') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${arg} requires a UUID value.`);
      }
      siteUuid = next;
      i++;
      continue;
    }

    if (arg.startsWith('--url=')) {
      url = arg.slice('--url='.length);
      continue;
    }

    if (arg.startsWith('--endpoint=')) {
      url = arg.slice('--endpoint='.length);
      continue;
    }

    if (arg.startsWith('--site-uuid=')) {
      siteUuid = arg.slice('--site-uuid='.length);
      continue;
    }

    if (!arg.startsWith('--')) {
      url = arg;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  validateUrl(url);
  siteUuid = siteUuid !== undefined && siteUuid.length > 0 ? siteUuid : undefined;
  const provisioning = siteUuid === undefined;
  const finalUrl = provisioning ? stripSiteUuidFromManifestUrl(url) : addSiteUuidToUrl(url, siteUuid);

  return {
    url: finalUrl,
    siteUuid,
    provisioning,
    timeoutMs: readTimeoutMs(),
    environment: readEnvironment(),
    dryRun,
  };
}

function readTimeoutMs(): number {
  const raw = process.env.PATCHSTACK_TIMEOUT_MS;
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_TIMEOUT_MS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`PATCHSTACK_TIMEOUT_MS must be a positive number; got "${raw}".`);
  }
  return parsed;
}

function readEnvironment(): TestEnvironment {
  const value =
    process.env.PATCHSTACK_TEST_ENVIRONMENT ??
    process.env.PATCHSTACK_ENVIRONMENT ??
    'sandbox';

  if (value === 'production' || value === 'sandbox') {
    return value;
  }

  throw new Error(
    `PATCHSTACK_TEST_ENVIRONMENT must be "production" or "sandbox"; got "${value}".`,
  );
}

function validateUrl(value: string): void {
  try {
    new URL(value);
  } catch {
    throw new Error(`Manifest test URL must be a full URL; got "${value}".`);
  }
}

function addSiteUuidToUrl(value: string, siteUuid: string): string {
  const parsed = new URL(value);
  const encodedUuid = encodeURIComponent(siteUuid);
  const trimmedPath = parsed.pathname.replace(/\/+$/, '');

  if (trimmedPath.endsWith('/monitor/pulse/manifest')) {
    parsed.pathname = `${trimmedPath}/${encodedUuid}`;
    return parsed.toString();
  }

  if (/\/monitor\/pulse\/manifest\/[^/]+$/.test(trimmedPath)) {
    parsed.pathname = trimmedPath.replace(/\/[^/]+$/, `/${encodedUuid}`);
    return parsed.toString();
  }

  parsed.pathname = `${trimmedPath}/${encodedUuid}`;
  return parsed.toString();
}

function stripSiteUuidFromManifestUrl(value: string): string {
  const parsed = new URL(value);
  const trimmedPath = parsed.pathname.replace(/\/+$/, '');

  if (/\/monitor\/pulse\/manifest\/[^/]+$/.test(trimmedPath)) {
    parsed.pathname = trimmedPath.replace(/\/[^/]+$/, '');
    return parsed.toString();
  }

  return value;
}

function parseResponseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function formatResponseBody(text: string, parsedBody: unknown): string {
  if (parsedBody === null) {
    return text;
  }
  return JSON.stringify(parsedBody, null, 2);
}

function getResponseUuid(parsedBody: unknown): string | null {
  if (
    typeof parsedBody === 'object' &&
    parsedBody !== null &&
    'uuid' in parsedBody &&
    typeof parsedBody.uuid === 'string' &&
    parsedBody.uuid.length > 0
  ) {
    return parsedBody.uuid;
  }
  return null;
}

function printPayloadPreview(body: unknown): void {
  const preview = JSON.stringify(body, null, 2).split('\n');
  console.log(preview.slice(0, Math.min(preview.length, 30)).join('\n'));
  if (preview.length > 30) {
    console.log(`  ... (${preview.length - 30} more lines)`);
  }
}

function printHelp(): void {
  console.log(`Usage:
  bun run test:manifest [url]
  bun run test:manifest -- --url <url>
  bun run test:manifest -- --site-uuid <uuid>

Environment:
  PATCHSTACK_TEST_MANIFEST_URL  Full URL to POST to
  PATCHSTACK_TEST_SITE_UUID     Existing site UUID to append to the endpoint
  PATCHSTACK_TEST_ENVIRONMENT   production | sandbox (default: sandbox)
  PATCHSTACK_TIMEOUT_MS         Request timeout in ms (default: 30000)

If no site UUID is provided, the script posts to the bare manifest endpoint so
the API can provision a new site and return its UUID.

Examples:
  bun run test:manifest
  bun run test:manifest -- --endpoint http://localhost:8000/monitor/pulse/manifest
  bun run test:manifest -- --endpoint http://localhost:8000/monitor/pulse/manifest --site-uuid 550e8400-e29b-41d4-a716-446655440000
`);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`Manifest test failed: ${(error as Error).message}`);
    process.exitCode = 1;
  },
);
