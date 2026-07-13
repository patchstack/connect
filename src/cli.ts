import { readFileSync, writeFileSync } from 'node:fs';

import { scanLockfile } from './parsers/index.js';
import { buildWirePayload } from './normalize.js';
import { computeManifestChecksum } from './checksum.js';
import { buildClaimUrl, postManifest } from './client.js';
import { persistSiteUuid, resolveConfig, writeConfigFile } from './config.js';
import {
  buildInjectionSnippet,
  findHtmlFiles,
  injectMarker,
  resolveBuildDir,
} from './mark-build.js';
import { runProtect } from './protect/install.js';
import { detectStack, type StackDescriptor } from './stack.js';
import { PatchstackError } from './types.js';

const HELP = `@patchstack/connect — scan your lockfile and report packages to Patchstack.

Usage:
  patchstack-connect scan   [options]                Scan lockfile and POST to Patchstack.
                                                     If no UUID is configured, the server
                                                     provisions one and we persist it.
  patchstack-connect init   <site-uuid>              Optional: pre-seed .patchstackrc.json
                                                     with an existing site UUID
  patchstack-connect status [options]                Show current configuration
  patchstack-connect mark-build [options]            Stamp built HTML with a production flag +
                                                     build fingerprint (run as a postbuild step)
  patchstack-connect protect                         Install always-on runtime protection (the
                                                     guard) into a TanStack Start + Supabase app.
                                                     Covers the browser + server-function paths.
  patchstack-connect guide                           Print the full setup guide for AI coding
                                                     agents (also at https://patchstack.com/install.txt)
  patchstack-connect help                            Print this message

Options (for scan and status):
  --site-uuid <uuid>      Override the configured site UUID
  --endpoint <url>        Override the API endpoint
  --dry-run               (scan only) Show the payload without posting

Options (for mark-build):
  --dir <path>            Build output directory (default: auto-detect
                          dist/ build/ out/ .output/public)

Environment:
  PATCHSTACK_SITE_UUID    Site UUID
  PATCHSTACK_ENDPOINT     API endpoint (default: https://api.patchstack.com/monitor/pulse/manifest)
  PATCHSTACK_TIMEOUT_MS   Request timeout in ms (default: 30000)
  PATCHSTACK_ENVIRONMENT  Manifest environment: production | sandbox (default: production)

Precedence: CLI flag > environment variable > .patchstackrc.json.

Examples:
  npx @patchstack/connect scan
  npx @patchstack/connect scan --dry-run
  npx @patchstack/connect init 550e8400-e29b-41d4-a716-446655440000
  npx @patchstack/connect scan --site-uuid 550e8400-...-446655440000
`;

const VALUE_FLAGS = new Set(['site-uuid', 'endpoint', 'dir']);

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
  for (const warning of manifest.warnings ?? []) {
    console.warn(`patchstack: ${warning}`);
  }
  const { payload, stats } = buildWirePayload(manifest);

  console.log(
    `Found ${payload.packages.length} unique package versions across ${stats.uniqueNames} package names in ${manifest.ecosystem} lockfile.`,
  );
  console.log(`Reporting under the ${config.environment} environment.`);
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

  // On the first scan (provisioning), surface the claim URL so the user can
  // attach this site to their Patchstack account. `npx @patchstack/connect status`
  // re-displays it any time.
  if (provisioning && response.uuid !== undefined && response.uuid.length > 0) {
    console.log('');
    console.log('Claim this site to view vulnerability reports in your Patchstack dashboard:');
    console.log(`  ${buildClaimUrl(config.endpoint, response.uuid)}`);
  }

  return 0;
}

async function runProtectCommand(_args: ParsedArgs): Promise<number> {
  // Best-effort: like mark-build, this runs during builds and must never fail one.
  try {
    runProtect(process.cwd());
  } catch (err) {
    console.warn(`patchstack protect: skipped (${(err as Error).message}).`);
  }
  return 0;
}

async function runGuide(): Promise<number> {
  // AGENT-INSTALL.md ships at the package root, one level above dist/ (and
  // above src/ when running unbundled), so the same relative path works in both.
  const guidePath = new URL('../AGENT-INSTALL.md', import.meta.url);
  console.log(readFileSync(guidePath, 'utf8'));
  return 0;
}

async function runStatus(args: ParsedArgs): Promise<number> {
  const config = await resolveConfig({
    cwd: process.cwd(),
    cliSiteUuid: getStringFlag(args.flags, 'site-uuid'),
    cliEndpoint: getStringFlag(args.flags, 'endpoint'),
  });
  console.log(`Site UUID:   ${config.siteUuid ?? '(none yet — the next `scan` will provision one)'}`);
  console.log(`Endpoint:    ${config.endpoint}`);
  console.log(`Timeout:     ${config.timeoutMs}ms`);
  console.log(`Environment: ${config.environment}`);
  if (config.siteUuid !== null) {
    console.log(`Claim URL:  ${buildClaimUrl(config.endpoint, config.siteUuid)}`);
  }
  return 0;
}

/** One-line, human-readable summary of a detected stack for CLI output. */
function describeStack(stack: StackDescriptor): string | null {
  const parts = [stack.builder, stack.framework, stack.ui, stack.runtime].filter(
    (part): part is string => part !== null,
  );
  if (stack.hostingEnvKeys.length > 0) {
    parts.push(`${stack.hostingEnvKeys.length} hosting env key(s)`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

async function runMarkBuild(args: ParsedArgs): Promise<number> {
  const cwd = process.cwd();

  // Compute the build fingerprint and stack descriptor from the lockfile.
  // Best-effort: mark-build is a postbuild step and must never fail the build, so
  // a missing/unreadable lockfile just means we stamp the production flag without
  // a fingerprint or stack.
  let checksum: string | null = null;
  let stack: StackDescriptor | null = null;
  try {
    const manifest = await scanLockfile(cwd);
    for (const warning of manifest.warnings ?? []) {
      console.warn(`mark-build: ${warning}`);
    }
    const { payload } = buildWirePayload(manifest);
    checksum = computeManifestChecksum(payload.packages);
    stack = detectStack(payload.packages);
  } catch (err) {
    console.warn(
      `mark-build: could not compute the build fingerprint (${(err as Error).message}). Stamping the production flag only.`,
    );
  }

  const dir = resolveBuildDir(cwd, getStringFlag(args.flags, 'dir'));
  if (dir === null) {
    console.warn(
      'mark-build: no build output directory found (looked for dist/, build/, out/, .output/public). Pass --dir <path> if it is elsewhere. Nothing to mark.',
    );
    return 0;
  }

  const files = findHtmlFiles(dir);
  if (files.length === 0) {
    console.warn(`mark-build: no HTML files found under ${dir}. Nothing to mark.`);
    return 0;
  }

  const snippet = buildInjectionSnippet(checksum, stack);
  let marked = 0;
  for (const file of files) {
    const before = readFileSync(file, 'utf8');
    const after = injectMarker(before, snippet);
    if (after !== before) {
      writeFileSync(file, after);
      marked += 1;
    }
  }

  const stackSummary = stack !== null ? describeStack(stack) : null;
  console.log(
    `mark-build: marked ${marked} HTML file(s) in ${dir}` +
      `${checksum !== null ? ` (build ${checksum})` : ''}` +
      `${stackSummary !== null ? ` [${stackSummary}]` : ''}.`,
  );
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
    case 'mark-build':
      return runMarkBuild(args);
    case 'protect':
      return runProtectCommand(args);
    case 'guide':
      return runGuide();
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
