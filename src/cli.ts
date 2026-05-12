import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scanLockfile } from './parsers/index.js';
import { buildWirePayload } from './normalize.js';
import {
  buildManifestEndpoint,
  DEFAULT_API_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  postManifest,
  redeemIntegrationToken,
} from './client.js';
import { resolveConfig, writeConfigFile } from './config.js';
import { PatchstackError } from './types.js';

const HELP = `@patchstack/connect — scan your lockfile and report packages to Patchstack.

Usage:
  patchstack-connect bootstrap <token>               One-shot: redeem an integration token, save config,
                                                     add the prebuild script, and run the first scan
  patchstack-connect init <site-uuid>                Save the site UUID to .patchstackrc.json
  patchstack-connect scan   [options]                Scan lockfile and POST to Patchstack
  patchstack-connect status [options]                Show current configuration
  patchstack-connect help                            Print this message

Options (for bootstrap):
  --api-url <url>         API base URL (default: https://app.patchstack.com/monitor)
  --url <url>             Optional site URL to register (e.g. https://my-app.lovable.app)
  --app-type <type>       Optional app type label (e.g. lovable, bolt-diy)
  --skip-prebuild         Do not patch package.json
  --skip-scan             Do not run an initial scan after bootstrap

Options (for scan and status):
  --site-uuid <uuid>      Override the configured site UUID
  --endpoint <url>        Override the API endpoint
  --dry-run               (scan only) Show the payload without posting

Environment:
  PATCHSTACK_SITE_UUID    Site UUID
  PATCHSTACK_ENDPOINT     API endpoint (default: https://app.patchstack.com/monitor/pulse/manifest)
  PATCHSTACK_API_URL      API base URL (default: https://app.patchstack.com/monitor)
  PATCHSTACK_TIMEOUT_MS   Request timeout in ms (default: 30000)

Precedence: CLI flag > environment variable > .patchstackrc.json.

Examples:
  npx @patchstack/connect bootstrap ac963c7608a8c527aac8a14bd92c0e519b84ff63400063a4e10e7e6c02b308d3
  npx @patchstack/connect init 550e8400-e29b-41d4-a716-446655440000
  npx @patchstack/connect scan
  npx @patchstack/connect scan --dry-run
`;

const VALUE_FLAGS = new Set(['site-uuid', 'endpoint', 'api-url', 'url', 'app-type']);

interface ParsedArgs {
  command: string | null;
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const stripped = arg.slice(2);
    const eqIdx = stripped.indexOf('=');
    if (eqIdx !== -1) {
      flags.set(stripped.slice(0, eqIdx), stripped.slice(eqIdx + 1));
      continue;
    }
    const next = args[i + 1];
    if (VALUE_FLAGS.has(stripped) && next !== undefined && !next.startsWith('--')) {
      flags.set(stripped, next);
      i++;
    } else {
      flags.set(stripped, true);
    }
  }

  return {
    command: positional.shift() ?? null,
    positional,
    flags,
  };
}

function getStringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

async function runInit(args: ParsedArgs): Promise<number> {
  const uuid = args.positional[0];
  if (!uuid) {
    console.error('Error: site UUID is required.\n');
    console.error('Usage: patchstack-connect init <site-uuid>');
    return 1;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    console.error(`Error: "${uuid}" does not look like a valid UUID.`);
    return 1;
  }

  const target = await writeConfigFile(process.cwd(), { siteUuid: uuid });
  console.log(`Wrote ${target}`);
  console.log('');
  console.log('Next: run `npx @patchstack/connect scan` to send your first manifest.');
  return 0;
}

async function runScan(args: ParsedArgs): Promise<number> {
  const dryRun = args.flags.get('dry-run') === true;
  const config = await resolveConfig({
    cwd: process.cwd(),
    cliSiteUuid: getStringFlag(args.flags, 'site-uuid'),
    cliEndpoint: getStringFlag(args.flags, 'endpoint'),
  });
  const manifest = await scanLockfile(process.cwd());
  const { payload, stats } = buildWirePayload(manifest);

  console.log(
    `Found ${payload.packages.length} unique package versions across ${stats.uniqueNames} package names in ${manifest.ecosystem} lockfile.`,
  );
  if (stats.duplicateNames.length > 0) {
    console.log(`${stats.duplicateNames.length} package(s) appear at multiple versions:`);
    if (stats.duplicateNames.length <= 10) {
      console.log(`  ${stats.duplicateNames.join(', ')}`);
    }
  }

  if (dryRun) {
    console.log('');
    console.log('--dry-run: not posting to Patchstack. Payload preview:');
    const preview = JSON.stringify(payload, null, 2).split('\n');
    console.log(preview.slice(0, Math.min(preview.length, 30)).join('\n'));
    if (preview.length > 30) {
      console.log(`  ... (${preview.length - 30} more lines)`);
    }
    return 0;
  }

  const response = await postManifest(config, payload);
  if (response.stored) {
    console.log(`Stored manifest #${response.manifest_id} (checksum ${response.checksum}).`);
  } else if (response.reason === 'duplicate') {
    console.log('Manifest unchanged since last scan — nothing to store.');
  } else {
    console.log(`Server response: ${response.message ?? JSON.stringify(response)}`);
  }
  return 0;
}

async function runStatus(args: ParsedArgs): Promise<number> {
  try {
    const config = await resolveConfig({
      cwd: process.cwd(),
      cliSiteUuid: getStringFlag(args.flags, 'site-uuid'),
      cliEndpoint: getStringFlag(args.flags, 'endpoint'),
    });
    console.log(`Site UUID:  ${config.siteUuid}`);
    console.log(`Endpoint:   ${config.endpoint}`);
    console.log(`Timeout:    ${config.timeoutMs}ms`);
    return 0;
  } catch (err) {
    if (err instanceof PatchstackError && err.code === 'CONFIG_MISSING') {
      console.log('Not configured. Run `patchstack-connect init <site-uuid>` to get started.');
      return 0;
    }
    throw err;
  }
}

/**
 * Try to add `"prebuild": "patchstack-connect scan"` to package.json scripts.
 * Returns a short description of the result for logging.
 */
async function patchPackageJsonPrebuild(cwd: string): Promise<string> {
  const target = path.join(cwd, 'package.json');
  let raw: string;
  try {
    raw = await readFile(target, 'utf8');
  } catch {
    return 'skipped — no package.json in current directory';
  }

  // Best-effort indent detection: look at the first indented line.
  const indentMatch = raw.match(/\n([ \t]+)\S/);
  const indent = indentMatch?.[1] ?? '  ';
  const newline = raw.endsWith('\n') ? '\n' : '';

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return 'skipped — package.json is not valid JSON';
  }

  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  if (typeof scripts.prebuild === 'string' && scripts.prebuild.includes('patchstack-connect')) {
    return 'unchanged — prebuild already calls patchstack-connect';
  }
  if (typeof scripts.prebuild === 'string' && scripts.prebuild.length > 0) {
    return `skipped — package.json scripts.prebuild already exists ("${scripts.prebuild}"). Add "patchstack-connect scan" to it manually.`;
  }

  scripts.prebuild = 'patchstack-connect scan';
  pkg.scripts = scripts;

  await writeFile(target, JSON.stringify(pkg, null, indent) + newline, 'utf8');
  return 'patched — added "prebuild": "patchstack-connect scan"';
}

async function runBootstrap(args: ParsedArgs): Promise<number> {
  const token = args.positional[0];
  if (!token) {
    console.error('Error: integration token is required.\n');
    console.error('Usage: patchstack-connect bootstrap <token>');
    return 1;
  }

  const apiBaseUrl =
    getStringFlag(args.flags, 'api-url') ?? process.env.PATCHSTACK_API_URL ?? DEFAULT_API_BASE_URL;
  const siteUrl = getStringFlag(args.flags, 'url');
  const appType = getStringFlag(args.flags, 'app-type');
  const skipPrebuild = args.flags.get('skip-prebuild') === true;
  const skipScan = args.flags.get('skip-scan') === true;

  console.log(`Redeeming integration token at ${apiBaseUrl}…`);
  const redeem = await redeemIntegrationToken(token, {
    apiBaseUrl,
    url: siteUrl,
    appType,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });

  const manifestEndpoint = buildManifestEndpoint(apiBaseUrl);
  const configPath = await writeConfigFile(process.cwd(), {
    siteUuid: redeem.uuid,
    endpoint: manifestEndpoint,
  });

  console.log(`Created Pulse site (id ${redeem.site_id}, uuid ${redeem.uuid}).`);
  console.log(`Wrote ${configPath}`);

  if (!skipPrebuild) {
    const result = await patchPackageJsonPrebuild(process.cwd());
    console.log(`package.json: ${result}`);
  }

  if (skipScan) {
    console.log('');
    console.log('Skipping initial scan (--skip-scan).');
    return 0;
  }

  console.log('');
  console.log('Running first scan…');
  const config = await resolveConfig({ cwd: process.cwd() });
  const manifest = await scanLockfile(process.cwd());
  const { payload, stats } = buildWirePayload(manifest);

  console.log(
    `Found ${payload.packages.length} unique package versions across ${stats.uniqueNames} package names in ${manifest.ecosystem} lockfile.`,
  );

  const response = await postManifest(config, payload);
  if (response.stored) {
    console.log(`Stored manifest #${response.manifest_id} (checksum ${response.checksum}).`);
  } else if (response.reason === 'duplicate') {
    console.log('Manifest unchanged since last scan — nothing to store.');
  } else {
    console.log(`Server response: ${response.message ?? JSON.stringify(response)}`);
  }
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv);

  if (args.flags.has('help') || args.command === 'help' || args.command === null) {
    console.log(HELP);
    return 0;
  }

  switch (args.command) {
    case 'bootstrap':
      return runBootstrap(args);
    case 'init':
      return runInit(args);
    case 'scan':
      return runScan(args);
    case 'status':
      return runStatus(args);
    default:
      console.error(`Unknown command: ${args.command}\n`);
      console.error(HELP);
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof PatchstackError) {
      console.error(`Error (${err.code}): ${err.message}`);
      process.exit(1);
    }
    console.error('Unexpected error:', err);
    process.exit(2);
  });
