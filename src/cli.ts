import { scanLockfile } from './parsers/index.js';
import { buildWirePayload } from './normalize.js';
import { postManifest } from './client.js';
import { persistSiteUuid, resolveConfig, writeConfigFile } from './config.js';
import { PatchstackError } from './types.js';

const HELP = `@patchstack/connect — scan your lockfile and report packages to Patchstack.

Usage:
  patchstack-connect scan   [options]                Scan lockfile and POST to Patchstack.
                                                     If no UUID is configured, the server
                                                     provisions one and we persist it.
  patchstack-connect init   <site-uuid>              Optional: pre-seed .patchstackrc.json
                                                     with an existing site UUID
  patchstack-connect status [options]                Show current configuration
  patchstack-connect help                            Print this message

Options (for scan and status):
  --site-uuid <uuid>      Override the configured site UUID
  --endpoint <url>        Override the API endpoint
  --dry-run               (scan only) Show the payload without posting

Environment:
  PATCHSTACK_SITE_UUID    Site UUID
  PATCHSTACK_ENDPOINT     API endpoint (default: https://app.patchstack.com/monitor/pulse/manifest)
  PATCHSTACK_TIMEOUT_MS   Request timeout in ms (default: 30000)

Precedence: CLI flag > environment variable > .patchstackrc.json.

Examples:
  npx @patchstack/connect scan
  npx @patchstack/connect scan --dry-run
  npx @patchstack/connect init 550e8400-e29b-41d4-a716-446655440000
  npx @patchstack/connect scan --site-uuid 550e8400-...-446655440000
`;

const VALUE_FLAGS = new Set(['site-uuid', 'endpoint']);

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
    if (config.siteUuid === null) {
      console.log('--dry-run: no site UUID configured. A real run would provision one.');
    } else {
      console.log(`--dry-run: not posting to Patchstack (site UUID ${config.siteUuid}).`);
    }
    console.log('Payload preview:');
    const preview = JSON.stringify(payload, null, 2).split('\n');
    console.log(preview.slice(0, Math.min(preview.length, 30)).join('\n'));
    if (preview.length > 30) {
      console.log(`  ... (${preview.length - 30} more lines)`);
    }
    return 0;
  }

  const provisioning = config.siteUuid === null;
  if (provisioning) {
    console.log('No site UUID configured — provisioning a new Patchstack site from this manifest…');
  }

  const response = await postManifest(config, payload);

  // The server always returns the UUID. If we didn't have one, persist it so
  // every subsequent scan targets the same site.
  if (provisioning && response.uuid !== undefined && response.uuid.length > 0) {
    const target = await persistSiteUuid(process.cwd(), response.uuid);
    console.log(`Provisioned site ${response.uuid}. Saved UUID to ${target}.`);
  }

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
  const config = await resolveConfig({
    cwd: process.cwd(),
    cliSiteUuid: getStringFlag(args.flags, 'site-uuid'),
    cliEndpoint: getStringFlag(args.flags, 'endpoint'),
  });
  console.log(`Site UUID:  ${config.siteUuid ?? '(none yet — the next `scan` will provision one)'}`);
  console.log(`Endpoint:   ${config.endpoint}`);
  console.log(`Timeout:    ${config.timeoutMs}ms`);
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv);

  if (args.flags.has('help') || args.command === 'help' || args.command === null) {
    console.log(HELP);
    return 0;
  }

  switch (args.command) {
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
