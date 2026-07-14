import { readFileSync } from 'node:fs';
import path from 'node:path';

import { atomicWriteTextFile } from './atomic-write.js';
import { scanLockfile } from './parsers/index.js';
import { buildWirePayload } from './normalize.js';
import { computeManifestChecksum } from './checksum.js';
import { DEFAULT_ENDPOINT, buildClaimUrl, isUuid, postManifest } from './client.js';
import { persistSiteUuid, resolveConfig } from './config.js';
import {
  buildInjectionSnippet,
  buildWidgetTag,
  findHtmlFiles,
  hasLiveHtmlDocument,
  injectMarker,
  resolveBuildDir,
  verifyBuildHtml,
  type BuildHtmlVerificationIssue,
} from './mark-build.js';
import { collectGuideState, countRemainingSteps, renderGuideChecklist } from './guide.js';
import {
  ensureSourceWidget,
  inspectSourceWidgetPreflight,
  widgetApiBaseFromEndpoint,
  type SourceWidgetPreflightResult,
} from './source-widget.js';
import { acquireProvisionLock, type ProvisionLock } from './provision-lock.js';
import { runProtect } from './protect/install.js';
import {
  SSR_CAPABLE_FRAMEWORKS,
  detectStack,
  type StackDescriptor,
} from './stack.js';
import { PatchstackError } from './types.js';

const HELP = `@patchstack/connect — scan your lockfile and report packages to Patchstack.

Usage:
  patchstack-connect scan   [options]                Scan lockfile and POST to Patchstack.
                                                     If no UUID is configured, the server
                                                     provisions one, we persist it, and the
                                                     widget is added to a safe source shell.
  patchstack-connect init   <site-uuid>              Optional: pre-seed .patchstackrc.json
                                                     with an existing site UUID
  patchstack-connect status [options]                Show current configuration
  patchstack-connect mark-build [options]            Stamp built HTML with a production flag +
                                                     build fingerprint and ensure the widget
                                                     (run as a postbuild step)
  patchstack-connect protect                         Install always-on runtime protection (the
                                                     guard) into a TanStack Start + Supabase app.
                                                     Covers the browser + server-function paths.
  patchstack-connect guide [--full]                  Show this project's setup status (what's done,
                                                     what's missing, with tailored commands), then
                                                     print the full setup guide. --full prints the
                                                     guide even when setup is complete
                                                     (also at https://patchstack.com/install.txt)
  patchstack-connect help                            Print this message

Options (for scan, status, and mark-build):
  --site-uuid <uuid>      Override the configured site UUID
  --endpoint <url>        Override the API endpoint

Options (for scan):
  --dry-run               (scan only) Show the payload without posting

Options (for mark-build):
  --dir <path>            Build output directory (default: auto-detect
                          dist/ build/ out/ .output/public)
  --strict                Fail when production HTML/widget verification fails
  --static-output         Assert that every deployed route is represented by
                          static HTML (required for SSR-capable frameworks)

Environment:
  PATCHSTACK_SITE_UUID    Site UUID
  PATCHSTACK_ENDPOINT     API endpoint (default: https://api.patchstack.com/monitor/pulse/manifest)
  PATCHSTACK_TIMEOUT_MS   Request timeout in ms (default: 30000)
  PATCHSTACK_ENVIRONMENT  Manifest environment: production | sandbox (default: production)

Precedence: CLI flag > environment variable > .patchstackrc.json.

Examples:
  patchstack-connect scan
  patchstack-connect scan --dry-run
  patchstack-connect init 550e8400-e29b-41d4-a716-446655440000
  patchstack-connect scan --site-uuid 550e8400-...-446655440000
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
      const name = stripped.slice(0, eqIdx);
      if (flags.has(name)) {
        throw new PatchstackError(`Flag --${name} was provided more than once.`, 'CONFIG_INVALID');
      }
      flags.set(name, stripped.slice(eqIdx + 1));
      continue;
    }
    const next = args[i + 1];
    if (VALUE_FLAGS.has(stripped) && next !== undefined && !next.startsWith('--')) {
      if (flags.has(stripped)) {
        throw new PatchstackError(
          `Flag --${stripped} was provided more than once.`,
          'CONFIG_INVALID',
        );
      }
      flags.set(stripped, next);
      i++;
    } else {
      if (flags.has(stripped)) {
        throw new PatchstackError(
          `Flag --${stripped} was provided more than once.`,
          'CONFIG_INVALID',
        );
      }
      flags.set(stripped, true);
    }
  }

  return {
    command: positional.shift() ?? null,
    positional,
    flags,
  };
}

const COMMAND_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  scan: new Set(['site-uuid', 'endpoint', 'dry-run', 'help']),
  status: new Set(['site-uuid', 'endpoint', 'help']),
  'mark-build': new Set([
    'site-uuid',
    'endpoint',
    'dir',
    'strict',
    'static-output',
    'help',
  ]),
  init: new Set(['help']),
  protect: new Set(['help']),
  guide: new Set(['full', 'help']),
  help: new Set(['help']),
};

function validateCommandArgs(args: ParsedArgs): void {
  if (args.command === null) return;
  const allowed = COMMAND_FLAGS[args.command];
  if (allowed === undefined) return;
  for (const flag of args.flags.keys()) {
    if (!allowed.has(flag)) {
      throw new PatchstackError(
        `Unknown option --${flag} for ${args.command}. Run \`patchstack-connect ${args.command} --help\` for usage.`,
        'CONFIG_INVALID',
      );
    }
  }
  const expectedPositionals = args.command === 'init' ? 1 : 0;
  if (args.positional.length !== expectedPositionals) {
    throw new PatchstackError(
      args.command === 'init'
        ? 'init requires exactly one site UUID.'
        : `${args.command} does not accept positional arguments.`,
      'CONFIG_INVALID',
    );
  }
}

function getStringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PatchstackError(`--${name} requires a non-empty value.`, 'CONFIG_INVALID');
  }
  return value;
}

function getBooleanFlag(flags: Map<string, string | true>, name: string): boolean {
  const value = flags.get(name);
  if (value === undefined || value === 'false') return false;
  if (value === true || value === 'true') return true;
  throw new PatchstackError(
    `--${name} accepts no value, "true", or "false"; got "${value}".`,
    'CONFIG_INVALID',
  );
}

async function runInit(args: ParsedArgs): Promise<number> {
  const uuid = args.positional[0];
  if (!uuid) {
    console.error('Error: site UUID is required.\n');
    console.error('Usage: patchstack-connect init <site-uuid>');
    return 1;
  }
  if (!isUuid(uuid)) {
    console.error(`Error: "${uuid}" does not look like a valid UUID.`);
    return 1;
  }

  const target = await persistSiteUuid(process.cwd(), uuid);
  console.log(`Wrote ${target}`);
  console.log('');
  console.log('Next: run `patchstack-connect scan` to send your first manifest.');
  return 0;
}

async function runScan(args: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  const dryRun = getBooleanFlag(args.flags, 'dry-run');
  const configOptions = {
    cwd,
    cliSiteUuid: getStringFlag(args.flags, 'site-uuid'),
    cliEndpoint: getStringFlag(args.flags, 'endpoint'),
  };
  let config = await resolveConfig(configOptions);
  const manifest = await scanLockfile(cwd);
  for (const warning of manifest.warnings ?? []) {
    console.warn(`patchstack: ${warning}`);
  }
  const { payload, stats } = buildWirePayload(manifest);
  const stack = detectStack(payload.packages);

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

  let provisioning = config.siteUuid === null;
  let provisionLock: ProvisionLock | null = null;
  if (provisioning) {
    provisionLock = await acquireProvisionLock(
      cwd,
      Math.min(Math.max(config.timeoutMs + 5_000, 5_000), 60_000),
    );
  }

  try {
    if (provisionLock !== null) {
      // Another scan may have completed while this one waited. Re-resolving here
      // turns the second request into an existing-site POST instead of creating a
      // second anonymous site for the same checkout.
      config = await resolveConfig(configOptions);
      provisioning = config.siteUuid === null;
      if (provisioning) {
        console.log(
          'No site UUID configured — provisioning a new Patchstack site from this manifest…',
        );
      } else {
        console.log(
          `Another scan provisioned site ${config.siteUuid} while this scan waited; reusing it.`,
        );
      }
    }

    if (config.widgetEnabled !== false) {
      const preflight = await inspectSourceWidgetPreflight({
        cwd,
        stack,
        expectedSiteUuid: config.siteUuid,
      });
      const hasWidgetLoader = preflight.shells.some((shell) =>
        shell.identity.occurrences.some(
          (occurrence) =>
            occurrence.kind === 'script-tag' || occurrence.kind === 'dynamic-loader',
        ),
      );
      if (preflight.externalWidgetShells.length > 0) {
        throw unsafeExternalWidgetIdentityError(preflight, config.siteUuid, cwd);
      }

      if (preflight.missingRequiredShells.length > 0) {
        throw new PatchstackError(
          `Cannot safely continue: ${preflight.missingRequiredShells.join('; ')}. No manifest was posted and no source file was changed.`,
          'CONFIG_INVALID',
        );
      }

      if (preflight.files.length === 0) {
        throw new PatchstackError(
          'Cannot safely continue: no editable global source shell was found for the disclosure widget. ' +
            'Create the framework root layout/document and scan again, or explicitly set "widget": false in .patchstackrc.json. No manifest was posted and no site was provisioned.',
          'CONFIG_INVALID',
        );
      }

      if (preflight.status === 'ambiguous') {
        throw unsafeWidgetIdentityError(preflight, config.siteUuid, cwd);
      }

      if (config.siteUuid === null) {
        if (
          preflight.status === 'configured' &&
          preflight.uuid !== null &&
          hasWidgetLoader
        ) {
          const target = await persistSiteUuid(cwd, preflight.uuid, config.endpoint);
          console.log(
            `Found existing widget site ${preflight.uuid}; adopted it in ${target} instead of provisioning a second site.`,
          );
          config = await resolveConfig(configOptions);
          provisioning = false;
        } else if (preflight.status !== 'absent') {
          throw unsafeWidgetIdentityError(preflight, null, cwd);
        }
      } else if (
        preflight.hasManual &&
        (!hasWidgetLoader ||
          preflight.status !== 'configured' ||
          preflight.matchesExpectedUuid !== true)
      ) {
        throw unsafeWidgetIdentityError(preflight, config.siteUuid, cwd);
      }
    }

    const response = await postManifest(config, payload);

    // The server always returns the UUID. If we didn't have one, persist it so
    // every subsequent scan targets the same site.
    if (provisioning && response.uuid !== undefined && response.uuid.length > 0) {
      // Persist the endpoint with the UUID as one identity pair. This matters for
      // a first scan against staging/custom infrastructure: a later build must not
      // send that UUID to the production endpoint by accident.
      const target = await persistSiteUuid(cwd, response.uuid, config.endpoint);
      console.log(`Provisioned site ${response.uuid}. Saved UUID to ${target}.`);
    }

    const effectiveSiteUuid = config.siteUuid ?? response.uuid ?? null;
    if (config.widgetEnabled === false) {
      console.log('Patchstack disclosure widget management is disabled by "widget": false.');
    } else if (effectiveSiteUuid !== null && effectiveSiteUuid.length > 0) {
      await installSourceWidget(
        cwd,
        effectiveSiteUuid,
        config.endpoint,
        stack,
      );
    } else {
      console.warn(
        'patchstack widget: the scan succeeded but no site UUID was returned, so no source file was changed.',
      );
    }

    if (response.stored) {
      console.log(`Stored manifest #${response.manifest_id} (checksum ${response.checksum}).`);
    } else if (response.reason === 'duplicate') {
      console.log('Manifest unchanged since last scan — nothing to store.');
    } else {
      console.log(`Server response: ${response.message ?? JSON.stringify(response)}`);
    }

    // On the first scan (provisioning), surface the claim URL so the user can
    // attach this site to their Patchstack account. `patchstack-connect status`
    // re-displays it any time.
    if (provisioning && response.uuid !== undefined && response.uuid.length > 0) {
      console.log('');
      console.log('Claim this site to view vulnerability reports in your Patchstack dashboard:');
      console.log(`  ${buildClaimUrl(config.endpoint, response.uuid)}`);
      if (config.endpoint !== DEFAULT_ENDPOINT) {
        console.log('  (this URL inherits the endpoint override above)');
      }
    }

    return 0;
  } finally {
    await provisionLock?.release();
  }
}

function unsafeExternalWidgetIdentityError(
  preflight: SourceWidgetPreflightResult,
  expectedSiteUuid: string | null,
  cwd: string,
): PatchstackError {
  const details = preflight.externalWidgetShells.map((shell) => {
    const file = path.relative(cwd, shell.file) || path.basename(shell.file);
    const uuids = shell.identity.uuids.length > 0
      ? ` (${shell.identity.uuids.join(', ')})`
      : '';
    return `${file}: ${shell.identity.status}${uuids}`;
  });
  return new PatchstackError(
    `Cannot safely continue: found a Patchstack loader or initializer outside the selected global shell: ${details.join('; ')}. ` +
      `Move it into the true global shell${expectedSiteUuid === null ? ' or initialize this project explicitly with its verified UUID' : ` and configure it for ${expectedSiteUuid}`}, ` +
      'or remove it so the connector can install the global managed tag. A nested/page-specific loader cannot prove sitewide coverage. No manifest was posted and no source file was changed.',
    'CONFIG_INVALID',
  );
}

function unsafeWidgetIdentityError(
  preflight: SourceWidgetPreflightResult,
  expectedSiteUuid: string | null,
  cwd: string,
): PatchstackError {
  const locations = preflight.files
    .map((file) => path.relative(cwd, file) || path.basename(file))
    .join(', ');
  const identities = preflight.uuids.length > 0
    ? ` Detected UUID(s): ${preflight.uuids.join(', ')}.`
    : '';
  const expected =
    preflight.status === 'ambiguous' && !preflight.hasManual && !preflight.hasManaged
      ? 'Multiple files could be the global app shell. Remove the unrelated shell or make the framework root unambiguous before scanning; no site was provisioned.'
      : expectedSiteUuid === null
        ? 'Fix or remove the existing widget, or run `patchstack-connect init <site-uuid>` with its real UUID before scanning.'
        : `Make the manual widget use ${expectedSiteUuid}, or remove it so the connector can install the managed tag.`;
  return new PatchstackError(
    `Cannot safely continue: the selected source shell${locations ? ` (${locations})` : ''} has ${preflight.status} Patchstack widget identity.${identities} ${expected}`,
    'CONFIG_INVALID',
  );
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
  if (allDone && !getBooleanFlag(args.flags, 'full')) {
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
  console.log(`Widget:      ${config.widgetEnabled === false ? 'disabled' : 'enabled'}`);
  if (config.siteUuid !== null) {
    console.log(`Claim URL:  ${buildClaimUrl(config.endpoint, config.siteUuid)}`);
  }
  return 0;
}

async function installSourceWidget(
  cwd: string,
  siteUuid: string,
  endpoint: string,
  stack: StackDescriptor,
): Promise<void> {
  let result;
  try {
    result = await ensureSourceWidget({ cwd, siteUuid, endpoint, stack });
  } catch (err) {
    throw new PatchstackError(
      `The manifest was posted and site ${siteUuid} was saved, but automatic source installation failed (${(err as Error).message}). Fix the source shell and rerun scan; the saved UUID will be reused instead of provisioning another site.`,
      'CONFIG_INVALID',
      err,
    );
  }

  const displayFile = (file: string | undefined): string =>
    file === undefined ? 'the source shell' : path.relative(cwd, file) || path.basename(file);
  const displayResultFiles = (): string =>
    result.files !== undefined && result.files.length > 0
      ? result.files.map((file) => displayFile(file)).join(', ')
      : displayFile(result.file);
  let fallbackApiBase: string | null = null;
  try {
    fallbackApiBase = widgetApiBaseFromEndpoint(endpoint);
  } catch {
    // `ensureSourceWidget` reports the endpoint problem via its `failed` result.
  }
  const fallbackTag = buildWidgetTag(siteUuid, fallbackApiBase);

  switch (result.status) {
    case 'installed':
      console.log(
        `Installed the Patchstack disclosure widget in ${displayResultFiles()}. Reload the app preview to see it.`,
      );
      return;
    case 'updated':
      console.log(
        `Updated the Patchstack disclosure widget in ${displayResultFiles()}. Reload the app preview to see it.`,
      );
      return;
    case 'unchanged':
      console.log(`Patchstack disclosure widget is ready in ${displayResultFiles()}.`);
      return;
    case 'manual-present':
      console.log(
        `An existing Patchstack disclosure widget is already present in ${displayResultFiles()}; left it unchanged.`,
      );
      return;
    case 'ambiguous': {
      const files = (result.candidates ?? [])
        .map((file) => path.relative(cwd, file) || path.basename(file))
        .join(', ');
      throw new PatchstackError(
        `The manifest was posted and site ${siteUuid} was saved, but multiple possible source shells were found${files.length > 0 ? ` (${files})` : ''}; no source file was changed. Fix the true global shell and rerun scan so it can install this tag without provisioning again:\n  ${fallbackTag}`,
        'CONFIG_INVALID',
      );
    }
    case 'not-found':
      throw new PatchstackError(
        `The manifest was posted and site ${siteUuid} was saved, but the editable global source shell disappeared before widget installation; no source file was changed. Restore it and rerun scan so it can install this tag without provisioning again:\n  ${fallbackTag}`,
        'CONFIG_INVALID',
      );
    case 'failed':
      throw new PatchstackError(
        `The manifest was posted and site ${siteUuid} was saved, but the widget could not update ${displayFile(result.file)}${result.message ? ` (${result.message})` : ''}. Fix the source shell and rerun scan; the saved UUID will be reused instead of provisioning another site.`,
        'CONFIG_INVALID',
      );
  }
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
  const strict = getBooleanFlag(args.flags, 'strict');
  const staticOutput = getBooleanFlag(args.flags, 'static-output');
  if (staticOutput && !strict) {
    console.error('mark-build: --static-output must be used together with --strict.');
    return 1;
  }

  // The first scan persists this value in .patchstackrc.json. Read it again at
  // postbuild time so the generated HTML can auto-initialise the CDN widget
  // without framework-specific source edits. The default mode remains
  // best-effort for backwards compatibility; --strict makes an incomplete or
  // unverifiable production install fail the build hook.
  let siteUuid: string | null = null;
  let widgetApiBaseUrl: string | null = null;
  let widgetEnabled = true;
  try {
    const config = await resolveConfig({
      cwd,
      cliSiteUuid: getStringFlag(args.flags, 'site-uuid'),
      cliEndpoint: getStringFlag(args.flags, 'endpoint'),
    });
    siteUuid = config.siteUuid;
    widgetEnabled = config.widgetEnabled !== false;
    try {
      widgetApiBaseUrl = widgetApiBaseFromEndpoint(config.endpoint);
    } catch (err) {
      console.warn(
        `mark-build: could not derive the widget API origin from ${config.endpoint} (${(err as Error).message}); the widget will use its production default.`,
      );
    }
    if (!widgetEnabled) {
      console.log('mark-build: disclosure widget management is disabled by "widget": false.');
    } else if (siteUuid === null) {
      const message =
        'mark-build: no site UUID configured; run `patchstack-connect scan` before the production build.';
      if (strict) {
        console.error(message);
        return 1;
      }
      console.warn(`${message} Build metadata will be stamped without the disclosure widget.`);
    }
  } catch (err) {
    const message = `mark-build: could not resolve configuration (${(err as Error).message}).`;
    if (strict) {
      console.error(message);
      return 1;
    }
    console.warn(`${message} Build metadata will be stamped without the disclosure widget.`);
  }

  // Compute the build fingerprint and stack descriptor from the lockfile.
  // Default mode remains best-effort. Strict mode requires the lockfile because
  // stack detection is what prevents a hybrid SSR build from passing merely
  // because it emitted one prerendered/error HTML file.
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
    const message = `mark-build: could not compute the build fingerprint or detect output coverage (${(err as Error).message}).`;
    if (strict) {
      console.error(`${message} Strict verification stopped before changing build output.`);
      return 1;
    }
    console.warn(`${message} Stamping the production flag only.`);
  }

  if (
    strict &&
    stack !== null &&
    stack.framework !== null &&
    SSR_CAPABLE_FRAMEWORKS.has(stack.framework) &&
    !staticOutput
  ) {
    console.error(
      `mark-build: detected ${stack.framework}, which can deploy dynamic or hybrid server-rendered routes. ` +
        'Verifying a few generated HTML files cannot prove those routes contain the production widget. ' +
        'If—and only if—every deployed route is represented by complete static HTML, rerun with `mark-build --strict --static-output`; otherwise add and test a framework-specific SSR integration.',
    );
    return 1;
  }

  let dir: string | null;
  try {
    dir = resolveBuildDir(cwd, getStringFlag(args.flags, 'dir'));
  } catch (err) {
    console.warn(`mark-build: could not inspect the build output (${(err as Error).message}).`);
    return strict ? 1 : 0;
  }
  if (dir === null) {
    const message =
      'mark-build: no build output directory found (looked for dist/, build/, out/, .output/public). Pass --dir <path> if it is elsewhere. Nothing to mark.';
    console.warn(message);
    return strict ? 1 : 0;
  }

  let files: string[];
  try {
    files = findHtmlFiles(dir);
  } catch (err) {
    console.warn(`mark-build: could not scan HTML under ${dir} (${(err as Error).message}).`);
    return strict ? 1 : 0;
  }
  if (files.length === 0) {
    console.warn(`mark-build: no HTML files found under ${dir}. Nothing to mark.`);
    return strict ? 1 : 0;
  }

  const snippet = buildInjectionSnippet(
    checksum,
    stack,
    widgetEnabled ? siteUuid : null,
    widgetApiBaseUrl,
  );
  interface PreparedBuildFile {
    file: string;
    before: string;
    after: string;
  }
  const prepared: PreparedBuildFile[] = [];
  const failures: string[] = [];
  let fragments = 0;
  for (const file of files) {
    try {
      const before = readFileSync(file, 'utf8');
      if (!hasLiveHtmlDocument(before)) {
        fragments += 1;
        continue;
      }
      const after = injectMarker(before, snippet, {
        // An explicit widget opt-out removes a connector-managed tag. Missing or
        // invalid config in best-effort mode must preserve the valid tag already
        // emitted from source instead of silently deleting the widget.
        removeManagedWidget: widgetEnabled === false || siteUuid !== null,
      });
      const verification = verifyBuildHtml(
        after,
        siteUuid ?? '00000000-0000-0000-0000-000000000000',
      );
      const relevantIssues = verification.issues.filter(
        (issue) =>
          (widgetEnabled && siteUuid !== null) || !isWidgetVerificationIssue(issue),
      );
      if (relevantIssues.length > 0) {
        failures.push(`${displayBuildFile(cwd, file)}: ${relevantIssues.join(', ')}`);
      }
      prepared.push({ file, before, after });
    } catch (err) {
      failures.push(`${displayBuildFile(cwd, file)}: ${(err as Error).message}`);
    }
  }

  if (prepared.length === 0) {
    failures.push('no complete HTML documents were found in the selected output directory');
  }

  if (strict && failures.length > 0) {
    console.error(
      'mark-build: strict production verification failed; no output files were changed:',
    );
    for (const failure of failures) console.error(`  - ${failure}`);
    return 1;
  }

  for (const failure of failures) {
    console.warn(`mark-build: verification warning: ${failure}`);
  }

  let marked = 0;
  const written: PreparedBuildFile[] = [];
  for (const candidate of prepared) {
    if (candidate.after === candidate.before) continue;
    try {
      await atomicWriteTextFile(candidate.file, candidate.after);
      written.push(candidate);
      marked += 1;
    } catch (err) {
      const message = `mark-build: could not mark ${displayBuildFile(cwd, candidate.file)} (${(err as Error).message}).`;
      if (!strict) {
        console.warn(message);
        continue;
      }

      console.error(`${message} Restoring files already written by this run.`);
      let rollbackFailed = false;
      for (const completed of written.reverse()) {
        try {
          await atomicWriteTextFile(completed.file, completed.before);
        } catch (rollbackError) {
          rollbackFailed = true;
          console.error(
            `mark-build: could not restore ${displayBuildFile(cwd, completed.file)} (${(rollbackError as Error).message}).`,
          );
        }
      }
      if (rollbackFailed) {
        console.error('mark-build: manual restoration is required for the files reported above.');
      }
      return 1;
    }
  }

  const stackSummary = stack !== null ? describeStack(stack) : null;
  console.log(
    `mark-build: marked ${marked} HTML file(s) in ${dir}` +
      `${checksum !== null ? ` (build ${checksum})` : ''}` +
      `${stackSummary !== null ? ` [${stackSummary}]` : ''}` +
      `${widgetEnabled && siteUuid !== null ? ` and ${strict ? 'verified' : 'ensured'} the disclosure widget in ${prepared.length} complete document(s)` : ''}` +
      `${fragments > 0 ? `; ignored ${fragments} HTML fragment(s)` : ''}` +
      `${failures.length > 0 ? `; reported ${failures.length} warning(s)` : ''}.`,
  );
  return 0;
}

function isWidgetVerificationIssue(issue: BuildHtmlVerificationIssue): boolean {
  return issue.startsWith('widget-');
}

function displayBuildFile(cwd: string, file: string): string {
  return path.relative(cwd, file) || path.basename(file);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv);

  if (args.flags.has('help') || args.command === 'help' || args.command === null) {
    console.log(HELP);
    return 0;
  }
  validateCommandArgs(args);

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
    default:
      console.error(`Unknown command: ${args.command}\n`);
      console.error(HELP);
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof PatchstackError) {
      console.error(`Error (${err.code}): ${err.message}`);
      process.exitCode = 1;
      return;
    }
    console.error('Unexpected error:', err);
    process.exitCode = 2;
  });
