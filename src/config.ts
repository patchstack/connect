import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PatchstackError, type Config, type Environment } from './types.js';
import { DEFAULT_ENDPOINT, DEFAULT_TIMEOUT_MS } from './client.js';

const CONFIG_FILENAME = '.patchstackrc.json';

export const DEFAULT_ENVIRONMENT: Environment = 'production';

interface ConfigFile {
  siteUuid?: string;
  /** WP-format `{secret}-{oauth.id}` for connector /api/logs/log. Server-only. */
  apiKey?: string;
  /**
   * Credential for the authenticated Pulse endpoints (ADR-0018). Same format as
   * `apiKey` and today the same value, but kept as its own field so the Pulse
   * and block-log paths can diverge without disturbing each other. Server-only.
   */
  pulseAuth?: string;
  endpoint?: string;
  timeoutMs?: number;
  environment?: string;
  widget?: boolean;
}

export interface ResolveConfigOptions {
  cwd: string;
  cliSiteUuid?: string;
  cliEndpoint?: string;
  /**
   * When true, resolveConfig throws CONFIG_MISSING if no site UUID is configured.
   * Defaults to false: callers that can run without a UUID (the first `scan` after
   * `npm install`) just get `siteUuid: null` back and learn the UUID from the
   * server response.
   */
  requireSiteUuid?: boolean;
}

export async function resolveConfig(options: ResolveConfigOptions): Promise<Config> {
  const fromFile = await readConfigFile(options.cwd);
  const fromEnv = readEnv();

  const siteUuid =
    options.cliSiteUuid ??
    fromEnv.siteUuid ??
    fromFile.siteUuid ??
    null;

  const endpoint =
    options.cliEndpoint ??
    fromEnv.endpoint ??
    fromFile.endpoint ??
    DEFAULT_ENDPOINT;

  const timeoutMs = fromEnv.timeoutMs ?? fromFile.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const environmentRaw = fromEnv.environment ?? fromFile.environment;
  if (environmentRaw !== undefined && !isEnvironment(environmentRaw)) {
    throw new PatchstackError(
      `Environment must be "production" or "sandbox"; got "${environmentRaw}".`,
      'CONFIG_INVALID',
    );
  }
  const environment: Environment = environmentRaw ?? DEFAULT_ENVIRONMENT;

  if (siteUuid !== null && siteUuid.length > 0 && !isUuid(siteUuid)) {
    throw new PatchstackError(
      `Site UUID "${siteUuid}" does not look like a valid UUID.`,
      'CONFIG_INVALID',
    );
  }

  if (options.requireSiteUuid && (siteUuid === null || siteUuid.length === 0)) {
    throw new PatchstackError(
      'No site UUID configured. Run `patchstack-connect scan` to provision one, or set PATCHSTACK_SITE_UUID.',
      'CONFIG_MISSING',
    );
  }

  const apiKeyRaw = fromEnv.apiKey ?? fromFile.apiKey ?? null;
  // Falls back to apiKey so sites provisioned before ADR-0018 authenticate
  // without re-provisioning: today both hold the same credential.
  const pulseAuthRaw = fromEnv.pulseAuth ?? fromFile.pulseAuth ?? apiKeyRaw;

  return {
    siteUuid: siteUuid === null || siteUuid.length === 0 ? null : siteUuid,
    apiKey: apiKeyRaw === null || apiKeyRaw.length === 0 ? null : apiKeyRaw,
    pulseAuth: pulseAuthRaw === null || pulseAuthRaw.length === 0 ? null : pulseAuthRaw,
    endpoint,
    timeoutMs,
    environment,
    widget: fromFile.widget !== false,
  };
}

export async function writeConfigFile(cwd: string, config: ConfigFile): Promise<string> {
  const target = path.join(cwd, CONFIG_FILENAME);
  const content = JSON.stringify(config, null, 2) + '\n';
  await writeFile(target, content, 'utf8');
  return target;
}

/**
 * Merge a new siteUuid into the existing `.patchstackrc.json` (or create it).
 * Preserves any `endpoint` / `timeoutMs` / `apiKey` the user already wrote.
 */
export async function persistSiteUuid(cwd: string, siteUuid: string): Promise<string> {
  const existing = await readConfigFile(cwd);
  return writeConfigFile(cwd, { ...existing, siteUuid });
}

/**
 * Persist the WP-format api_key issued at provision. Authenticates both the
 * Pulse endpoints and connector log reporting. Never embed it in the public
 * disclosure widget.
 *
 * Drops any `pulseAuth` written by an earlier version. That field resolves
 * ahead of `apiKey`, so leaving a copy behind after the credential changes
 * would leave Pulse authenticating with the value the server just replaced.
 */
export async function persistApiKey(cwd: string, apiKey: string): Promise<string> {
  const { pulseAuth: _dropped, ...existing } = await readConfigFile(cwd);
  return writeConfigFile(cwd, { ...existing, apiKey });
}

/**
 * Persist a Pulse-specific credential.
 *
 * Only needed when Pulse ingest and block-log reporting must use *different*
 * credentials; they share one today, so `persistApiKey` covers both. Retained
 * for callers that separate them.
 */
export async function persistPulseAuth(cwd: string, pulseAuth: string): Promise<string> {
  const existing = await readConfigFile(cwd);
  return writeConfigFile(cwd, { ...existing, pulseAuth });
}

async function readConfigFile(cwd: string): Promise<ConfigFile> {
  const target = path.join(cwd, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await readFile(target, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new PatchstackError(
      `Could not read ${target}: ${(err as Error).message}`,
      'CONFIG_INVALID',
      err,
    );
  }

  try {
    return JSON.parse(raw) as ConfigFile;
  } catch (err) {
    throw new PatchstackError(
      `Config file ${target} contains invalid JSON.`,
      'CONFIG_INVALID',
      err,
    );
  }
}

function readEnv(): ConfigFile {
  const timeoutRaw = process.env.PATCHSTACK_TIMEOUT_MS;
  let timeoutMs: number | undefined;
  if (timeoutRaw !== undefined && timeoutRaw.length > 0) {
    const parsed = Number(timeoutRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new PatchstackError(
        `PATCHSTACK_TIMEOUT_MS must be a positive number; got "${timeoutRaw}".`,
        'CONFIG_INVALID',
      );
    }
    timeoutMs = parsed;
  }
  const environmentRaw = process.env.PATCHSTACK_ENVIRONMENT;
  return {
    siteUuid: process.env.PATCHSTACK_SITE_UUID ?? undefined,
    apiKey: process.env.PATCHSTACK_API_KEY ?? undefined,
    pulseAuth: process.env.PATCHSTACK_PULSE_AUTH ?? undefined,
    endpoint: process.env.PATCHSTACK_ENDPOINT ?? undefined,
    timeoutMs,
    environment:
      environmentRaw !== undefined && environmentRaw.length > 0 ? environmentRaw : undefined,
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isEnvironment(value: string): value is Environment {
  return value === 'production' || value === 'sandbox';
}
