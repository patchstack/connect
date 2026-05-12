import { scanLockfile } from './parsers/index.js';
import { buildWirePayload } from './normalize.js';
import { postManifest } from './client.js';
import { resolveConfig, writeConfigFile } from './config.js';
import { PatchstackError } from './types.js';

const HELP = `@patchstack/connect — scan your lockfile and report packages to Patchstack.

Usage:
  patchstack-connect init <site-uuid>       Save the site UUID to .patchstackrc.json
  patchstack-connect scan [--dry-run]       Scan lockfile and POST to Patchstack
  patchstack-connect status                 Show current configuration
  patchstack-connect help                   Print this message

Environment:
  PATCHSTACK_SITE_UUID    Site UUID (overrides .patchstackrc.json)
  PATCHSTACK_ENDPOINT     Override the API endpoint (default: https://app.patchstack.com/monitor/pulse/manifest)

Examples:
  npx @patchstack/connect init 550e8400-e29b-41d4-a716-446655440000
  npx @patchstack/connect scan
  PATCHSTACK_SITE_UUID=... npx @patchstack/connect scan --dry-run
`;

interface ParsedArgs {
  command: string | null;
  positional: string[];
  flags: Set<string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const positional: string[] = [];
  const flags = new Set<string>();
  for (const arg of args) {
    if (arg.startsWith('--')) {
      flags.add(arg.slice(2));
    } else {
      positional.push(arg);
    }
  }
  return {
    command: positional.shift() ?? null,
    positional,
    flags,
  };
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
  const dryRun = args.flags.has('dry-run');
  const config = await resolveConfig({ cwd: process.cwd() });
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

async function runStatus(): Promise<number> {
  try {
    const config = await resolveConfig({ cwd: process.cwd() });
    console.log(`Site UUID: ${config.siteUuid}`);
    console.log(`Endpoint:  ${config.endpoint}`);
    return 0;
  } catch (err) {
    if (err instanceof PatchstackError && err.code === 'CONFIG_MISSING') {
      console.log('Not configured. Run `patchstack-connect init <site-uuid>` to get started.');
      return 0;
    }
    throw err;
  }
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
      return runStatus();
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
