import { readFileSync, writeFileSync } from 'node:fs';

import { scanLockfile } from './parsers/index.js';
import { buildWirePayload } from './normalize.js';
import { computeManifestChecksum } from './checksum.js';
import { DEFAULT_ENDPOINT, buildClaimUrl, postManifest } from './client.js';
import { persistSiteUuid, resolveConfig, writeConfigFile } from './config.js';
import {
  buildInjectionSnippet,
  findHtmlFiles,
  injectMarker,
  resolveBuildDir,
} from './mark-build.js';
import {
  collectGuideState,
  countRemainingSteps,
  installCommand,
  renderGuideChecklist,
} from './guide.js';
import { runProtect } from './protect/install/index.js';
import { wireBuildScripts } from './setup.js';
import { detectStack, type StackDescriptor } from './stack.js';
import { PatchstackError } from './types.js';
import { buildWidgetTag, ensureSourceWidget, ensureWidgetInHtml } from './widget.js';

const HELP = `@patchstack/connect — scan your lockfile and report packages to Patchstack.

Usage:
  patchstack-connect scan   [options]                Scan lockfile and POST to Patchstack.
                                                     If no UUID is configured, the server
                                                     provisions one and we persist it. After a
                                                     successful post it also adds/updates the
                                                     disclosure-widget <script> tag in the root
                                                     HTML shell (index.html, public/index.html,
                                                     or src/app.html) — opt out with
                                                     "widget": false in .patchstackrc.json
  patchstack-connect setup  [options]                Finish the bounded project setup: run scan,
                                                     manage the widget, and wire package.json build
                                                     scripts. Never runs a build or protect
  patchstack-connect init   <site-uuid>              Optional: pre-seed .patchstackrc.json
                                                     with an existing site UUID
  patchstack-connect status [options]                Show current configuration
  patchstack-connect mark-build [options]            Stamp built HTML with a production flag +
                                                     build fingerprint, and ensure the widget
                                                     tag in built pages (run as a postbuild step)
  patchstack-connect protect [--demo]                Install always-on runtime protection (the
                                                     guard) into a TanStack Start + Supabase app.
                                                     Covers the browser + server-function paths.
                                                     --demo seeds a broad sample rule set (for
                                                     demonstrations, not production).
  patchstack-connect guide [--full]                  Show this project's setup status (what's done,
                                                     what's missing, with tailored commands), then
                                                     print the full setup guide. --full prints the
                                                     guide even when setup is complete
  patchstack-connect help                            Print this message

Options (for scan, setup, and status):
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
  PATCHSTACK_MODE         (protect) Runtime guard mode: block (default) | dry-run
  PATCHSTACK_ROUTE_WAF    (protect) Set to 1 to also screen every request at the route level (opt-in)

Precedence: CLI flag > environment variable > .patchstackrc.json.

Examples:
  npx @patchstack/connect setup
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

async function runScan(
  args: ParsedArgs,
  options: { showRemainingSetup?: boolean } = {},
): Promise<number> {
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
    `Found ${payload.packages.length} unique package versions across ${stats.uniqueNames} package names (${manifest.ecosystem} ecosystem).`,
  );
  console.log(
    `Reporting under the ${config.environment} environment (override with PATCHSTACK_ENVIRONMENT).`,
  );
  if (config.endpoint !== DEFAULT_ENDPOINT) {
    console.log(
      `Using endpoint override: ${config.endpoint} (set via --endpoint, PATCHSTACK_ENDPOINT, or .patchstackrc.json).`,
    );
  }
  if (stats.duplicateNames.length > 0) {
    const sample = stats.duplicateNames.slice(0, 10).join(', ');
    const more =
      stats.duplicateNames.length > 10 ? `, +${stats.duplicateNames.length - 10} more` : '';
    console.log(
      `${stats.duplicateNames.length} package(s) appear at multiple versions: ${sample}${more}`,
    );
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

  // With a UUID in hand (existing or freshly provisioned), ensure the
  // disclosure widget's managed tag in the source HTML shell so the very next
  // preview reload shows the "Report a vulnerability" button. Best-effort and
  // opt-out-able; a failed post never reaches this point, and --dry-run
  // returned above.
  const effectiveUuid = config.siteUuid ?? response.uuid ?? null;
  if (config.widget && effectiveUuid !== null && effectiveUuid.length > 0) {
    reportSourceWidget(effectiveUuid);
  }

  // On the first scan (provisioning), surface the dashboard URL so the user can
  // attach this site to their Patchstack account. `npx @patchstack/connect status`
  // re-displays it any time.
  if (provisioning && response.uuid !== undefined && response.uuid.length > 0) {
    console.log('');
    console.log('Open this dashboard link to view vulnerability reports:');
    console.log(`  ${buildClaimUrl(config.endpoint, response.uuid)}`);
    if (config.endpoint !== DEFAULT_ENDPOINT) {
      console.log('  (this URL inherits the endpoint override above)');
    }
  }

  // A scan can't wire the build hooks itself — an agent that runs `scan` but not
  // `guide` (a common shortcut) otherwise sees the widget + claim URL and assumes
  // setup is finished. Surface whatever is still missing so the loop actually closes.
  if (options.showRemainingSetup !== false) {
    try {
      const state = await collectGuideState(process.cwd());
      const remaining = countRemainingSteps(state);
      if (remaining > 0) {
        const hooksMissing = !(state.prebuildWired && state.postbuildWired);
        console.log('');
        console.log(
          `Setup not complete — ${remaining} step(s) remaining${hooksMissing ? ", including the package.json build hooks (which scan can't wire)" : ''}.`,
        );
        console.log('Run `npx @patchstack/connect guide` for the exact steps to finish for this project.');
      }
    } catch {
      // Best-effort: never turn a successful scan into a failure over this nudge.
    }
  }

  return 0;
}

/**
 * Run the source-widget pass for `scan` and narrate the outcome. Never throws:
 * widget management is a convenience layered on top of a successful scan and
 * must not turn one into a failure.
 */
function reportSourceWidget(siteUuid: string): void {
  try {
    const result = ensureSourceWidget(process.cwd(), siteUuid);
    switch (result.action) {
      case 'added':
        console.log(`Widget: added the "Report a vulnerability" tag to ${result.shell}. Reload your preview to see it.`);
        break;
      case 'updated':
        console.log(`Widget: updated the managed tag in ${result.shell} to site ${siteUuid}.`);
        break;
      case 'unchanged':
        console.log(`Widget: already installed in ${result.shell}.`);
        break;
      case 'manual':
        console.log(`Widget: found an existing (manual) install in ${result.shell} — left untouched.`);
        break;
      case 'no-body':
        console.log(`Widget: ${result.shell} has no </body> tag to anchor on. Add this tag to your root layout manually:`);
        console.log(`  ${buildWidgetTag(siteUuid)}`);
        break;
      case 'no-shell':
        console.log('Widget: no plain HTML shell found (index.html / public/index.html / src/app.html).');
        console.log('Add this tag to your root layout before </body> (run `guide` for framework-specific placement):');
        console.log(`  ${buildWidgetTag(siteUuid)}`);
        break;
    }
    if (result.action === 'added' || result.action === 'updated') {
      console.log('  (opt out any time with "widget": false in .patchstackrc.json)');
    }
  } catch (err) {
    console.warn(`Widget: skipped (${(err as Error).message}).`);
  }
}

async function runProtectCommand(args: ParsedArgs): Promise<number> {
  // Best-effort: like mark-build, this runs during builds and must never fail one.
  const demo = args.flags.get('demo') === true;
  try {
    runProtect(process.cwd(), { demo });
  } catch (err) {
    console.warn(`patchstack protect: skipped (${(err as Error).message}).`);
  }
  return 0;
}

async function runGuide(args: ParsedArgs): Promise<number> {
  // The live checklist first: what this project already has and what's missing,
  // with commands tailored to it. Best-effort — a project we can't inspect
  // still gets the reference doc.
  let allDone = false;
  try {
    const state = await collectGuideState(process.cwd());
    const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
    console.log(renderGuideChecklist(state, useColor));
    allDone = countRemainingSteps(state) === 0;
  } catch {
    // fall through to the static guide
  }

  // A fully green project doesn't need the ~90-line manual again on every
  // re-run — point at it instead. `--full` always prints it.
  if (allDone && args.flags.get('full') !== true) {
    console.log('');
    console.log(
      'Full reference guide: `npx @patchstack/connect guide --full` (or read node_modules/@patchstack/connect/AGENT-INSTALL.md).',
    );
    return 0;
  }

  console.log('');
  console.log('———— Full reference guide (ships as AGENT-INSTALL.md) ————');
  console.log('');

  // AGENT-INSTALL.md ships at the package root, one level above dist/ (and
  // above src/ when running unbundled), so the same relative path works in both.
  const guidePath = new URL('../AGENT-INSTALL.md', import.meta.url);
  console.log(readFileSync(guidePath, 'utf8'));
  return 0;
}

async function runSetup(args: ParsedArgs): Promise<number> {
  if (args.flags.get('dry-run') === true) {
    console.error('Error: setup does not support --dry-run. Use `scan --dry-run` to preview the manifest.');
    return 1;
  }

  const before = await collectGuideState(process.cwd());
  if (!before.hasPackageJson) {
    console.error('Error: no package.json found. Run setup from the project root.');
    return 1;
  }
  if (before.installed === null) {
    console.error(
      `Error: @patchstack/connect is not declared in package.json.\nRun: ${installCommand(before.packageManager)}`,
    );
    return 1;
  }

  console.log('Patchstack setup — applying bounded project changes');
  console.log('  1. Scan dependencies, provision/reuse the site, and manage the source widget');
  const scanCode = await runScan(args, { showRemainingSetup: false });
  if (scanCode !== 0) {
    return scanCode;
  }

  console.log('');
  console.log('  2. Wire scan and mark-build into package.json');
  const wired = wireBuildScripts(process.cwd(), before.packageManager);
  console.log(`Build integration: ${wired.detail}`);

  console.log('');
  console.log('  3. Verify setup status');
  const after = await collectGuideState(process.cwd());
  const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
  console.log(renderGuideChecklist(after, useColor));

  const remaining = countRemainingSteps(after);
  if (remaining > 0) {
    console.log('');
    console.log(`Setup applied its bounded changes; ${remaining} manual step(s) remain above.`);
  }
  return 0;
}

async function runStatus(args: ParsedArgs): Promise<number> {
  const config = await resolveConfig({
    cwd: process.cwd(),
    cliSiteUuid: getStringFlag(args.flags, 'site-uuid'),
    cliEndpoint: getStringFlag(args.flags, 'endpoint'),
  });
  console.log(`Site UUID:   ${config.siteUuid ?? '(none yet — the next `scan` will provision one)'}`);
  console.log(
    `Endpoint:    ${config.endpoint}${config.endpoint === DEFAULT_ENDPOINT ? '' : ' (override)'}`,
  );
  console.log(`Timeout:     ${config.timeoutMs}ms`);
  console.log(`Environment: ${config.environment}`);
  if (config.siteUuid !== null) {
    console.log(`Dashboard URL: ${buildClaimUrl(config.endpoint, config.siteUuid)}`);
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

  // The widget pass needs the configured UUID; best-effort for the same reason.
  let widgetUuid: string | null = null;
  try {
    const config = await resolveConfig({
      cwd,
      cliSiteUuid: getStringFlag(args.flags, 'site-uuid'),
    });
    if (config.widget) {
      widgetUuid = config.siteUuid;
    }
  } catch (err) {
    console.warn(
      `mark-build: could not resolve the site UUID (${(err as Error).message}). Skipping the widget pass.`,
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
  let widgetTouched = 0;
  for (const file of files) {
    const before = readFileSync(file, 'utf8');
    let after = injectMarker(before, snippet);
    // Built HTML that came through a shell scan already edited carries the
    // managed tag; this covers output whose source shell we couldn't edit.
    // Manual installs are adopted (left untouched), same as in scan.
    if (widgetUuid !== null) {
      const ensured = ensureWidgetInHtml(after, widgetUuid);
      if (ensured.action === 'added' || ensured.action === 'updated') {
        widgetTouched += 1;
      }
      after = ensured.html;
    }
    if (after !== before) {
      writeFileSync(file, after);
      marked += 1;
    }
  }

  const stackSummary = stack !== null ? describeStack(stack) : null;
  console.log(
    `mark-build: marked ${marked} HTML file(s) in ${dir}` +
      `${checksum !== null ? ` (build ${checksum})` : ''}` +
      `${widgetTouched > 0 ? `, widget tag ensured in ${widgetTouched}` : ''}` +
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
      return runGuide(args);
    case 'setup':
      return runSetup(args);
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
