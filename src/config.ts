import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PatchstackError, type Config } from './types.js';
import { DEFAULT_ENDPOINT } from './client.js';

const CONFIG_FILENAME = '.patchstackrc.json';

interface ConfigFile {
  siteUuid?: string;
  endpoint?: string;
}

export interface ResolveConfigOptions {
  cwd: string;
  cliSiteUuid?: string;
  cliEndpoint?: string;
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

  if (siteUuid === null || siteUuid.length === 0) {
    throw new PatchstackError(
      'No site UUID configured. Run `patchstack-connect init <site-uuid>` or set PATCHSTACK_SITE_UUID.',
      'CONFIG_MISSING',
    );
  }

  if (!isUuid(siteUuid)) {
    throw new PatchstackError(
      `Site UUID "${siteUuid}" does not look like a valid UUID.`,
      'CONFIG_MISSING',
    );
  }

  return { siteUuid, endpoint };
}

export async function writeConfigFile(cwd: string, config: ConfigFile): Promise<string> {
  const target = path.join(cwd, CONFIG_FILENAME);
  const content = JSON.stringify(config, null, 2) + '\n';
  await writeFile(target, content, 'utf8');
  return target;
}

async function readConfigFile(cwd: string): Promise<ConfigFile> {
  const target = path.join(cwd, CONFIG_FILENAME);
  try {
    const raw = await readFile(target, 'utf8');
    const parsed = JSON.parse(raw) as ConfigFile;
    return parsed;
  } catch {
    return {};
  }
}

function readEnv(): ConfigFile {
  return {
    siteUuid: process.env.PATCHSTACK_SITE_UUID ?? undefined,
    endpoint: process.env.PATCHSTACK_ENDPOINT ?? undefined,
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
