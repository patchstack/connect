import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { BuildMarker, Config, Environment } from './types.js';
import type { GuideState } from './guide.js';
import type { PackageSummary } from './client.js';
import { createRequire } from 'node:module';
import { ensureProjectDirectorySync, writeProjectFileSync } from './safe-file.js';

import { scanLockfile } from './parsers/index.js';
import { buildWirePayload, type WirePayload } from './normalize.js';
import { computeManifestChecksum } from './checksum.js';
import {
  postInputMap,
  buildManifestBody,
  claimOutcome,
  DEFAULT_ENDPOINT,
  buildClaimUrl,
  fetchClaimPreview,
  fetchClaimState,
  fetchSiteStatus,
  postManifest,
  postManifestWithEnvironmentFallback,
  canRetryManifestPost,
  postPackageRemoved,
  setRunCommand,
  hasSiteCredential,
  postRunNotice,
} from './client.js';
import { runWasLogged } from './report-context.js';
import { detectHostedBuilder } from './environment.js';
import {
  assertDemoDependency,
  assertPersistedSiteUuid,
  DemoError,
  inspectDemoDependency,
  readPersistedSiteUuid,
  renderDemoGuide,
  renderDemoTestCommands,
  resolveDemoScenario,
  waitForDemoRule,
} from './demo.js';
import {
  SECRET_CONFIG_FILENAME,
  credentialInCommittedConfig,
  persistApiKey,
  secretFileIgnored,
  persistClaimState,
  persistSiteUuid,
  resolveConfig,
  type ResolveConfigOptions,
  writeConfigFile,
  persistTimeout,
  persistWidgetChoice,
  hasWidgetChoice,
} from './config.js';
import { painter, renderBox, renderFindings, renderLogo } from './art.js';
import { detectHost, HOST_NAMES, parseHost, renderGoLive } from './go-live.js';
import { createSiteProject, installSelf, isPlainHtmlSite } from './bootstrap.js';
import {
  buildInjectionSnippet,
  buildSandboxSnippet,
  buildSourceMarkerSnippet,
  ensureSourceMarker,
  findHtmlFiles,
  hasEditableShell,
  injectMarker,
  removeHandMarkers,
  productionGate,
  resolveBuildDir,
  buildDirCandidates,
  marksPublishedBuild,
  staleBuildAge,
} from './mark-build.js';
import {
  collectGuideState,
  detectPackageManager,
  DEV_ONLY_INSTALL,
  guideMissing,
  guideNextStepContext,
  notConnectedItem,
  guideProgress,
  installCommand,
  renderGuideChecklist,
  resolveWidgetFileHint,
  resolveWidgetShellDir,
} from './guide.js';
import { type NextStepContext, type Progress } from './progress.js';
import {
  BUILD_SCRIPTS_CHANGE,
  emptyReport,
  INSTALL_SCRIPT_CHANGE,
  NEXT_INTRO,
  recordChange,
  renderHookSummary,
  renderNext,
  renderStatus,
  renderSummary,
  SUMMARY_HEADING,
  SUMMARY_INTRO,
  type StatusReport,
} from './report.js';
import { login, readPendingLogin, redeemIfApproved, startLogin, waitForApproval } from './login.js';
import {
  claim,
  readPendingClaim,
  redeemClaimIfApproved,
  startClaim,
  waitForClaim,
  type ClaimResult,
} from './claim.js';
import { runProtect, runVerify } from './protect/install/index.js';
import { formatRuntimeCheck, runRuntimeCheck, runtimeExitCode } from './protect/install/runtime/check.js';
import { runMap } from './map-command.js';
import { bundleRulesAllowed } from './bundled-rules.js';
import { getStringFlag } from './flags.js';
import { isCanonicalUuid } from './endpoint-policy.js';
import { setupProtection, wireBuildScripts, wireDevelopmentScript } from './setup.js';
import { runDevelopment } from './dev-command.js';
import { checkActivation } from './activation-check.js';
import { syncSetupProtection } from './setup-sync.js';
import { isInstallOrBuildHook, isPreBundleBuildHook, undeliveredReportLines } from './build-hook.js';
import { applyBuildStamp } from './build-stamp.js';
import { detectStack, type StackDescriptor } from './stack.js';
import { PatchstackError, type StoreManifestResponse } from './types.js';
import { buildWidgetTag, ensureSourceWidget, ensureWidgetInHtml, removeSourceWidget } from './widget.js';

/** What `npx @patchstack/connect` shows with no command: where to start, and the few commands that follow. */
function startScreen(color: boolean): string[] {
  const paint = painter(color);
  const command = (name: string, does: string): string => `  ${paint('cyan', `npx @patchstack/connect ${name.padEnd(7)}`)}  ${paint('dim', does)}`;
  return [
    paint('bold', 'Patchstack Connect: find and fix vulnerable packages in your app'),
    '',
    'Start here. One command sets everything up:',
    `  ${paint('cyan', 'npx @patchstack/connect setup')}`,
    '',
    'Then:',
    command('next', 'what to do next'),
    command('vulns', 'see what was found'),
    command('widget', 'show Patchstack inside your app (optional)'),
    command('go-live', 'how to go live on your host'),
    command('status', 'the link to connect your account'),
    command('summary', 'the setup summary again'),
    '',
    paint('dim', 'All commands: npx @patchstack/connect --help'),
  ];
}

const HELP = `@patchstack/connect — scan your lockfile and report packages to Patchstack.

Usage:
  patchstack-connect dev -- <command> [args]         Run an explicitly requested dev server with
                                                     coalesced structural map uploads and rule pulls.
                                                     Map-specific rules detect only during hot reload.
  patchstack-connect scan   [options]                Scan lockfile and POST to Patchstack.
                                                     If no UUID is configured, the server
                                                     provisions one and we persist it. After a
                                                     successful post it also adds/updates the
                                                     Patchstack Connector <script> tag in the root
                                                     HTML shell (index.html, public/index.html,
                                                     or src/app.html) — opt out with
                                                     "widget": false in .patchstackrc.json.
                                                     Run as a postinstall/prebuild/build hook, a
                                                     report Patchstack cannot accept is printed
                                                     and exits 0 so the build goes on; run
                                                     directly, the same failure exits 1
  patchstack-connect setup  [options]                Finish the bounded project setup: run scan,
                                                     manage the widget, install + verify runtime
                                                     protection, upload the attack-surface map, pull
                                                     live rules, and wire dependency/build scans.
                                                     Never runs the project build
  patchstack-connect map    [--dir <p>] [--out <f>] [--upload]
                                                     Map the app's attack surface: entry points, the
                                                     inputs each reads, the sinks it can reach, and
                                                     evidence-backed input→sink flows (each labelled
                                                     with how the link was established). Best-effort static
                                                     analysis — reports the DETECTED surface, with
                                                     coverage counters. Prints JSON (--out writes a
                                                     file; a pre-bundle --upload also stamps the existing
                                                     guard rules file; --follow-symlinks leaves the project dir).
                                                     Uses the app's own TypeScript
  patchstack-connect init   <site-uuid>              Optional: pre-seed .patchstackrc.json
                                                     with an existing site UUID
  patchstack-connect status [options]                Show current configuration and whether the
                                                     site still exists on Patchstack (active /
                                                     removed)
  patchstack-connect next                            Say where this project stands and the one thing
                                                     to do now: connect the account, or go live.
                                                     Sends the site UUID to the public claim page;
                                                     updates the connected note in .patchstackrc.json
  patchstack-connect summary                         Print the summary the last setup wrote, from
                                                     .patchstack/summary.md. Sends nothing; writes
                                                     nothing
  patchstack-connect vulns                           Show what Patchstack found in this project's
                                                     packages: vulnerabilities by severity and
                                                     outdated packages, with the link to the
                                                     details. Sends the site UUID to the public
                                                     claim page; writes nothing
  patchstack-connect go-live [--host <name>]         Show how to add the project's API key to its
                                                     host and deploy: the host is found from project
                                                     files (vercel.json, netlify.toml, fly.toml, ...)
                                                     or named with --host. Never prints the key.
                                                     Sends nothing; writes nothing
  patchstack-connect widget [--remove]               Add the Patchstack widget to the project's page,
                                                     or take the Connect-added tag out with --remove.
                                                     Saves the choice in .patchstackrc.json so the
                                                     build hooks follow it (setup --widget does the
                                                     same). Sends nothing
  patchstack-connect uninstall [options]             Signal Patchstack that this package is being
                                                     removed from the project. An unclaimed site
                                                     record is deleted; a claimed site is flagged
                                                     for its owner to remove in the dashboard.
                                                     Does NOT touch local files — see the
                                                     "Uninstalling" steps in AGENT-INSTALL.md
  patchstack-connect mark-build [options]            Stamp built HTML with a production flag +
                                                     build fingerprint, and ensure the widget
                                                     tag in built pages (run as a postbuild step).
                                                     The flag marks a page as the LIVE site, so it
                                                     is stamped only on a production build; a local
                                                     or preview build gets the widget tag and no
                                                     marker (and any stale marker is removed).
                                                     Looks in the framework's own output dir, an
                                                     --output the build script names, then dist/,
                                                     build/, out/, .output/public/, _site/ — inside
                                                     the project only. --dir <path> overrides.
  patchstack-connect protect [--demo|--check]        Install always-on runtime protection (the
                                                     guard). Auto-wires supported server stacks;
                                                     for others it scaffolds a
                                                     generic guard + prints a wiring plan.
                                                     --demo seeds a broad sample rule set (for
                                                     demonstrations, not production).
                                                     --check verifies the guard is wired (exit 1
                                                     if not) — for the wire-then-verify loop.
                                                     It reads the app's source and never runs it.
                                                     --check --runtime additionally STARTS THE APP
                                                     on a loopback port and sends it one request,
                                                     to establish that a request reaches the
                                                     guard. Opt-in, and the only mode that runs
                                                     the app. Exit 0 traversed, 1 a listener
                                                     answered instead of the guard, 2 could not
                                                     be established (e.g. a TypeScript or
                                                     framework entry this must not start).
  patchstack-connect demo node-serialize [--url URL] Run the production-backed node-serialize
                                                     walkthrough: verify the vulnerable package,
                                                     scan it, wait for live rule 18843, install +
                                                     verify the guard, and print test requests.
                                                     Does not install vulnerable dependencies.
  patchstack-connect demo-guide node-serialize       Show a read-only, state-aware walkthrough for
                                                     preparing, running, proving, and cleaning up
                                                     the production-backed local demo.
  patchstack-connect guide [--full]                  Show this project's setup status: what is left
                                                     to do and the four steps, with tailored
                                                     commands. --full adds the full setup reference
                                                     (AGENT-INSTALL.md)
  patchstack-connect claim  [--wait]                 Attach this site to a Patchstack account from
                                                     the terminal, so its reports become visible.
                                                     Prints a link for the user to open and sign in
                                                     (or sign up) — whoever approves becomes the
                                                     site's owner. In a terminal it then waits. When
                                                     the output is piped or captured — an assistant
                                                     running it — it prints the link and EXITS, so
                                                     the link is visible immediately. Run it AGAIN
                                                     once the user confirms: it resumes the same
                                                     request rather than starting a new one. --wait
                                                     blocks instead of returning. Does not rotate
                                                     the site's credential. The same claim can be
                                                     done by opening the dashboard link that scan
                                                     and status print. Not usable in CI
  patchstack-connect login  [--wait]                 Recover this site's credential when
                                                     .patchstackrc.local.json has been lost. Needs the
                                                     site UUID, which lives in the committed
                                                     .patchstackrc.json. Prints a link
                                                     for the site's OWNER to approve in the dashboard.
                                                     In a terminal it then waits. When the output is
                                                     piped or captured — an assistant running it — it
                                                     prints the link and EXITS, so the link is visible
                                                     immediately. Run it AGAIN once the user confirms
                                                     they approved: it resumes the same request rather
                                                     than starting a new one, and finishes the flow.
                                                     --wait blocks instead of returning. Use this
                                                     instead of deleting
                                                     .patchstackrc.json and re-scanning, which would
                                                     provision a second site. Approving ROTATES the
                                                     credential: CI, deploys and other machines using
                                                     the old one must be updated. Not usable in CI
  patchstack-connect help                            Print this message

Global:
  --version               Print the installed version of this package and exit
  --help                  Print this help and exit
  --verbose               Also print the technical detail: site ID, endpoint, checksum,
                          environment and why, files written, installer steps

Options (for scan, setup, status, and uninstall):
  --dev-sync             (setup only) Opt in to continuous development synchronization
                         for a recognizable single-command dev script.
  --runtime-url <url>    (setup / protect --check) Signed read-only check of an already
                         running URL. Does not start, restart or deploy the application.
  --site-uuid <uuid>      Override the configured site UUID
  --endpoint <url>        Override the API endpoint
  --dry-run               (scan only) Show the payload without posting
  --install-paths         (scan only) Also send where each package is installed
                          in the dependency tree (node_modules/lodash, and the
                          same under a workspace that pins its own copy), so an
                          advisory can be matched to the copy your code actually
                          loads. Off by default; never source file paths
  --claim-token <token>   (scan, setup) Connect the site to the Patchstack account
                          that issued the token — it comes from the dashboard's
                          "Connect website" prompt. PATCHSTACK_CLAIM_TOKEN works
                          too. Never written to a file, never printed back

Options (for mark-build):
  --dir <path>            Build output directory (default: auto-detect the
                          framework's own output dir, an --output the build
                          script names, then dist/ build/ out/ .output/public/
                          _site/ — inside the project only)
  --production            Stamp the live-site marker on a build this command
                          cannot tell is a deployment — publishing a static
                          build by hand from a laptop, say. PATCHSTACK_ENVIRONMENT=production
                          does the same. Never needed on a hosting platform,
                          whose own build is recognised

Options (for demo and demo-guide):
  --url <url>             Test endpoint printed at the end
                          (default: http://localhost:3000/api/tasks)

Environment:
  PATCHSTACK_SITE_UUID    Site UUID
  PATCHSTACK_API_KEY      WP-format site API key for block-log reporting (never put in the widget)
  PATCHSTACK_PULSE_AUTH   Only if Pulse ingest uses a different credential from block-logs
  PATCHSTACK_TELEMETRY    Set to off to disable block-log reporting
  PATCHSTACK_API_BASE     API origin for /oauth/token and /api/logs/log (default: https://api.patchstack.com)
  PATCHSTACK_ENDPOINT     API endpoint (default: https://api.patchstack.com/monitor/pulse/manifest)
  PATCHSTACK_TIMEOUT_MS   Request timeout in ms (default: 30000; a scan that needs longer saves what worked to .patchstackrc.json)
  PATCHSTACK_ENVIRONMENT  Manifest label: production, sandbox or local. Unset, the build platform's own tier or branch name decides; a developer machine reports local.
  PATCHSTACK_MODE         (protect) Runtime guard mode: block (default) | dry-run
  PATCHSTACK_ROUTE_WAF    (protect) Set to 1 to also screen every request at the route level (opt-in)

Precedence, site UUID and settings: CLI flag > environment variable > .patchstackrc.json (committed).
Precedence, API key: environment variable > .patchstackrc.local.json (git-ignored) > .patchstackrc.json.

Examples:
  npx @patchstack/connect setup
  npx @patchstack/connect scan
  npx @patchstack/connect scan --dry-run
  npx @patchstack/connect init 550e8400-e29b-41d4-a716-446655440000
  npx @patchstack/connect scan --site-uuid 550e8400-...-446655440000
  npx @patchstack/connect demo node-serialize
  npx @patchstack/connect demo-guide node-serialize
`;

const VALUE_FLAGS = new Set(['site-uuid', 'endpoint', 'dir', 'url', 'out', 'claim-token', 'host', 'runtime-url']);

/** Set from `--verbose`. The default output is a plain status report; this adds the technical lines. */
let verbose = false;

/** Terminal width for the concise report's box, when stdout is a terminal. */
function terminalColumns(): number | undefined {
  return process.stdout.isTTY ? process.stdout.columns : undefined;
}

/** The follow-up commands the concise report ends on: details always, the widget only when it is not there. */
function followUpMenu(state: GuideState): Array<{ command: string; does: string }> {
  if (state.siteUuid === null) return [];
  return [
    { command: 'npx @patchstack/connect vulns', does: 'see what was found' },
    ...(state.widgetInstalled ? [] : [{ command: 'npx @patchstack/connect widget', does: 'show Patchstack inside your app (optional)' }]),
    { command: 'npx @patchstack/connect go-live', does: 'how to go live on your host' },
  ];
}

function detail(line: string): void {
  if (verbose) console.log(line);
}

function useColor(): boolean {
  return process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
}

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

/** The site/endpoint overrides every command accepts, resolved against the current directory. */
function resolveCliConfig(
  args: ParsedArgs,
  extra: Omit<ResolveConfigOptions, 'cwd' | 'cliSiteUuid' | 'cliEndpoint'> = {},
): Promise<Config> {
  return resolveConfig({
    cwd: process.cwd(),
    cliSiteUuid: getStringFlag(args.flags, 'site-uuid'),
    cliEndpoint: getStringFlag(args.flags, 'endpoint'),
    ...extra,
  });
}

/**
 * Whether a build agent is running this. `CI=false` is how a platform says "not a CI build", so it
 * counts as absent — the interactive commands refuse only where there is really no one to answer.
 */
function runningInCi(): boolean {
  return process.env.CI !== undefined && process.env.CI !== '' && process.env.CI !== 'false';
}

/**
 * What became of the credential file's ignore entry, for the person reading the output.
 *
 * Only claimed when `.gitignore` was read back and really covers it: an assurance that turns out to be
 * false is worse than none, because it is the reason somebody stops checking.
 */
function gitignoreOutcomeLine(ignore: { ignored: boolean; reason?: string }): string {
  return ignore.ignored
    ? '    Added to .gitignore.'
    : `    NOT ignored by git — ${ignore.reason ?? 'unknown reason'}. Add it to .gitignore yourself before committing.`;
}

async function runInit(args: ParsedArgs): Promise<number> {
  const uuid = args.positional[0];
  if (!uuid) {
    console.error('Error: site UUID is required.\n');
    console.error('Usage: patchstack-connect init <site-uuid>');
    return 1;
  }
  if (!isCanonicalUuid(uuid)) {
    console.error(`Error: "${uuid}" does not look like a valid UUID.`);
    return 1;
  }

  const target = await writeConfigFile(process.cwd(), { siteUuid: uuid });
  console.log(`Wrote ${target}`);
  console.log('');
  console.log('Next: run `npx @patchstack/connect scan`.');
  return 0;
}

async function runClaim(args: ParsedArgs): Promise<number> {
  // No browser and no human to sign in. A deploy inherits an already-claimed site; it never claims.
  if (runningInCi()) {
    console.error('`claim` is interactive and cannot run in CI. Claim the site from a developer machine.');
    return 1;
  }

  const config = await resolveCliConfig(args);

  const siteUuid = config.siteUuid;
  if (siteUuid === null) {
    console.error('\n  No site to claim yet — run `npx @patchstack/connect scan` first.\n');
    return 1;
  }

  const settled = async (result: ClaimResult): Promise<number> => {
    await recordClaimState(config, siteUuid, true);
    console.log(
      `\n  ✓ Site claimed${result.account !== undefined ? ` by ${result.account}` : ''}.`,
    );
    console.log(`    ${result.dashboardUrl ?? buildClaimUrl(config.endpoint, siteUuid)}`);
    if (result.credentialSaved === true) {
      const ignore = await secretFileIgnored(process.cwd());
      // The value itself is never printed — only that it landed, and only that it is ignored when it is.
      console.log(`    Saved a new credential to ${SECRET_CONFIG_FILENAME}.`);
      console.log(gitignoreOutcomeLine(ignore));
    }
    console.log('');
    return 0;
  };

  const prompt = (userCode: string, verificationUri: string) => {
    console.log(`\n  Your code:  ${userCode}`);
    console.log(`  Claim at:   ${verificationUri}\n`);
    console.log('  Open the link and sign in (or sign up) to connect this site. Whoever approves owns it.\n');
  };

  if (args.flags.has('wait')) {
    const pending = readPendingClaim(siteUuid);

    if (pending === null) {
      console.error('\n  No claim is waiting for approval. Run `patchstack-connect claim` first.\n');
      return 1;
    }

    const resumed = await waitForClaim(config, pending);
    if (resumed.status === 'claimed') return await settled(resumed);

    console.error(`\n  ${resumed.message ?? 'Claim failed.'}\n`);
    return 1;
  }

  // Nobody is watching this stream. Blocking here would hide the link until the command exits — by
  // which time the code has expired — so hand it over and let the caller decide when to wait.
  if (process.stdout.isTTY !== true) {
    // Running it again resumes rather than restarts, so re-running never invalidates a link the user
    // is still looking at.
    const existing = readPendingClaim(siteUuid);

    if (existing !== null && Date.now() < existing.expiresAt) {
      const outcome = await redeemClaimIfApproved(config, existing);

      if (outcome !== 'pending' && outcome.status === 'claimed') return await settled(outcome);

      if (outcome === 'pending') {
        const secondsLeft = Math.round((existing.expiresAt - Date.now()) / 1000);
        console.log(`\n  Still waiting for the site to be claimed with code ${existing.userCode}.`);
        console.log(`  Claim at: ${existing.verificationUri}`);
        console.log(`  (valid for another ${secondsLeft}s — run this again once the user confirms)\n`);
        return 0;
      }
      // 'expired' falls through and starts a fresh request below.
    }

    const started = await startClaim(config);

    if (started.status !== 'started' || started.pending === undefined) {
      // An already-claimed site is the goal state, not a failure: an assistant re-running this after
      // the user claimed in the browser must not report the setup as broken.
      if (started.status === 'already-claimed') {
        await recordClaimState(config, siteUuid, true);
        console.log(`\n  ${started.message ?? 'This site is already claimed.'}\n`);
        return 0;
      }
      console.error(`\n  ${started.message ?? 'Claim failed.'}\n`);
      return 1;
    }

    prompt(started.pending.userCode, started.pending.verificationUri);
    console.log('  Give the link to the user. Once they approve, run this command again (or `claim --wait`).\n');

    return 0;
  }

  const result = await claim(config, (userCode, verificationUri) => {
    prompt(userCode, verificationUri);
    console.log('  Waiting (the code expires in 10 minutes)…');
  });

  if (result.status === 'claimed') return await settled(result);
  if (result.status === 'already-claimed') {
    await recordClaimState(config, siteUuid, true);
    console.log(`\n  ${result.message ?? 'This site is already claimed.'}\n`);
    return 0;
  }

  console.error(`\n  ${result.message ?? 'Claim failed.'}\n`);

  return 1;
}

async function runLogin(args: ParsedArgs): Promise<number> {
  // CI has no browser and no human; build agents must not print credentials
  // into logs. Deploys use PATCHSTACK_API_KEY from the platform's secrets.
  if (runningInCi()) {
    console.error('`login` is interactive and cannot run in CI. Set PATCHSTACK_API_KEY instead.');
    return 1;
  }

  const config = await resolveCliConfig(args);

  // Checked here rather than carried up from the write: the rotation happens several layers down, and the
  // claim belongs to the line that prints it.
  const approved = async () => {
    const ignore = await secretFileIgnored(process.cwd());
    // The value itself is never printed — only that it landed, and only that it is ignored when it is.
    console.log(`\n  ✓ Credential restored and saved to ${SECRET_CONFIG_FILENAME}.`);
    console.log(gitignoreOutcomeLine(ignore));
    console.log('    The old credential no longer works. Update it in CI, hosting and other checkouts.\n');
    return 0;
  };

  // Resuming a request whose link has already been handed to the user.
  if (args.flags.has('wait')) {
    const pending = config.siteUuid === null ? null : readPendingLogin(config.siteUuid);

    if (pending === null) {
      console.error('\n  No login is waiting for approval. Run `patchstack-connect login` first.\n');
      return 1;
    }

    const resumed = await waitForApproval(config, pending);
    if (resumed.status === 'approved') return await approved();

    console.error(`\n  ${resumed.message ?? 'Login failed.'}\n`);
    return 1;
  }

  const prompt = (userCode: string, verificationUri: string) => {
    console.log(`\n  Your code:  ${userCode}`);
    console.log(`  Approve at: ${verificationUri}\n`);
    // Said before approval, not after: the person deciding needs to know it is
    // a rotation, and an assistant relaying this has to pass the warning on.
    console.log("  Open the link and approve as the site's owner. This replaces the current credential,");
    console.log('  so CI, deploys and other machines will need the new one.\n');
  };

  // Nobody is watching this stream. Blocking here would hide the link until the
  // command exits — by which time the code has expired — so hand it over and
  // let the caller decide when to wait.
  if (process.stdout.isTTY !== true) {
    // Running it again resumes rather than restarts. An assistant that comes
    // back after the user approves finishes the flow whether or not it
    // remembered --wait, and re-running never invalidates a link the user is
    // still looking at.
    const existing = config.siteUuid === null ? null : readPendingLogin(config.siteUuid);

    if (existing !== null && Date.now() < existing.expiresAt) {
      const outcome = await redeemIfApproved(config, existing);

      if (outcome === 'approved') return await approved();

      if (outcome === 'pending') {
        const secondsLeft = Math.round((existing.expiresAt - Date.now()) / 1000);
        console.log(`\n  Still waiting for approval of code ${existing.userCode}.`);
        console.log(`  Approve at: ${existing.verificationUri}`);
        console.log(`  (valid for another ${secondsLeft}s — run this again once the user confirms)\n`);
        return 0;
      }
      // 'expired' falls through and starts a fresh request below.
    }

    const started = await startLogin(config);

    if (started.status !== 'started' || started.pending === undefined) {
      console.error(`\n  ${started.message ?? 'Login failed.'}\n`);
      return 1;
    }

    prompt(started.pending.userCode, started.pending.verificationUri);
    console.log('  Give the link to the user. Once they approve, run this command again (or `login --wait`).\n');

    return 0;
  }

  const result = await login(config, (userCode, verificationUri) => {
    prompt(userCode, verificationUri);
    console.log('  Waiting for approval (the code expires in 10 minutes)…');
  });

  if (result.status === 'approved') return await approved();

  console.error(`\n  ${result.message ?? 'Login failed.'}\n`);

  return 1;
}

/** How much longer a timed-out report is given, and the most it will ever be given. */
const RETRY_TIMEOUT_FACTOR = 4;
const MAX_RETRY_TIMEOUT_MS = 180_000;

/**
 * Post the manifest, and if the request times out, once more with room to finish.
 *
 * A first report is the slow one: the server registers the site and checks every package, and on a
 * large manifest that outruns the default. Failing there is the worst place to fail — in a build hook the
 * scan then fails open, the build succeeds, and the site quietly never reports. So a timeout is retried
 * with the limit raised, and a limit that turned out to be needed is written to `.patchstackrc.json`, where
 * the build that runs in CI reads it too. A limit nobody needed is not written: the file stays as the
 * person left it.
 */
/**
 * Post the manifest under the label the server accepts, and say so (with --verbose) when that was not
 * the label asked for.
 *
 * A server that predates the `local` label refuses it; the report then goes as `sandbox`, the nearest
 * label that server has for "not the live site".
 */
async function postManifestAccepted(
  config: Config,
  payload: Parameters<typeof postManifest>[1],
): Promise<StoreManifestResponse> {
  const { response, environmentUsed } = await postManifestWithEnvironmentFallback(config, payload);
  if (environmentUsed !== config.environment) {
    detail(
      `This Patchstack API does not know the ${config.environment} label yet; the report was accepted as ${environmentUsed}, which also keeps it apart from production.`,
    );
  }
  return response;
}

async function postManifestWithPatience(
  config: Config,
  payload: Parameters<typeof postManifest>[1],
): Promise<StoreManifestResponse> {
  // The first report is the one that provisions the site and issues its credential, and it carries no
  // idempotency key: a timeout says nothing about whether the server committed, so sending it twice can
  // provision two sites. It is never retried. It is also the slow one — the server registers the site and
  // checks every package — so it gets the room a retry would have given it, up front and once.
  if (!canRetryManifestPost(config)) {
    const timeoutMs = Math.max(config.timeoutMs, Math.min(config.timeoutMs * RETRY_TIMEOUT_FACTOR, MAX_RETRY_TIMEOUT_MS));
    return postManifestAccepted({ ...config, timeoutMs }, payload);
  }

  try {
    return await postManifestAccepted(config, payload);
  } catch (err) {
    if (!(err instanceof PatchstackError) || err.code !== 'NETWORK_TIMEOUT') throw err;

    const timeoutMs = Math.min(config.timeoutMs * RETRY_TIMEOUT_FACTOR, MAX_RETRY_TIMEOUT_MS);
    if (timeoutMs <= config.timeoutMs) throw err;

    console.warn('Patchstack is slow to answer. Trying once more…');
    detail(`The report timed out after ${config.timeoutMs}ms; trying once more with ${timeoutMs}ms.`);
    const response = await postManifestAccepted({ ...config, timeoutMs }, payload);

    try {
      const target = await persistTimeout(process.cwd(), timeoutMs);
      detail(`Saved a ${timeoutMs}ms request timeout to ${target}, so builds inherit it.`);
    } catch {
      console.warn(`Could not save the longer wait. Set PATCHSTACK_TIMEOUT_MS=${timeoutMs} where your builds run.`);
    }
    return response;
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

async function runScan(
  args: ParsedArgs,
  options: {
    /** Collect this run's results here instead of printing them, for a caller that prints its own report. */
    report?: StatusReport;
    /** False prints only what this run did, without the checklist. */
    showRemainingSetup?: boolean;
    /** What the report established, for a caller that prints its own checklist. */
    onReported?: (outcome: Omit<Progress, 'installed'>) => void;
  } = {},
): Promise<number> {
  const dryRun = args.flags.get('dry-run') === true;
  // A preview exists to check what would be sent, so it shows every detail.
  const say = (line: string): void => {
    if (verbose || dryRun) console.log(line);
  };
  const report = options.report ?? emptyReport();
  const config = await resolveCliConfig(args, {
    cliClaimToken: getStringFlag(args.flags, 'claim-token'),
    // The one command that reports them, so the one command that resolves them.
    detectSiteIdentity: true,
  });
  const manifest = await scanLockfile(process.cwd());
  for (const warning of manifest.warnings ?? []) {
    if (dryRun) console.warn(`patchstack: ${warning}`);
    else report.missing.push({ text: warning });
  }
  // Off unless asked for: locations widen what leaves the machine, so the upload that carries them is an
  // explicit choice rather than something an upgrade turns on.
  const installPaths = args.flags.get('install-paths') === true;
  const { payload, stats } = buildWirePayload(manifest, { installPaths });

  say(`Found ${payload.packages.length} package versions across ${stats.uniqueNames} packages (${manifest.ecosystem}).`);
  if (installPaths) {
    const located = payload.packages.filter((pkg) => pkg.paths !== undefined).length;
    console.log(
      payload.installPathsComplete
        ? `Including install locations (--install-paths) for all ${located}.`
        : `Including install locations (--install-paths) for ${located} of ${payload.packages.length}. This lockfile does not record the rest; they are sent as "not recorded".`,
    );
  }
  // The label decides how the dashboard reads this report — a production build is contact with a live
  // site, a local one is inventory — so the detail says which, and what decided it.
  if (config.environment === 'local') {
    const because = (config.environmentEvidence ?? []).join('; ') || 'this machine';
    say(`Environment: local (${because}). Set PATCHSTACK_ENVIRONMENT=production on a live build your host does not identify.`);
  } else {
    const because = (config.environmentEvidence ?? []).length > 0
      ? ` (${config.environmentEvidence!.join('; ')})`
      : '';
    say(`Environment: ${config.environment}${because}.`);
  }
  const overruled = ignoredFileEnvironmentWarning(config);
  if (overruled !== null) console.warn(`patchstack: ${overruled}`);
  if (config.endpoint !== DEFAULT_ENDPOINT) {
    say(`Endpoint override: ${config.endpoint}`);
  }
  if (stats.duplicateNames.length > 0) {
    const sample = stats.duplicateNames.slice(0, 10).join(', ');
    const more =
      stats.duplicateNames.length > 10 ? `, +${stats.duplicateNames.length - 10} more` : '';
    say(`${stats.duplicateNames.length} package(s) at more than one version: ${sample}${more}`);
  }

  // Ahead of the --dry-run return, so a preview says what a real run would report. This is the part of
  // the payload someone might disagree with, and it is easier to disagree with here than in the dashboard.
  const body = buildManifestBody(config, payload);
  if (typeof body.url === 'string') {
    say(`Reporting app address: ${body.url}`);
  }
  if (typeof body.name === 'string') {
    say(`Reporting app name: "${body.name}"`);
  }
  // Named but never printed: the token is a credential for the person's account, and it travels as a
  // header rather than in the body so that the payload preview below stays the whole body.
  if (typeof config.claimToken === 'string' && config.claimToken !== '') {
    say('Claim token set. The site will join the Patchstack account that issued it.');
  }

  if (dryRun) {
    console.log('');
    if (config.siteUuid === null) {
      console.log('--dry-run: no site UUID configured. A real run would provision one.');
    } else {
      console.log(`--dry-run: not posting to Patchstack (site UUID ${config.siteUuid}).`);
    }
    console.log('Payload preview:');
    const preview = JSON.stringify(body, null, 2).split('\n');
    console.log(preview.slice(0, Math.min(preview.length, 30)).join('\n'));
    if (preview.length > 30) {
      console.log(`  ... (${preview.length - 30} more lines)`);
    }
    return 0;
  }

  // A prebuild starts with no inherited binding. `map --upload` may write one later in the same build,
  // derived from the document it uploads. Clearing first prevents a build that does not upload a map
  // from carrying a previous build's assertion into its artifact.
  if (isPreBundleBuildHook()) {
    const cleared = applyBuildStamp(process.cwd(), null);
    if (cleared.kind === 'cleared') say(`Removed the previous map binding from ${cleared.file}.`);
  }

  // Ahead of the post deliberately. The marker carries no site UUID and needs no
  // server round-trip, while `scan` is commonly chained as `scan || true`, so a
  // failed or offline post must not be what decides whether a published build
  // gets its production flag. --dry-run has already returned by here.
  const shellFramework = detectStack(payload.packages).framework;
  // Independent of the widget: the marker is how Patchstack recognises the live build, with or without
  // the widget on the page. The checksum is the manifest this run is posting — on a pre-build hook the
  // build about to be compiled — so the page says which build is live, the question the dashboard grades on.
  reportSourceMarker(shellFramework, computeManifestChecksum(payload.packages), report);

  const provisioning = config.siteUuid === null;
  if (provisioning) {
    say('No site yet. Creating one on Patchstack…');
  }

  // Hooked into an install or build, the report is this command's concern and the build is not: the
  // failure is said in full on stderr and the build goes on. A direct `scan` still exits non-zero for it.
  // So does a hosted builder's copy without the key — its publish, or a clone — whose `bun install` hook
  // Bun does not name: that copy is expected to hold no key, and nothing was sent.
  let response: StoreManifestResponse;
  try {
    response = await postManifestWithPatience(config, payload);
  } catch (err) {
    const keylessBuilderCopy = err instanceof PatchstackError && err.code === 'UNAUTHORIZED'
      && !hasSiteCredential(config) && detectHostedBuilder(process.cwd()) !== null;
    if (!(err instanceof PatchstackError) || !(isInstallOrBuildHook() || keylessBuilderCopy)) throw err;
    for (const line of undeliveredReportLines(err, config, process.cwd())) console.error(line);
    return 0;
  }

  const checked = `Checked ${plural(stats.uniqueNames, 'package', 'packages')}`;
  report.checked = stats.uniqueNames;
  if (response.stored) {
    report.done.unshift(checked);
    say(`Stored manifest #${response.manifest_id} (checksum ${response.checksum}).`);
  } else if (response.reason === 'duplicate') {
    report.done.unshift(checked, 'No changes since the last check');
  } else if (response.reason === 'build-reported') {
    report.done.unshift(checked, response.message ?? 'Reported this production build');
  } else {
    report.missing.push({
      text: 'Patchstack did not save this check',
      plain: { text: 'Patchstack did not save this check', hint: ['Try again in a few minutes.'] },
      hint: [response.message ?? 'Run this again in a few minutes.'],
      detail: [`Server response: ${JSON.stringify(response)}`],
    });
  }

  // The server always returns the UUID. If we didn't have one, persist it so
  // every subsequent scan targets the same site.
  if (provisioning && response.uuid !== undefined && response.uuid.length > 0) {
    const claimUrl = config.endpointTrusted !== false ? buildClaimUrl(config.endpoint, response.uuid) : null;
    const target = await persistSiteUuid(process.cwd(), response.uuid, claimUrl);
    report.done.push('Added this project to Patchstack');
    recordChange(report, path.relative(process.cwd(), target) || target, 'site ID and connect link, safe to commit');
    say(`Created site ${response.uuid}. Saved it${claimUrl !== null ? ' and the link to connect it' : ''} to ${target}.`);
  }
  if (typeof response.api_key === 'string' && response.api_key.length > 0) {
    // One credential for both paths: Pulse resolution falls back to apiKey, so
    // a second copy under pulseAuth bought nothing except an obligation to keep
    // the two in step. Never printed — only the path it landed in.
    const hadCredentialInConfig = await credentialInCommittedConfig(process.cwd());
    const saved = await persistApiKey(process.cwd(), response.api_key);
    // "Never commit" is said either way. Git-ignored only when the ignore file was read back and really
    // covers it: an assurance that turns out to be false is the reason somebody stops checking.
    if (saved.ignored) {
      report.done.push(`Saved the project's API key in ${SECRET_CONFIG_FILENAME}. Never commit this file`);
      recordChange(report, SECRET_CONFIG_FILENAME, 'API key, ignored by git. Never commit it');
      say(`Saved API key to ${saved.path} (git-ignored).`);
    } else {
      report.missing.push({
        text: `${SECRET_CONFIG_FILENAME} holds your API key, and git does not ignore it`,
        hint: [`Add ${SECRET_CONFIG_FILENAME} to .gitignore before you commit. Never commit this file.`],
        plain: {
          text: 'Your API key could end up in git',
          hint: [`Add ${SECRET_CONFIG_FILENAME} to .gitignore before you commit.`],
        },
        detail: [`Saved to ${saved.path}. Not ignored: ${saved.reason ?? 'unknown reason'}.`],
      });
    }
    if (hadCredentialInConfig) {
      // Moving the file does not undo a commit: if it was ever pushed, only a new credential ends that.
      report.missing.push({
        text: 'Your API key was in .patchstackrc.json',
        hint: [
          `It is now in ${SECRET_CONFIG_FILENAME}. If .patchstackrc.json was ever committed, replace the key in the Patchstack dashboard.`,
        ],
      });
    }
  }

  // What became of the claim token, in the person's terms. Said whenever one was passed — including
  // when the server said nothing about it — so a token that did not connect the project is never
  // mistaken for one that did.
  const claim = claimOutcome(response.claim, config);
  if (claim !== null && claim.connected) {
    report.done.push(claim.dashboardUrl !== null ? `${claim.summary}: ${claim.dashboardUrl}` : claim.summary);
  } else if (claim !== null) {
    report.missing.push(notConnectedItem([`${claim.summary}.`, ...claim.hint]));
  }
  const tokenConnected = response.claim?.state === 'claimed' || response.claim?.state === 'owned-by-you';

  // With a UUID in hand (existing or freshly provisioned), ensure the Patchstack widget's managed tag in
  // the source HTML shell so the next preview reload shows it. Best-effort; a failed post never reaches
  // this point, and --dry-run returned above.
  const effectiveUuid = config.siteUuid ?? response.uuid ?? null;
  if (config.widget && effectiveUuid !== null && effectiveUuid.length > 0) {
    reportSourceWidget(effectiveUuid, shellFramework, report);
  }

  const { connected, findings } = await resolveConnected(config, effectiveUuid, tokenConnected);
  report.findings = findings;

  const synced =
    effectiveUuid !== null &&
    effectiveUuid.length > 0 &&
    (response.stored || response.reason === 'duplicate' || response.reason === 'build-reported');
  const outcome: Omit<Progress, 'installed'> = {
    connected,
    synced,
    // Only the dashboard can see the live site; a production scan is reported, not confirmed.
    deployed: false,
  };
  options.onReported?.(outcome);

  // Setup uploads its own map; this is the workspace's routine scan, which holds the key.
  if (options.report === undefined && (response.stored || response.reason === 'duplicate')) {
    await syncWorkspace(config);
  }

  if (options.report === undefined) {
    try {
      await printScanReport(config, effectiveUuid, outcome, report, options.showRemainingSetup !== false);
    } catch {
      // Best-effort: never turn a successful scan into a failure over the report.
    }
  }

  return 0;
}

/**
 * Whether the site has an owner, and keep `.patchstackrc.json`'s note of it current.
 *
 * A claim token that connected the site answers outright. Otherwise a site the file already records as
 * claimed is taken at its word, so a build does not ask again on every run; any other site is looked up.
 * Best-effort: a failed lookup or write leaves the site reported as not connected, never fails the scan.
 */
async function resolveConnected(
  config: Config,
  siteUuid: string | null,
  tokenConnected: boolean,
): Promise<{ connected: boolean; findings: PackageSummary | null }> {
  if (siteUuid === null || siteUuid.length === 0) return { connected: false, findings: null };
  if (!tokenConnected && config.claimed === true) return { connected: true, findings: null };

  const preview = tokenConnected
    ? { state: 'claimed' as const, summary: null }
    : await fetchClaimPreview({ ...config, siteUuid });
  if (preview.state !== 'unknown') await recordClaimState(config, siteUuid, preview.state === 'claimed');
  return { connected: preview.state === 'claimed', findings: preview.summary };
}

/** Write what Patchstack said about ownership to `.patchstackrc.json`. Never throws. */
async function recordClaimState(config: Config, siteUuid: string, claimed: boolean): Promise<void> {
  const claimUrl = config.endpointTrusted !== false ? buildClaimUrl(config.endpoint, siteUuid) : null;
  try {
    await persistClaimState(process.cwd(), claimed, claimUrl);
  } catch {
    // The note is a convenience for `guide`; the answer itself was already given.
  }
}

/** An item the run reported replaces the working-tree item with the same key, which says less. */
function mergeMissing(...lists: StatusReport['missing'][]): StatusReport['missing'] {
  const merged: StatusReport['missing'] = [];
  for (const item of lists.flat()) {
    const key = item.key ?? item.text;
    if (!merged.some((existing) => (existing.key ?? existing.text) === key)) merged.push(item);
  }
  return merged;
}

/** Where the next step points, from the working tree plus what this run learned. */
function scanNextStepContext(config: Config, state: GuideState, siteUuid: string | null): NextStepContext {
  const uuid = siteUuid !== null && siteUuid.length > 0 ? siteUuid : state.siteUuid;
  return {
    ...guideNextStepContext(state),
    environment: config.environment,
    environmentSource: config.environmentSource,
    siteUuid: uuid,
    claimUrl: uuid !== null && config.endpointTrusted !== false ? buildClaimUrl(config.endpoint, uuid) : null,
  };
}

/**
 * The report a direct `scan` ends on. Inside an install or build it is two lines — what was done and what
 * to do next — because those logs are long and read by nobody looking for a checklist.
 */
async function printScanReport(
  config: Config,
  siteUuid: string | null,
  outcome: Omit<Progress, 'installed'>,
  report: StatusReport,
  withProgress: boolean,
): Promise<void> {
  const state = await collectGuideState(process.cwd());
  const context = scanNextStepContext(config, state, siteUuid);
  const progress = guideProgress(state, outcome);

  if ((isInstallOrBuildHook() || runningInCi()) && !verbose) {
    for (const item of report.missing) console.warn(`Patchstack: ${[item.text + '.', ...(item.hint ?? [])].join(' ')}`);
    for (const line of renderHookSummary(report, progress, context)) console.log(line);
    return;
  }

  if (verbose) console.log('');
  const missing = mergeMissing(report.missing, withProgress ? guideMissing(state, outcome) : []);
  for (const line of renderStatus('Patchstack scan', { ...report, missing }, progress, context, {
    useColor: useColor(),
    verbose,
    concise: true,
    menu: followUpMenu(state),
    columns: terminalColumns(),
    withoutProgress: !withProgress,
  })) {
    console.log(line);
  }
}

/**
 * Run the source-widget pass for `scan` and record the outcome. Never throws:
 * widget management is a convenience layered on top of a successful scan and
 * must not turn one into a failure.
 */
function reportSourceWidget(siteUuid: string, framework: string | null, report: StatusReport): void {
  const handAdd = (why: string): void => {
    report.missing.push({
      text: 'The Patchstack widget is not on your page yet',
      hint: [why, `  ${buildWidgetTag(siteUuid)}`],
    });
  };
  try {
    // In a monorepo the shell is in the workspace app (apps/web), not the root `scan` runs in. Resolve the
    // app directory so the widget lands where the page is actually rendered, and report its files by the
    // path the user sees from the root.
    const appDir = resolveWidgetShellDir(process.cwd(), framework);
    const atRepo = (shell: string | null): string | null =>
      shell === null ? null : path.join(path.relative(process.cwd(), appDir), shell).replace(/\\/g, '/');

    // A server-rendered project has no HTML shell to edit, so the framework's JSX root or Astro layout
    // stands in for one. Only where a literal tag is known to belong — the same set the marker will write into.
    const hint = hasEditableShell(framework) ? resolveWidgetFileHint(appDir, framework) : null;
    const jsxShell = hint !== null && !hint.toLowerCase().endsWith('.html') ? hint : null;

    const result = ensureSourceWidget(appDir, siteUuid, jsxShell);
    const shellPath = atRepo(result.shell);
    switch (result.action) {
      case 'added':
        report.done.push(`Added the Patchstack widget to ${shellPath}`);
        if (shellPath !== null) recordChange(report, shellPath, 'the Patchstack widget');
        break;
      case 'updated':
        report.done.push(`Updated the Patchstack widget in ${shellPath}`);
        if (shellPath !== null) recordChange(report, shellPath, 'the Patchstack widget, updated to this site');
        break;
      case 'unchanged':
        report.done.push(`The Patchstack widget is already in ${shellPath}`);
        break;
      case 'manual':
        report.done.push(`Left your own Patchstack widget in ${shellPath} as it is`);
        break;
      case 'no-body':
        handAdd(`${shellPath} has no </body>. Add this to your main page layout, just before </body>:`);
        break;
      case 'no-shell':
        handAdd('Add this to your main page layout, just before </body>:');
        break;
    }
  } catch (err) {
    handAdd('Add this to your main page layout, just before </body>:');
    detail(`Widget: skipped (${(err as Error).message}).`);
  }
}

/**
 * What to say when `.patchstackrc.json` named a non-production environment and the build platform's own
 * answer was used instead, or null when there is nothing to say.
 */
function ignoredFileEnvironmentWarning(config: Config): string | null {
  const ignored = config.ignoredFileEnvironment;
  if (ignored == null) return null;
  const because = (config.environmentEvidence ?? []).length > 0 ? ` (${config.environmentEvidence!.join('; ')})` : '';
  return (
    `.patchstackrc.json sets "environment": "${ignored}", but this build is production${because}, so it is treated as production. ` +
    `Remove "environment" from .patchstackrc.json and set PATCHSTACK_ENVIRONMENT=${ignored} only in the process that needs it.`
  );
}

/**
 * Run the production-marker pass for `scan` and record the outcome. Never
 * throws, for the same reason the widget pass doesn't: this is a convenience on
 * top of a successful scan and must not turn one into a failure.
 *
 * `scan` is a pre-build hook, so an edit here is compiled into the build that
 * follows. On a server-rendered root that is the only way the marker reaches
 * production — `mark-build` runs after the build and has no HTML to stamp.
 */
function reportSourceMarker(framework: string | null, checksum: string | null, report: StatusReport): void {
  try {
    // The marker goes in the same shell as the widget — in a monorepo that is the workspace app, not the
    // root `scan` runs in. Resolve the app directory, then report its files by the path from the root.
    const appDir = resolveWidgetShellDir(process.cwd(), framework);
    const shell = resolveWidgetFileHint(appDir, framework);
    if (shell === null || shell.toLowerCase().endsWith('.html')) {
      // An HTML shell needs nothing here: mark-build stamps the built copy.
      return;
    }
    const shellPath = path.join(path.relative(process.cwd(), appDir), shell).replace(/\\/g, '/');

    const result = ensureSourceMarker(appDir, shell, framework, checksum);
    switch (result.action) {
      case 'added':
        report.done.push(`Set up ${shellPath} to tell Patchstack when it runs as your live app`);
        recordChange(report, shellPath, 'a line that tells Patchstack when it runs as your live app');
        detail(`Production marker: added to ${shellPath} (only set when ${productionGate(framework)}).`);
        break;
      case 'manual':
        detail(`Production marker: already in ${shellPath}.`);
        break;
      case 'no-anchor':
      case 'unsupported':
        // Without it the widget cannot tell the live app from a preview, and shows the setup panel to visitors.
        report.missing.push({
          text: 'Your live app does not tell Patchstack it is live yet',
          hint: hasEditableShell(framework)
            ? [`Add this inside <head> in ${shellPath}:`, ...buildSourceMarkerSnippet(framework).split('\n').map((line) => `  ${line}`)]
            : [
                `Add this inside <head> in ${shellPath}, only when ${productionGate(framework)}:`,
                '  <script>window.__PATCHSTACK_PROD__=true;</script>',
              ],
        });
        break;
    }
  } catch (err) {
    detail(`Production marker: skipped (${(err as Error).message}).`);
  }
}

async function runProtectCommand(args: ParsedArgs): Promise<number> {
  const runtime = args.flags.get('runtime') === true;
  const runtimeUrl = getStringFlag(args.flags, 'runtime-url');
  if (runtimeUrl && (runtime || args.flags.get('check') !== true)) {
    console.error('Use --runtime-url with protect --check, without --runtime. It checks an already-running app.');
    return 1;
  }
  // A stray `--runtime` would otherwise scaffold quietly while the caller believed their app had been
  // started and probed — a false green about the one check that exists to prevent false greens.
  if (runtime && args.flags.get('check') !== true) {
    console.error('patchstack protect: --runtime only applies to --check. Run `protect --check --runtime`.');
    return 1;
  }

  // `--check`: verify the guard is wired (for the agent/CI loop). Non-zero exit if not.
  if (args.flags.get('check') === true) {
    const report = runVerify(process.cwd());
    console.log(`patchstack protect --check (${report.stack}):`);
    const line = (c: (typeof report.checks)[number]) => {
      // Three states, not two. A check this machine cannot answer is marked `?` and always prints its
      // note: shown as a tick it would claim something nobody established, and as a cross it would fail a
      // correctly configured deployment.
      const mark = c.unverifiable ? '?' : c.ok ? '✓' : c.optional ? '!' : '✗';
      const note = c.unverifiable || !c.ok ? c.hint : undefined;
      console.log(`  ${mark} ${c.label}${note ? ` — ${note}` : ''}`);
    };

    for (const c of report.checks.filter((c) => c.group !== 'reporting')) line(c);
    console.log(
      !report.applicable
        ? 'no guard to wire — this project has no request path'
        : report.wired
          ? 'guard is wired ✓'
          : 'guard is NOT fully wired ✗',
    );

    // Printed apart, and after the verdict, because they answer a different question and none of them
    // decides it. A failing line here does not mean the app is unprotected.
    const reporting = report.checks.filter((c) => c.group === 'reporting');
    if (reporting.length > 0) {
      console.log('reporting to Patchstack (does not affect the verdict above):');
      for (const c of reporting) line(c);
    }
    if (report.checks.some((c) => c.unverifiable)) {
      console.log('One or more checks could not be answered from here — see the `?` lines above.');
    }
    // A project that cannot have a guard is not a failing one: exiting non-zero forever would make this
    // command a permanent red light on a correctly configured project. There is nothing to start, either.
    if (!report.applicable) return 0;
    // The structural verdict comes first either way: an app whose guard is not wired has nothing to
    // gain from being started, and its runtime result would only be a second way of saying the same no.
    if (!report.wired) return 1;
    if (runtimeUrl) {
      const activation = await checkActivation(runtimeUrl, await resolveCliConfig(args), process.cwd());
      console.log(activation.message);
      return activation.ok ? 0 : 1;
    }
    if (!runtime) return 0;

    console.log('');
    const runtimeReport = await runRuntimeCheck(process.cwd());
    for (const line of formatRuntimeCheck(runtimeReport)) console.log(line);

    return runtimeExitCode(runtimeReport);
  }
  // Best-effort: like mark-build, this runs during builds and must never fail one.
  const demo = args.flags.get('demo') === true;
  try {
    runProtect(process.cwd(), { demo });
  } catch (err) {
    console.warn(`patchstack protect: skipped (${(err as Error).message}).`);
  }
  return 0;
}

async function runDemoCommand(args: ParsedArgs): Promise<number> {
  try {
    const scenario = resolveDemoScenario(args.positional[0]);
    const cwd = process.cwd();
    const config = await resolveCliConfig(args, { requireSiteUuid: true });
    if (config.environment !== 'production') {
      throw new DemoError(
        'The production-backed demo requires PATCHSTACK_ENVIRONMENT=production. Unset the sandbox override and try again.',
      );
    }

    await assertPersistedSiteUuid(cwd, config.siteUuid!);
    await assertDemoDependency(cwd, scenario);
    console.log(`Patchstack production demo — ${scenario.packageName}@${scenario.packageVersion}`);
    console.log(`  Site: ${config.siteUuid}`);
    console.log('');
    console.log('1. Report the current npm manifest');
    const scanCode = await runScan(args, { showRemainingSetup: false });
    if (scanCode !== 0) return scanCode;

    console.log('');
    console.log(`2. Wait for live virtual-patch rule ${scenario.ruleId}`);
    const rule = await waitForDemoRule(config.endpoint, config.siteUuid!, scenario, {
      requestTimeoutMs: config.timeoutMs,
    });
    console.log(`Rule ready: ${rule.id}${rule.title ? ` — ${rule.title}` : ''}`);

    console.log('');
    console.log('3. Install and verify the runtime guard');
    const result = runProtect(cwd);
    if (result.status === 'unsupported') {
      throw new DemoError(
        `Runtime protection is not supported for this stack. Supported: ${result.supported.join(', ')}.`,
      );
    }
    // The demo exists to show a request being screened, so a project with no request path cannot host
    // one. Saying so is the useful answer; scaffolding a guard nothing would ever call is not.
    if (result.status === 'not-applicable') {
      throw new DemoError(`${result.reason} Run the demo from a project that serves requests.`);
    }
    console.log(`Guard installer: ${result.adapter} (${result.status})`);
    const report = runVerify(cwd);
    for (const check of report.checks) {
      console.log(`  ${check.ok ? '✓' : '✗'} ${check.label}${!check.ok && check.hint ? ` — ${check.hint}` : ''}`);
    }
    if (!report.wired) {
      throw new DemoError(
        `The ${report.stack} guard is not fully wired. Complete the failed check above, then run this command again.`,
      );
    }

    console.log('');
    console.log('Production virtual patch is ready.');
    console.log('');
    console.log(
      renderDemoTestCommands(
        getStringFlag(args.flags, 'url') ?? 'http://localhost:3000/api/tasks',
        scenario,
      ),
    );
    return 0;
  } catch (error) {
    if (error instanceof DemoError) {
      console.error(`Demo error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

async function runDemoGuideCommand(args: ParsedArgs): Promise<number> {
  try {
    const scenario = resolveDemoScenario(args.positional[0]);
    const cwd = process.cwd();
    const config = await resolveConfig({ cwd });
    const [siteUuid, dependency] = await Promise.all([
      readPersistedSiteUuid(cwd),
      inspectDemoDependency(cwd, scenario),
    ]);
    console.log(
      renderDemoGuide({
        scenario,
        packageManager: detectPackageManager(cwd),
        siteUuid,
        dependency,
        environment: config.environment,
        url: getStringFlag(args.flags, 'url') ?? 'http://localhost:3000/api/tasks',
      }),
    );
    return 0;
  } catch (error) {
    if (error instanceof DemoError) {
      console.error(`Demo guide error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

async function runGuide(args: ParsedArgs): Promise<number> {
  // The live checklist first: what this project already has and what's missing,
  // with commands tailored to it. Best-effort — a project we can't inspect
  // still gets the reference doc.
  try {
    const state = await collectGuideState(process.cwd());
    console.log(renderGuideChecklist(state, useColor(), {}, { verbose }));
  } catch {
    // fall through to the static guide
  }

  // The reference is long and ships in the package; the checklist is what a run needs. `--full` prints it.
  if (args.flags.get('full') !== true) {
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

/**
 * What setup did about runtime protection, as Done or Missing lines. The working tree covers "not wired".
 * Returns true when no server was found, so the caller leaves out what only a server could use.
 */
function reportProtection(protection: ReturnType<typeof setupProtection>, report: StatusReport): boolean {
  for (const line of protection.log) detail(`patchstack protect: ${line}`);

  if (protection.install.status === 'not-applicable') {
    report.done.push('Runtime protection is not needed: this project has no server');
    if (protection.install.leftovers.length > 0) {
      report.missing.push({
        text: 'Files from an earlier Patchstack protection setup are not used here',
        hint: [`You can delete: ${protection.install.leftovers.join(', ')}`],
      });
    }
    return false;
  }
  const scaffoldedWithoutServer =
    protection.install.status === 'scaffolded' && protection.install.plan.includes('Could not locate a server entry');
  if (protection.install.status === 'wired' || protection.install.status === 'scaffolded') {
    const what = scaffoldedWithoutServer ? 'protection files, for when your app has a server' : 'Patchstack protection';
    for (const file of protection.install.changed) recordChange(report, file, what);
  }
  if (protection.verification.wired) {
    const changed = protection.install.status === 'wired' && protection.install.changed.length > 0;
    report.done.push(
      changed
        ? `Added runtime protection (${protection.verification.stack})`
        : `Runtime protection is already set up (${protection.verification.stack})`,
    );
    // Coverage the guard works without (a Supabase browser tunnel, Next.js route-level response filtering),
    // said as a fact about the app rather than a step left undone.
    for (const check of protection.verification.checks.filter((c) => c.optional && !c.ok)) {
      report.missing.push({
        key: `optional-${check.label}`,
        text: `Not covered: ${check.label}`,
        hint: check.hint ? [check.hint] : [],
        note: true,
        plain: { text: `Requests to your app are protected. Not covered yet: ${check.label}.`, hint: [] },
      });
    }
    return false;
  }
  // The generic installer cannot see where requests enter, so it says why rather than which file to edit.
  if (scaffoldedWithoutServer) {
    report.missing.push({
      key: 'runtime-protection',
      text: 'Runtime protection: no server file found',
      hint: ['Add Patchstack where requests enter your app. Run npx @patchstack/connect protect for the steps.'],
      // No server, so nothing to block requests in: a fact about the app, not a step left undone.
      note: true,
      plain: {
        text: 'No server was found in this project, so Patchstack checks its packages. Blocking attacks needs a server.',
        hint: ['Has your app got a server? Run: npx @patchstack/connect protect'],
      },
    });
    return true;
  }
  return false;
}

/** The entries in the project's .gitignore; none when there is no such file. */
function readIgnoreLines(cwd: string): Set<string> {
  try {
    return new Set(
      readFileSync(path.join(cwd, '.gitignore'), 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#')),
    );
  } catch {
    return new Set();
  }
}

/** What setup did to package.json's scripts, as one Done line. */
function buildStepsLine(wired: ReturnType<typeof wireBuildScripts>): string {
  if (wired.strategy === 'postinstall-only') {
    return wired.changed
      ? 'Added a package check after each install to package.json'
      : 'The package check after each install is already in package.json';
  }
  return wired.changed ? 'Added the build steps to package.json' : 'The build steps are already in package.json';
}

async function runSetup(args: ParsedArgs): Promise<number> {
  if (args.flags.get('dry-run') === true) {
    console.error('Setup cannot run as a preview. To see what would be sent, run: npx @patchstack/connect scan --dry-run');
    return 1;
  }

  if (process.stdout.isTTY === true && !isInstallOrBuildHook() && !runningInCi()) {
    for (const line of renderLogo({ useColor: useColor() })) console.log(line);
  }

  const cwd = process.cwd();
  // One command does it all: a plain HTML folder gets the small Node project Connect needs, and a project
  // without Connect gets it installed, so the person approves setup once instead of a chain of commands.
  const ignoredBefore = readIgnoreLines(cwd);
  const createdProject = isPlainHtmlSite(cwd);
  if (createdProject) {
    createSiteProject(cwd);
    console.log('Added package.json with a build step that copies your site into dist/. Your pages stay where they are.');
  }
  let before = await collectGuideState(cwd);
  if (!before.hasPackageJson) {
    console.error('No package.json or HTML page here. Run setup from your project folder.');
    return 1;
  }
  const addedSelf = before.installed === null;
  if (addedSelf) {
    console.log('Adding Patchstack to this project…');
    const installed = installSelf(cwd, before.packageManager, packageVersion(), { quiet: process.stdout.isTTY !== true });
    before = await collectGuideState(cwd);
    if (!installed.ok || before.installed === null) {
      console.error(`Could not add Patchstack to this project. Run this, then run setup again:\n  ${installCommand(before.packageManager)}`);
      return 1;
    }
  }

  // The slim install: a new project gets protection first and is offered the widget at the end. A project
  // that already has a site, or has said what it wants, keeps what it has.
  if (args.flags.get('widget') === true) {
    await persistWidgetChoice(process.cwd(), true);
  } else if (before.siteUuid === null && !(await hasWidgetChoice(process.cwd()))) {
    await persistWidgetChoice(process.cwd(), false);
  }

  const report = emptyReport();
  if (createdProject) recordChange(report, 'package.json', 'created, with a build step that copies your site into dist/');
  if (addedSelf) recordChange(report, 'package.json', 'added @patchstack/connect');
  let reported: Partial<Progress> = {};
  const scanCode = await runScan(args, {
    report,
    onReported: (outcome) => {
      reported = outcome;
    },
  });
  if (scanCode !== 0) {
    return scanCode;
  }

  const noServer = reportProtection(setupProtection(process.cwd()), report);

  const wired = wireBuildScripts(process.cwd(), before.packageManager);
  report.done.push(buildStepsLine(wired));
  if (wired.changed) {
    recordChange(report, 'package.json', wired.strategy === 'postinstall-only' ? INSTALL_SCRIPT_CHANGE : BUILD_SCRIPTS_CHANGE);
  }
  detail(`Build hooks: ${wired.detail}`);

  // A hosted builder publishes without the key, so its publish cannot upload the map. The workspace has
  // the key: syncing there uploads each map the publish will carry, under the same identity.
  const builder = detectHostedBuilder(process.cwd());
  if (args.flags.get('dev-sync') === true || builder !== null) {
    const development = wireDevelopmentScript(process.cwd());
    if (development.wired) {
      report.done.push('Development map synchronization wired (starts with your dev command)');
      if (development.changed) recordChange(report, 'package.json', 'the dev script also keeps Patchstack\'s map of the app up to date');
    } else if (builder === null) {
      report.missing.push({ key: 'development-sync', text: 'Development command needs manual sync integration', hint: ['The existing dev script was preserved. Run: patchstack-connect dev -- <server-command> [arguments]'] });
    } else {
      detail(`Development map synchronization not wired: the ${builder} dev script was not one setup recognises, so it was left unchanged.`);
    }
  }

  const config = await resolveCliConfig(args);
  const synced = await syncSetupProtection(process.cwd(), config);
  for (const line of synced.notices) detail(line);
  for (const [index, warning] of synced.warnings.entries()) {
    report.missing.push({ key: `setup-sync-${index}`, text: warning });
  }
  const uploaded = synced.map.upload;
  if (uploaded?.result === 'stored' || uploaded?.result === 'unchanged') {
    report.done.push(`Attack-surface map uploaded (revision ${uploaded.revision}; ${synced.map.endpoints ?? 0} detected entry points)`);
    if (!synced.map.buildId && !noServer) report.missing.push({ key: 'map-binding', text: 'Map is not linked to runtime protection', hint: ['Finish the reported protection integration, then rerun setup. Rules for specific inputs can only detect, not block, until linked.'], plain: { text: 'Some attacks are only reported, not blocked yet', hint: ['Finish adding protection, then run setup again.'] } });
  } else {
    report.missing.push({ key: 'map-upload', text: 'Attack-surface map was not uploaded', hint: [synced.map.error ?? uploaded?.message ?? 'Check connectivity and rerun setup.'], plain: { text: 'Could not send your app\'s layout to Patchstack', hint: ['Check your connection and run setup again.'] } });
  }
  if (synced.rules.ok) {
    // Rules are enforced by protection in a server; an app without one has nothing to apply them.
    if (!noServer) report.rules = synced.rules.count;
    report.done.push(`Live rule lookup succeeded (${synced.rules.count} delivered rules; not proof of runtime enforcement)`);
    if (!noServer) {
      if (synced.rules.mapRules === 'ready') {
        report.done.push(`Rules for this map are ready${synced.rules.count === 0 ? ' (no applicable rules)' : ''}`);
        report.confirmed = [`Rules for this app are ready${synced.rules.count === 0 ? ' (none currently apply)' : ''}. This does not confirm active blocking.`];
      } else {
        report.missing.push({ key: 'map-rules', text: synced.rules.mapRules === 'pending' ? 'Rules for this map are still being prepared' : 'Rules readiness for this map is not confirmed', hint: ['The running guard will refresh automatically. Broad and hardening rules do not depend on map generation.'], plain: { text: synced.rules.mapRules === 'pending' ? 'Rules for this app are still being prepared' : 'Could not confirm whether rules for this app are ready', hint: ['Your running app will check again automatically.'] } });
      }
    }
  } else {
    report.missing.push({ key: 'rules-pull', text: 'Live rule lookup is incomplete', hint: [synced.rules.error ?? 'Check authentication and rerun setup.'], plain: { text: 'Could not fetch protection rules', hint: ['Run setup again.'] } });
  }
  const runtimeUrl = getStringFlag(args.flags, 'runtime-url');
  if (runtimeUrl) {
    const activation = await checkActivation(runtimeUrl, config, process.cwd(), synced.map.buildId ?? null);
    if (activation.ok) {
      report.done.push(activation.message);
      (report.confirmed ??= []).push(activation.summary ?? activation.message);
    }
    else report.missing.push({key:'runtime-activation', text:activation.message});
  } else if (!noServer) {
    report.missing.push({ key: 'runtime-activation', text: 'Runtime protection has not been checked in the running app', hint: ['Your app may reload these changes automatically. Check it: npx @patchstack/connect protect --check --runtime-url <URL>. Restart/rebuild/deploy only if the new protection has not loaded. Setup does not start or deploy it.'], plain: { text: 'Check protection in your running app with npx @patchstack/connect protect --check --runtime-url <URL>', hint: ['Your app may reload these changes automatically. Restart or rebuild only if the check says they have not loaded.'] } });
  }
  const after = await collectGuideState(process.cwd());
  // The generic installer can count a project as one protection applies to while finding no server in it.
  const missing = mergeMissing(report.missing, guideMissing(after, reported)).filter((item) => !(noServer && item.key === DEV_ONLY_INSTALL));
  const ignoredNow = [...readIgnoreLines(cwd)].filter((line) => !ignoredBefore.has(line));
  if (ignoredNow.length > 0) recordChange(report, '.gitignore', `now ignores ${ignoredNow.join(', ')}`);
  const context = scanNextStepContext(config, after, after.siteUuid);

  if (verbose) console.log('');
  for (const line of renderStatus('Patchstack setup', { ...report, missing }, guideProgress(after, reported), context, {
    useColor: useColor(),
    verbose,
    concise: true,
    menu: followUpMenu(after),
    columns: terminalColumns(),
  })) {
    console.log(line);
  }
  // An assistant reads this output and writes the person one message; a ready-made summary is what it
  // passes on. A terminal already shows the report above, and a build log is not read by a person.
  if (!isInstallOrBuildHook() && !runningInCi()) {
    const summary = renderSummary({ ...report, missing }, guideProgress(after, reported), context, { widgetOnPage: after.widgetInstalled });
    // Kept, so `summary` can print it again: long setup output can be cut short before it reaches an assistant.
    try {
      ensureProjectDirectorySync(cwd, path.join(cwd, path.dirname(SUMMARY_FILE)));
      writeProjectFileSync(cwd, path.join(cwd, SUMMARY_FILE), `${summary.join('\n')}\n`, { encoding: 'utf8' });
    } catch {
      // The summary is printed below either way; only `summary` loses its copy.
    }
    if (!process.stdout.isTTY) {
      console.log('');
      console.log(SUMMARY_INTRO);
      console.log(SUMMARY_HEADING);
      for (const line of summary) console.log(line);
    }
  }
  return 0;
}

/**
 * After a successful package report in a copy of the project that holds the key and keeps its guard's
 * rules file current: upload the map and put the site's current rules into that file.
 *
 * The builder's publish has no key, so it can neither upload the map it is built from nor fetch rules. The
 * workspace holds the key and scans the same source, so it does both here, the way setup does, and the next
 * publish ships the rules and presents a map identity Patchstack already holds. A build that has the key
 * does its own pre-bundle `map --upload`.
 */
async function syncWorkspace(config: Config): Promise<void> {
  if (isPreBundleBuildHook() || !hasSiteCredential(config) || !bundleRulesAllowed(process.cwd())) return;
  try {
    const synced = await syncSetupProtection(process.cwd(), config, { waitMs: 0 });
    for (const line of synced.notices) detail(line);
  } catch {
    // The package report already succeeded; the next scan tries again.
  }
}

/** Where setup keeps the summary it wrote, for `summary` to print again. */
const SUMMARY_FILE = path.join('.patchstack', 'summary.md');

/** The summary the last setup wrote, with the same lines before it, so an assistant passes it on as it is. */
function runSummary(): number {
  let summary: string;
  try {
    summary = readFileSync(path.join(process.cwd(), SUMMARY_FILE), 'utf8').trimEnd();
  } catch {
    console.error('No summary yet. Run: npx @patchstack/connect setup');
    return 1;
  }
  console.log(SUMMARY_INTRO);
  console.log(SUMMARY_HEADING);
  console.log(summary);
  return 0;
}

/**
 * The one thing to do now, for the word the summary ends on. Connection lives on the server, so it is
 * looked up unless `.patchstackrc.json` already records it; everything else is read from the project.
 */
async function runNext(args: ParsedArgs): Promise<number> {
  const config = await resolveCliConfig(args);
  if (config.siteUuid === null) {
    console.error('This project is not on Patchstack yet. Run: npx @patchstack/connect setup');
    return 1;
  }
  const cwd = process.cwd();
  const state = await collectGuideState(cwd);
  let connected = config.claimed === true;
  if (!connected) {
    const preview = await fetchClaimPreview(config);
    if (preview.state === 'unknown') {
      console.error('Could not reach Patchstack. Check your connection and try again.');
      return 1;
    }
    connected = preview.state === 'claimed';
    await recordClaimState(config, config.siteUuid, connected);
  }
  const link = config.endpointTrusted !== false ? buildClaimUrl(config.endpoint, config.siteUuid) : null;
  const context = { ...guideNextStepContext(state), noServer: !state.protectionApplicable };
  const host = detectHost(cwd);
  const lines = renderNext(guideProgress(state, { connected }), context, {
    link,
    goLive: host !== null ? renderGoLive(host, { useColor: false }) : null,
    hosts: Object.values(HOST_NAMES).filter((name) => name !== HOST_NAMES['cloudflare-workers']),
  });
  if (!process.stdout.isTTY) console.log(NEXT_INTRO);
  for (const line of lines) console.log(line);
  return 0;
}

/**
 * What Patchstack found in this project. The public claim page publishes counts only, so an unconnected
 * project gets the counts and the link that shows the packages; a connected one gets its dashboard link.
 */
async function runVulns(args: ParsedArgs): Promise<number> {
  const config = await resolveCliConfig(args);
  if (config.siteUuid === null) {
    console.error('This project is not on Patchstack yet. Run: npx @patchstack/connect setup');
    return 1;
  }
  const color = useColor();
  const paint = painter(color);
  const columns = process.stdout.isTTY ? process.stdout.columns : undefined;
  const link = config.endpointTrusted !== false ? buildClaimUrl(config.endpoint, config.siteUuid) : null;
  const preview = await fetchClaimPreview(config);

  if (preview.state === 'unknown') {
    console.error('Could not reach Patchstack. Check your connection and try again.');
    return 1;
  }

  const lines: string[] = [paint('bold', 'Patchstack vulnerabilities'), ''];
  let title: string;
  if (preview.state === 'unclaimed') {
    const findings = renderFindings(preview.summary, { useColor: color });
    lines.push(...(findings.length > 0 ? findings : ['   Patchstack is still checking this project. Try again in a minute.']), '');
    title = (preview.summary?.vulnerable ?? 0) > 0 ? '➜ See which packages they are and how to fix them' : '➜ Connect this project to your Patchstack account';
  } else {
    lines.push('   This project is connected. The full list is in your Patchstack dashboard.', '');
    title = '➜ Open your Patchstack dashboard';
  }
  if (link !== null) {
    lines.push(...renderBox([{ text: title, style: 'bold' }, { text: `  ${link}`, style: 'cyan' }], { useColor: color, columns }));
  }
  if (preview.state === 'unclaimed') {
    lines.push(`  ${paint('dim', 'Package names and fixes are shown once the project is connected to your account.')}`);
  }
  for (const line of lines) console.log(line);
  return 0;
}

/**
 * Add the Patchstack widget to the project's page, or take it out with --remove. Either way the choice is
 * saved in .patchstackrc.json, which the build hooks read, so a later build does not undo it.
 */
async function runWidget(args: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  const remove = args.flags.get('remove') === true;
  const paint = painter(useColor());
  const state = await collectGuideState(cwd);
  const hint = state.widgetFileHint;
  const jsxShell = hint !== null && !hint.toLowerCase().endsWith('.html') && hasEditableShell(state.framework) ? hint : null;
  const done = (text: string): void => console.log(` ${paint('green', '✔')} ${text}`);

  if (remove) {
    await persistWidgetChoice(cwd, false);
    const result = removeSourceWidget(cwd, jsxShell);
    switch (result.action) {
      case 'removed':
        done(`Removed the Patchstack widget from ${result.shell}`);
        break;
      case 'manual':
        console.log(` ${paint('yellow', '✘')} The widget tag in ${result.shell} was added by hand, so it was left as it is. Remove it yourself.`);
        break;
      case 'absent':
      case 'no-shell':
        done('There is no Patchstack widget on your page');
        break;
    }
    done('Saved in .patchstackrc.json: builds will not add it again');
    console.log(`   ${paint('dim', 'To add it back: npx @patchstack/connect widget')}`);
    return 0;
  }

  if (state.siteUuid === null) {
    console.error('This project is not on Patchstack yet. Run: npx @patchstack/connect setup');
    return 1;
  }
  await persistWidgetChoice(cwd, true);
  const result = ensureSourceWidget(cwd, state.siteUuid, jsxShell);
  switch (result.action) {
    case 'added':
      done(`Added the Patchstack widget to ${result.shell}`);
      break;
    case 'updated':
      done(`Updated the Patchstack widget in ${result.shell}`);
      break;
    case 'unchanged':
      done(`The Patchstack widget is already in ${result.shell}`);
      break;
    case 'manual':
      done(`Your own Patchstack widget in ${result.shell} was left as it is`);
      break;
    case 'no-body':
    case 'no-shell':
      console.log(` ${paint('yellow', '✘')} Add this to your main page layout, just before </body>:`);
      console.log(`   ${buildWidgetTag(state.siteUuid)}`);
      break;
  }
  console.log(`   ${paint('dim', 'Refresh your preview to see it. Your live site gets it with your next deploy.')}`);
  return 0;
}

/** How to add the key to this project's host and deploy. Reads project files only; sends nothing. */
async function runGoLive(args: ParsedArgs): Promise<number> {
  const named = getStringFlag(args.flags, 'host');
  let host = null;
  if (named !== undefined) {
    host = parseHost(named);
    if (host === null) {
      console.error(`Unknown host "${named}". Known hosts: ${Object.keys(HOST_NAMES).join(', ')}.`);
      return 1;
    }
  } else {
    host = detectHost(process.cwd());
  }
  if (host !== 'lovable' && !existsSync(path.join(process.cwd(), SECRET_CONFIG_FILENAME))) {
    console.error(`No ${SECRET_CONFIG_FILENAME} here yet. Run setup first: npx @patchstack/connect setup`);
    return 1;
  }
  for (const line of renderGoLive(host, { useColor: useColor() })) console.log(line);
  return 0;
}

async function runStatus(args: ParsedArgs): Promise<number> {
  const config = await resolveCliConfig(args);
  console.log(`Site UUID:   ${config.siteUuid ?? '(none yet — the next `scan` will provision one)'}`);
  console.log(
    `Endpoint:    ${config.endpoint}${config.endpoint === DEFAULT_ENDPOINT ? '' : ' (override)'}`,
  );
  console.log(`Timeout:     ${config.timeoutMs}ms`);
  console.log(`Environment: ${config.environment}`);
  if (config.siteUuid !== null) {
    console.log(`Dashboard URL: ${buildClaimUrl(config.endpoint, config.siteUuid)}`);

    const claimState = await fetchClaimState(config);
    if (claimState !== 'unknown') await recordClaimState(config, config.siteUuid, claimState === 'claimed');
    if (claimState === 'claimed') {
      console.log('Connected:     yes, to a Patchstack account');
    } else if (claimState === 'unclaimed') {
      console.log('Connected:     not yet. Open the link above or run `npx @patchstack/connect claim`.');
    } else {
      console.log('Connected:     could not be verified. Not connected yet? Open the link above.');
    }

    switch (await fetchSiteStatus(config)) {
      case 'active':
        console.log('Site status:   active on Patchstack');
        break;
      case 'removed':
        console.log('Site status:   removed from Patchstack');
        console.log('  The local files are still here. See "Uninstalling" in AGENT-INSTALL.md to remove them.');
        break;
      case 'unknown':
        console.log('Site status:   could not be verified (Patchstack unreachable)');
        break;
    }
  }
  return 0;
}

async function runUninstall(args: ParsedArgs): Promise<number> {
  const config = await resolveCliConfig(args);

  if (config.siteUuid === null) {
    console.log('No site UUID configured — there is no site record to signal about.');
    console.log('Continue with the local removal steps in AGENT-INSTALL.md ("Uninstalling").');
    return 0;
  }

  console.log(`Signalling Patchstack that @patchstack/connect is being removed (site ${config.siteUuid})…`);
  const outcome = await postPackageRemoved(config);

  switch (outcome.result) {
    case 'deleted':
      console.log('Site record removed from Patchstack (the site was unclaimed).');
      break;
    case 'flagged':
      console.log('This site is claimed by a Patchstack account, so its record was kept and flagged.');
      console.log('Its owner can remove it at https://app.patchstack.com to free the site slot.');
      break;
    case 'gone':
      console.log('The site record no longer exists on Patchstack — nothing to signal.');
      break;
    case 'failed':
      console.warn(`Could not signal Patchstack${outcome.message !== null ? ` (${outcome.message})` : ''}.`);
      console.warn('The site record may remain — it can always be removed from the dashboard at https://app.patchstack.com.');
      break;
  }

  console.log('');
  console.log('Local files are not touched. Remove them with the "Uninstalling" steps in AGENT-INSTALL.md.');
  // Never fail the uninstall flow over the signal: local removal must proceed.
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

/** The project's `build` script, so `mark-build` can honour an output directory it names. Best-effort. */
function readBuildScript(cwd: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts?.build;
  } catch {
    return undefined;
  }
}

/**
 * Tell Patchstack what this build did with the published-build marker.
 *
 * The stamping pass is the only thing that knows whether the live pages will be able to name the
 * build they are running. Without this report a site that never carries a marker — because it is
 * server-rendered, or because the build was not a deployment — reads on the dashboard as an app
 * nothing has been heard from, which is a different problem with a different fix.
 *
 * The manifest travels with it because it is what identifies the build, and it is the same one the
 * scan reported before the bundler ran: the server keeps one copy and reads the two reports as the
 * two halves of one build. A project that wired only this hook still gets its build recorded.
 *
 * Best-effort in every direction. This runs inside somebody's build, so nothing here may fail one,
 * and a report that cannot be delivered costs a line of output. Reports only against a site that is
 * already registered — provisioning one from a postbuild hook would be a surprise.
 */
/** How long the build-stamp report may take before it is given up on. See `reportBuildStamp`. */
const REPORT_TIMEOUT_MS = 10_000;

async function reportBuildStamp(
  config: Config | null,
  payload: WirePayload | null,
  marker: BuildMarker,
): Promise<void> {
  if (config === null || payload === null || config.siteUuid === null || config.siteUuid === '') {
    return;
  }

  try {
    // Bounded well below the manifest timeout. The scan's report is the one the build cannot do
    // without; this one only explains a build afterwards, and a diagnostic has not earned the right
    // to hold somebody's build open while a network decides whether to answer.
    const bounded: Config = {
      ...config,
      timeoutMs: Math.min(config.timeoutMs, REPORT_TIMEOUT_MS),
    };
    await postManifestWithEnvironmentFallback(bounded, payload, marker);
  } catch (err) {
    console.warn(
      `mark-build: could not tell Patchstack about this build (${(err as Error).message}). The pages were still marked.`,
    );
  }
}

async function runMarkBuild(args: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  // Captured before the lockfile scan below, which on a large tree takes long enough to matter when
  // the output's freshness is judged against it.
  const startedAt = Date.now();

  // Compute the build fingerprint and stack descriptor from the lockfile.
  // Best-effort: mark-build is a postbuild step and must never fail the build, so
  // a missing/unreadable lockfile just means we stamp the production flag without
  // a fingerprint or stack.
  let checksum: string | null = null;
  let stack: StackDescriptor | null = null;
  let wirePayload: WirePayload | null = null;
  try {
    const manifest = await scanLockfile(cwd);
    for (const warning of manifest.warnings ?? []) {
      console.warn(`mark-build: ${warning}`);
    }
    const { payload } = buildWirePayload(manifest);
    wirePayload = payload;
    checksum = computeManifestChecksum(payload.packages);
    stack = detectStack(payload.packages);
  } catch (err) {
    console.warn(
      `mark-build: could not compute the build fingerprint (${(err as Error).message}). Stamping the production flag only.`,
    );
  }

  // The widget pass needs the configured UUID, the marker gate below needs the environment, and the
  // report needs both. Best-effort for the same reason: none of it may fail a build.
  let config: Config | null = null;
  let widgetUuid: string | null = null;
  let environment: Environment = 'local';
  let environmentEvidence: string[] = [];
  try {
    config = await resolveConfig({
      cwd,
      cliSiteUuid: getStringFlag(args.flags, 'site-uuid'),
    });
    if (config.widget) {
      widgetUuid = config.siteUuid;
    }
    environment = config.environment;
    environmentEvidence = config.environmentEvidence ?? [];
    const overruled = ignoredFileEnvironmentWarning(config);
    if (overruled !== null) console.warn(`mark-build: ${overruled}`);
  } catch (err) {
    console.warn(
      `mark-build: could not resolve the site UUID (${(err as Error).message}). Skipping the widget pass.`,
    );
    // An unreadable config leaves the environment at its safe default: a build that cannot say it is
    // production does not get to claim it is.
  }

  // `--production` is the deliberate way to stamp a build this command cannot recognise as a
  // deployment — most often a static site published by hand from a laptop (`netlify deploy --dir`,
  // a drag-and-drop upload), where the build really is the one going live and nothing in the
  // environment says so.
  const forcedProduction = args.flags.get('production') === true;
  const published = forcedProduction || marksPublishedBuild(environment);

  // `--production` is the owner stating where this build is going, so the report says so too —
  // otherwise the pages would claim to be the live site while the report called them a working tree.
  const reported: Config | null =
    config !== null && forcedProduction && config.environment !== 'production'
      ? { ...config, environment: 'production', environmentSource: 'override' }
      : config;

  const buildDirOptions = { framework: stack?.framework ?? null, buildScript: readBuildScript(cwd) };
  const dir = resolveBuildDir(cwd, getStringFlag(args.flags, 'dir'), buildDirOptions);
  if (dir === null) {
    // Loud, and specific: this runs as a postbuild hook whose output scrolls past, and a build that
    // finished with nothing stamped is exactly what a published site with no production marker looks
    // like. Naming the directories actually tried is what lets the reader fix it in one edit.
    const tried = buildDirCandidates(buildDirOptions).map((candidate) => `${candidate}/`).join(', ');
    console.warn(
      `mark-build: no build output directory found (looked for ${tried}). Nothing to mark.`,
    );
    console.warn(
      'mark-build: if the build writes elsewhere, set it once in package.json → "postbuild": "patchstack-connect mark-build --dir <path>".',
    );
    await reportBuildStamp(reported, wirePayload, 'no-output');
    return 0;
  }

  const files = findHtmlFiles(dir);
  if (files.length === 0) {
    // A build directory with no HTML in it is the signature of a server-rendered
    // app: the document is produced per request, so there is no file to stamp and
    // the marker only reaches production if it ships in the source shell. Silence
    // here reads as success, and the widget then treats the live site as a build.
    console.warn(`mark-build: found ${dir} but no HTML files in it.`);
    console.warn('mark-build: this looks like a server-rendered app. Run `npx @patchstack/connect guide` to see what your main layout needs.');
    await reportBuildStamp(reported, wirePayload, 'no-pages');
    return 0;
  }

  // A stale directory is the local failure this command cannot otherwise see: run by hand, or after a
  // build that wrote nothing, it would attach this run's dependency fingerprint to pages built from a
  // different tree. Said before the pass, because the numbers below look identical either way.
  const staleBy = staleBuildAge(files, startedAt);
  if (staleBy !== null) {
    console.warn(
      `mark-build: nothing in ${dir} changed in the last ${Math.round(staleBy / 60000)} minute(s). Run it right after the build (as postbuild).`,
    );
  }

  // Any earlier marker is replaced, so a directory carrying yesterday's production marker is
  // corrected rather than left to claim the preview is the live site. A sandbox build says it is one;
  // a local build gets nothing, which the widget reads as the live site unless the host is local.
  const snippet = published
    ? buildInjectionSnippet(checksum, stack)
    : environment === 'sandbox'
      ? buildSandboxSnippet()
      : '';
  let marked = 0;
  let widgetTouched = 0;
  let handRemoved = 0;
  for (const file of files) {
    const before = readFileSync(file, 'utf8');
    let after = injectMarker(before, snippet);
    if (!published) {
      const cleared = removeHandMarkers(after);
      if (cleared !== after) handRemoved += 1;
      after = cleared;
    }
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
      writeProjectFileSync(cwd, file, after, { encoding: 'utf8' });
      marked += 1;
    }
  }

  const stackSummary = stack !== null ? describeStack(stack) : null;

  if (published) {
    console.log(`Patchstack: marked ${plural(files.length, 'page', 'pages')} as your live app.`);
    detail(
      `mark-build: marked ${marked} HTML file(s) in ${dir}` +
        `${checksum !== null ? ` (build ${checksum})` : ''}` +
        `${widgetTouched > 0 ? `, widget tag ensured in ${widgetTouched}` : ''}` +
        `${stackSummary !== null ? ` [${stackSummary}]` : ''}.`,
    );
    await reportBuildStamp(reported, wirePayload, 'stamped');
    return 0;
  }

  // The withheld case has to account for itself. This is a build whose output a person is about to
  // look at, and silence here reads as the marker having been stamped — which is how a local preview
  // came to be reported as a live, connected site in the first place.
  const because = environmentEvidence.length > 0 ? ` (${environmentEvidence.join('; ')})` : '';
  console.log(
    `Patchstack: ${environment} build, so ${plural(files.length, 'page is', 'pages are')} not marked as your live app. Publishing this folder by hand? Run again with --production.`,
  );
  detail(
    `mark-build: ${environment} build${because}, so no production marker in ${files.length} HTML file(s) in ${dir}` +
      `${widgetTouched > 0 ? `, widget tag ensured in ${widgetTouched}` : ''}` +
      `${stackSummary !== null ? ` [${stackSummary}]` : ''}.`,
  );
  if (handRemoved > 0) {
    console.warn(
      `mark-build: removed a hand-added __PATCHSTACK_PROD__ script from ${plural(handRemoved, 'page', 'pages')}. ` +
        'Production builds get the marker from mark-build, so it does not need to be in your source.',
    );
  }
  await reportBuildStamp(reported, wirePayload, 'withheld');
  return 0;
}

/**
 * The installed version of this package.
 *
 * Read from the manifest beside `dist/` rather than baked in at build time, so there is one source and it
 * is the same one npm resolved. A reporter asked which version they are running needs the answer to come
 * from the artifact they installed, not from a constant that a partial build could leave stale.
 *
 * Returns `unknown` rather than throwing: a version string is diagnostic, and no command should fail
 * because it could not read one.
 */
function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require('../package.json') as { version?: unknown };

    return typeof manifest.version === 'string' && manifest.version.length > 0 ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * What went wrong and what to do, for the errors whose own message is about the machinery (an address, a
 * file format) rather than the fix. Null keeps the error's own message, which already names the fix.
 */
function plainErrorMessage(err: PatchstackError): string | null {
  switch (err.code) {
    case 'NETWORK_ERROR':
      return 'Could not reach Patchstack. Check your internet connection and try again.';
    case 'NETWORK_TIMEOUT':
      return 'Patchstack took too long to answer. Try again in a minute.';
    case 'SERVER_ERROR':
      return 'Patchstack could not handle the request right now. Try again in a few minutes.';
    case 'LOCKFILE_NOT_FOUND':
      return 'Could not find the list of installed packages. Install your packages first (for example npm install), then try again.';
    case 'LOCKFILE_PARSE_ERROR':
    case 'LOCKFILE_UNSUPPORTED':
      return 'Could not read the list of installed packages. Reinstall your packages (for example npm install), then try again.';
    case 'CONFIG_MISSING':
      return 'This project is not set up with Patchstack yet. Run npx @patchstack/connect setup first.';
    default:
      return null;
  }
}

async function main(): Promise<number> {
  if (process.argv[2] === 'dev') {
    setRunCommand('dev');
    return runDevelopment(process.argv[3] === '--' ? process.argv.slice(4) : []);
  }
  const args = parseArgs(process.argv);
  verbose = args.flags.get('verbose') === true;

  // Before help, and before any command: `--version` is what a bug report is asked for, so it must work
  // even when the rest of the arguments are wrong.
  if (args.flags.has('version') || args.command === 'version') {
    console.log(packageVersion());
    return 0;
  }

  if (args.flags.has('help') || args.command === 'help') {
    console.log(HELP);
    return 0;
  }

  if (args.flags.has('runtime-url') && (!getStringFlag(args.flags, 'runtime-url')?.trim()
    || (args.command !== 'setup' && args.command !== 'protect'))) {
    console.error('--runtime-url requires an explicit URL and applies only to setup or protect --check.');
    return 1;
  }
  if (args.flags.has('dev-sync') && args.command !== 'setup') {
    console.error('--dev-sync applies only to setup. To run a development server, use dev -- <command>.');
    return 1;
  }

  if (args.command === null) {
    for (const line of startScreen(useColor())) console.log(line);
    return 0;
  }

  setRunCommand(args.command);
  if (!KNOWN_COMMANDS.has(args.command)) return runCommand(args);
  let code = 1;
  try {
    code = await runCommand(args);
    return code;
  } finally {
    await noticeUnloggedRun(args, code);
  }
}

/** Commands `runCommand` dispatches; anything else is an unknown command and sends no notice. */
const KNOWN_COMMANDS = new Set([
  'init', 'scan', 'vulns', 'next', 'summary', 'go-live', 'widget', 'status', 'uninstall', 'mark-build', 'protect',
  'demo', 'demo-guide', 'guide', 'setup', 'map', 'claim', 'login',
]);

/**
 * A run that sent nothing the site's activity log records still tells Patchstack it ran, by the site's
 * UUID alone, so a command an assistant was asked to run can be seen to have run — or not.
 */
async function noticeUnloggedRun(args: ParsedArgs, code: number): Promise<void> {
  if (runWasLogged()) return;
  try {
    await postRunNotice(await resolveCliConfig(args), code);
  } catch {
    // No readable configuration means no site to tell.
  }
}

async function runCommand(args: ParsedArgs): Promise<number> {
  switch (args.command) {
    case 'init':
      return runInit(args);
    case 'scan':
      return runScan(args);
    case 'vulns':
      return runVulns(args);
    case 'summary':
      return runSummary();
    case 'next':
      return runNext(args);
    case 'go-live':
      return runGoLive(args);
    case 'widget':
      return runWidget(args);
    case 'status':
      return runStatus(args);
    case 'uninstall':
      return runUninstall(args);
    case 'mark-build':
      return runMarkBuild(args);
    case 'protect':
      return runProtectCommand(args);
    case 'demo':
      return runDemoCommand(args);
    case 'demo-guide':
      return runDemoGuideCommand(args);
    case 'guide':
      return runGuide(args);
    case 'setup':
      return runSetup(args);
    case 'map':
      return runMap(args.flags);
    case 'claim':
      return runClaim(args);
    case 'login':
      return runLogin(args);
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
      const plain = plainErrorMessage(err);
      console.error(`${plain ?? err.message} (${err.code})`);
      if (plain !== null && verbose) console.error(`Detail: ${err.message}`);
      process.exit(1);
    }
    console.error('Unexpected error:', err);
    process.exit(2);
  });
