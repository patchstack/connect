import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { scanLockfile } from './parsers/index.js';
import { buildRulesUrl } from './client.js';
import type { PackageManager } from './guide.js';

export interface DemoScenario {
  name: string;
  packageName: string;
  packageVersion: string;
  ruleId: number;
  maliciousBody: Record<string, string>;
  benignBody: Record<string, string>;
}

export interface PulseRule {
  id?: string | number;
  title?: string;
  rule_v2?: unknown[];
}

export const NODE_SERIALIZE_DEMO: DemoScenario = {
  name: 'node-serialize',
  packageName: 'node-serialize',
  packageVersion: '0.0.4',
  ruleId: 18843,
  maliciousBody: {
    text: "_$$ND_FUNC$$_function(){require('child_process').exec('id')}()",
  },
  benignBody: { text: 'buy milk' },
};

const SCENARIOS = new Map([[NODE_SERIALIZE_DEMO.name, NODE_SERIALIZE_DEMO]]);

export class DemoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoError';
  }
}

export interface DemoDependencyState {
  ready: boolean;
  versions: string[];
}

export interface DemoGuideState {
  scenario: DemoScenario;
  packageManager: PackageManager;
  siteUuid: string | null;
  dependency: DemoDependencyState;
  environment: 'production' | 'sandbox';
  url: string;
}

const DEMO_INSTALL_COMMANDS: Record<PackageManager, string> = {
  npm: 'npm install --save-exact node-serialize@0.0.4',
  pnpm: 'pnpm add --save-exact node-serialize@0.0.4',
  yarn: 'yarn add --exact node-serialize@0.0.4',
  bun: 'bun add --exact node-serialize@0.0.4',
};

const DEMO_REMOVE_COMMANDS: Record<PackageManager, string> = {
  npm: 'npm uninstall node-serialize',
  pnpm: 'pnpm remove node-serialize',
  yarn: 'yarn remove node-serialize',
  bun: 'bun remove node-serialize',
};

export function resolveDemoScenario(name: string | undefined): DemoScenario {
  if (!name) {
    throw new DemoError(
      'A demo scenario is required. Available scenario: node-serialize.\n' +
        'Usage: patchstack-connect demo node-serialize',
    );
  }
  const scenario = SCENARIOS.get(name);
  if (!scenario) {
    throw new DemoError(`Unknown demo scenario "${name}". Available scenario: node-serialize.`);
  }
  return scenario;
}

async function collectDemoDependency(
  cwd: string,
  scenario: DemoScenario,
): Promise<DemoDependencyState> {
  const manifest = await scanLockfile(cwd);
  const versions = [
    ...new Set(
      manifest.packages
        .filter((entry) => entry.name === scenario.packageName)
        .map((entry) => entry.version),
    ),
  ].sort();
  return { ready: versions.includes(scenario.packageVersion), versions };
}

export async function inspectDemoDependency(
  cwd: string,
  scenario: DemoScenario,
): Promise<DemoDependencyState> {
  try {
    return await collectDemoDependency(cwd, scenario);
  } catch {
    return { ready: false, versions: [] };
  }
}

export async function assertDemoDependency(cwd: string, scenario: DemoScenario): Promise<void> {
  const { ready, versions } = await collectDemoDependency(cwd, scenario);
  if (ready) return;

  const found = versions.length > 0 ? ` Found: ${versions.join(', ')}.` : '';
  throw new DemoError(
    `${scenario.packageName}@${scenario.packageVersion} is not installed in the lockfile.${found}\n` +
      `Add this deliberately vulnerable package first: npm install --save-exact ${scenario.packageName}@${scenario.packageVersion}`,
  );
}

export async function readPersistedSiteUuid(cwd: string): Promise<string | null> {
  try {
    const value = JSON.parse(await readFile(join(cwd, '.patchstackrc.json'), 'utf8')).siteUuid;
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function assertPersistedSiteUuid(cwd: string, expectedUuid: string): Promise<void> {
  const persisted = await readPersistedSiteUuid(cwd);
  if (persisted === null) {
    throw new DemoError(
      'The demo requires the Host-connected .patchstackrc.json. Connect Patchstack in Bolt first, then try again.',
    );
  }
  if (persisted !== expectedUuid) {
    throw new DemoError(
      `The active site UUID (${expectedUuid}) does not match .patchstackrc.json (${String(persisted)}). ` +
        'Remove the UUID override or reconnect this Bolt project before running the demo.',
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function renderDemoGuide(state: DemoGuideState): string {
  const { scenario } = state;
  const install = DEMO_INSTALL_COMMANDS[state.packageManager].replace(
    'node-serialize@0.0.4',
    `${scenario.packageName}@${scenario.packageVersion}`,
  );
  const remove = DEMO_REMOVE_COMMANDS[state.packageManager].replace(
    'node-serialize',
    scenario.packageName,
  );
  const demo =
    state.url === 'http://localhost:3000/api/tasks'
      ? `npx @patchstack/connect demo ${scenario.name}`
      : `npx @patchstack/connect demo ${scenario.name} --url ${shellQuote(state.url)}`;
  const siteReady = state.siteUuid !== null;
  const envReady = state.environment === 'production';
  const dependencyDetail = state.dependency.ready
    ? `${scenario.packageName}@${scenario.packageVersion} is in the lockfile`
    : state.dependency.versions.length > 0
      ? `found ${scenario.packageName}@${state.dependency.versions.join(', ')}; ${scenario.packageVersion} is required`
      : `${scenario.packageName}@${scenario.packageVersion} is not in the lockfile`;

  let next: string;
  if (!siteReady) {
    next = 'Click “Connect Patchstack” in Bolt, then run this guide again.';
  } else if (!envReady) {
    next = 'Unset PATCHSTACK_ENVIRONMENT (or set it to production), then run this guide again.';
  } else if (!state.dependency.ready) {
    next = install;
  } else {
    next = demo;
  }

  return [
    `Patchstack demo guide — ${scenario.name}`,
    '',
    'Goal: prove that a live Patchstack virtual patch blocks the vulnerable payload while normal traffic still succeeds.',
    'Deployment required: no. Keep the app running locally; the connector and generated guard contact Patchstack’s production API.',
    '',
    `1. ${siteReady ? '✓' : '○'} Connect this project from Bolt’s Host account dropdown`,
    siteReady
      ? `   Ready — .patchstackrc.json contains site ${state.siteUuid}.`
      : '   Click “Connect Patchstack” in Bolt. This creates .patchstackrc.json; no separate CLI login is needed.',
    '',
    `2. ${state.dependency.ready ? '✓' : '○'} Add the deliberately vulnerable demo dependency`,
    `   ${dependencyDetail}.`,
    `   ${install}`,
    '   Do not import or execute this package; its lockfile entry is enough for detection.',
    '',
    '3. ○ Run the production-backed demo setup',
    `   ${demo}`,
    ...(envReady
      ? []
      : ['   Blocked for now: this walkthrough needs PATCHSTACK_ENVIRONMENT=production.']),
    `   This scans the npm manifest, waits for live rule ${scenario.ruleId}, installs the server guard, verifies its wiring, and prints two test requests.`,
    '   It does not start the server or send the requests.',
    '',
    '4. ○ Restart the local dev server',
    '   Restart after the demo command so the application loads the generated guard.',
    '',
    '5. ○ Run both requests printed by the demo command',
    `   Exploit: expect HTTP 403 with Patchstack rule ${scenario.ruleId}.`,
    '   Control (“buy milk”): expect HTTP 201. This proves normal traffic is not blocked.',
    '',
    '6. ○ Clean up the throwaway vulnerability after the demonstration',
    `   ${remove}`,
    '   Re-run `npx @patchstack/connect scan` so the clean manifest is reported.',
    '',
    `Next: ${next}`,
  ].join('\n');
}

interface WaitForRuleOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function waitForDemoRule(
  manifestEndpoint: string,
  siteUuid: string,
  scenario: DemoScenario,
  options: WaitForRuleOptions = {},
): Promise<PulseRule> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const fetchFn = options.fetchFn ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const started = now();
  const rulesUrl = buildRulesUrl(manifestEndpoint, siteUuid);
  let lastDetail = 'the rule list was empty';

  do {
    try {
      const response = await fetchFn(rulesUrl, {
        headers: { Accept: 'application/json', 'User-Agent': '@patchstack/connect' },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (response.ok) {
        const data = (await response.json()) as { firewall?: PulseRule[] };
        const rules = Array.isArray(data.firewall) ? data.firewall : [];
        const matched = rules.find((rule) => String(rule.id) === String(scenario.ruleId));
        if (matched) return matched;
        lastDetail = `${rules.length} firewall rule(s) returned without rule ${scenario.ruleId}`;
      } else {
        lastDetail = `the rules API returned HTTP ${response.status}`;
      }
    } catch (error) {
      lastDetail = `the rules request failed: ${(error as Error).message}`;
    }

    const remaining = timeoutMs - (now() - started);
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  } while (now() - started <= timeoutMs);

  throw new DemoError(
    `Timed out waiting for Patchstack rule ${scenario.ruleId} for site ${siteUuid}; ${lastDetail}.`,
  );
}

export function renderDemoTestCommands(url: string, scenario: DemoScenario): string {
  const shellUrl = shellQuote(url);
  const command = (body: Record<string, string>) => {
    const encoded = Buffer.from(JSON.stringify(body)).toString('base64');
    return `node -e "process.stdout.write(Buffer.from('${encoded}','base64'))" | curl -i -X POST --url ${shellUrl} -H "Content-Type: application/json" --data-binary @-`;
  };
  return [
    'Restart the dev server so it loads the generated guard, then run:',
    '',
    `Blocked exploit (expect HTTP 403 and rule ${scenario.ruleId}):`,
    command(scenario.maliciousBody),
    '',
    'Benign request (expect HTTP 201):',
    command(scenario.benignBody),
  ].join('\n');
}
