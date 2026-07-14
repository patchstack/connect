import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteTextFile } from './atomic-write.js';
import { PatchstackError, type Config, type Environment } from './types.js';
import { DEFAULT_ENDPOINT, DEFAULT_TIMEOUT_MS, isUuid, validateEndpoint } from './client.js';

const CONFIG_FILENAME = '.patchstackrc.json';

export const DEFAULT_ENVIRONMENT: Environment = 'production';

interface ConfigFile {
  siteUuid?: string;
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

  if (options.cliSiteUuid !== undefined && options.cliSiteUuid.trim().length === 0) {
    throw new PatchstackError(
      '--site-uuid requires a non-empty UUID; refusing to provision or replace a site from a blank override.',
      'CONFIG_INVALID',
    );
  }

  const siteUuid =
    options.cliSiteUuid ??
    nonBlank(fromEnv.siteUuid) ??
    nonBlank(fromFile.siteUuid) ??
    null;

  const endpoint =
    options.cliEndpoint ??
    nonBlank(fromEnv.endpoint) ??
    fromFile.endpoint ??
    DEFAULT_ENDPOINT;
  validateEndpoint(endpoint);

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

  return {
    siteUuid: siteUuid === null || siteUuid.length === 0 ? null : siteUuid,
    endpoint,
    timeoutMs,
    environment,
    widgetEnabled: fromFile.widget ?? true,
  };
}

export async function writeConfigFile(cwd: string, config: ConfigFile): Promise<string> {
  const target = path.join(cwd, CONFIG_FILENAME);
  const content = JSON.stringify(config, null, 2) + '\n';
  await atomicWriteTextFile(target, content);
  return target;
}

/**
 * Merge a new siteUuid into the existing `.patchstackrc.json` (or create it).
 * Preserves all existing connector settings, including the widget opt-out.
 */
export async function persistSiteUuid(
  cwd: string,
  siteUuid: string,
  endpoint?: string,
): Promise<string> {
  if (!isUuid(siteUuid)) {
    throw new PatchstackError(
      `Site UUID "${siteUuid}" does not look like a valid UUID.`,
      'CONFIG_INVALID',
    );
  }

  const existing = await readConfigFile(cwd);
  const existingSiteUuid = nonBlank(existing.siteUuid);
  if (existingSiteUuid !== undefined) {
    if (!isUuid(existingSiteUuid)) {
      throw new PatchstackError(
        `Existing site UUID "${existingSiteUuid}" in ${path.join(cwd, CONFIG_FILENAME)} does not look like a valid UUID.`,
        'CONFIG_INVALID',
      );
    }
    if (existingSiteUuid.toLowerCase() !== siteUuid.toLowerCase()) {
      throw new PatchstackError(
        `Refusing to replace existing site UUID ${existingSiteUuid} with ${siteUuid}. Remove or update ${CONFIG_FILENAME} explicitly if this project should target a different site.`,
        'CONFIG_INVALID',
      );
    }
  }
  if (endpoint !== undefined) {
    validateEndpoint(endpoint);
  }
  return writeConfigFile(cwd, {
    ...existing,
    siteUuid,
    ...(endpoint !== undefined ? { endpoint } : {}),
  });
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
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new PatchstackError(
        `Config file ${target} must contain a JSON object.`,
        'CONFIG_INVALID',
      );
    }

    const config = parsed as Record<string, unknown>;
    if (config.siteUuid !== undefined && typeof config.siteUuid !== 'string') {
      throw new PatchstackError(
        `Config file ${target} field "siteUuid" must be a string.`,
        'CONFIG_INVALID',
      );
    }
    if (
      config.endpoint !== undefined &&
      (typeof config.endpoint !== 'string' || config.endpoint.length === 0)
    ) {
      throw new PatchstackError(
        `Config file ${target} field "endpoint" must be a non-empty string.`,
        'CONFIG_INVALID',
      );
    }
    if (
      config.timeoutMs !== undefined &&
      (typeof config.timeoutMs !== 'number' ||
        !Number.isFinite(config.timeoutMs) ||
        config.timeoutMs <= 0)
    ) {
      throw new PatchstackError(
        `Config file ${target} field "timeoutMs" must be a positive number.`,
        'CONFIG_INVALID',
      );
    }
    if (config.environment !== undefined && typeof config.environment !== 'string') {
      throw new PatchstackError(
        `Config file ${target} field "environment" must be a string.`,
        'CONFIG_INVALID',
      );
    }
    if (config.widget !== undefined && typeof config.widget !== 'boolean') {
      throw new PatchstackError(
        `Config file ${target} field "widget" must be a boolean.`,
        'CONFIG_INVALID',
      );
    }

    return config as ConfigFile;
  } catch (err) {
    if (err instanceof PatchstackError) {
      throw err;
    }
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
    endpoint: process.env.PATCHSTACK_ENDPOINT ?? undefined,
    timeoutMs,
    environment:
      environmentRaw !== undefined && environmentRaw.length > 0 ? environmentRaw : undefined,
  };
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

function isEnvironment(value: string): value is Environment {
  return value === 'production' || value === 'sandbox';
}
