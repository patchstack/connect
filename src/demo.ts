import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { scanLockfile } from './parsers/index.js';
import { buildRulesUrl } from './client.js';

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

export async function assertDemoDependency(cwd: string, scenario: DemoScenario): Promise<void> {
  const manifest = await scanLockfile(cwd);
  const versions = [
    ...new Set(
      manifest.packages
        .filter((entry) => entry.name === scenario.packageName)
        .map((entry) => entry.version),
    ),
  ].sort();
  if (versions.includes(scenario.packageVersion)) return;

  const found = versions.length > 0 ? ` Found: ${versions.join(', ')}.` : '';
  throw new DemoError(
    `${scenario.packageName}@${scenario.packageVersion} is not installed in the lockfile.${found}\n` +
      `Add this deliberately vulnerable package first: npm install --save-exact ${scenario.packageName}@${scenario.packageVersion}`,
  );
}

export async function assertPersistedSiteUuid(cwd: string, expectedUuid: string): Promise<void> {
  let persisted: unknown;
  try {
    persisted = JSON.parse(await readFile(join(cwd, '.patchstackrc.json'), 'utf8')).siteUuid;
  } catch {
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
  const shellUrl = `'${url.replace(/'/g, `'\\''`)}'`;
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
