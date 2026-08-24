import { readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { PatchstackError, type Config, type Environment } from './types.js';
import { DEFAULT_ENDPOINT, DEFAULT_TIMEOUT_MS } from './client.js';

const CONFIG_FILENAME = '.patchstackrc.json';

/**
 * Where the CREDENTIAL lives, separately from the public config.
 *
 * The site UUID is public by design — it ships in the widget tag in served HTML — so its file is meant to
 * be committed, and setup says so. The API key is not: it authenticates ingest and block-log reporting for
 * the site. One file for both meant the instruction to commit the config was an instruction to commit a
 * secret, and this package's own ignore file protects nothing in somebody else's repository.
 *
 * Two files, one of which setup adds to the project's ignore list. A credential still read from the
 * committed file keeps working — several already exist — with a warning, because breaking those installs
 * would be a worse outcome than the warning.
 */
const SECRET_FILENAME = '.patchstackrc.local.json';

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
  const fromSecretFile = await readSecretFile(options.cwd);
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

  // The credential file first, then the committed config. Both are read: a credential written by an
  // earlier version lives in the committed file, and dropping support for it would break those installs
  // rather than move them.
  const apiKeyRaw = fromEnv.apiKey ?? fromSecretFile.apiKey ?? fromFile.apiKey ?? null;
  // Falls back to apiKey so sites provisioned before ADR-0018 authenticate
  // without re-provisioning: today both hold the same credential.
  const pulseAuthRaw = fromEnv.pulseAuth ?? fromSecretFile.pulseAuth ?? fromFile.pulseAuth ?? apiKeyRaw;

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

/** The credential file's name, for callers that tell a person where their credential went. */
export const SECRET_CONFIG_FILENAME = SECRET_FILENAME;

/**
 * What happened to the credential file, so a caller can say only what is true.
 *
 * `ignored` is the OUTCOME of the ignore entry, verified by reading the file back — not the fact that a
 * write was attempted. Telling somebody their credential is ignored when it is not is worse than telling
 * them nothing: they stop looking, and a credential committed once is in the history whether or not the
 * file is removed afterwards.
 */
export interface SecretFileResult {
  /** Absolute path of the credential file. */
  path: string;
  /** True only when `.gitignore` was read back and really covers it. */
  ignored: boolean;
  /** Why not, when it is not — for the caller to print instead of a false assurance. */
  reason?: string;
}

/**
 * Write the credential file, and make sure the project ignores it.
 *
 * The ignore entry is added here rather than left to the user, because the failure it prevents is silent
 * and permanent. The file is created owner-only: it holds a credential, and the default mode on a shared
 * machine is readable by everybody.
 */
export async function writeSecretFile(cwd: string, secrets: SecretFile): Promise<SecretFileResult> {
  const target = path.join(cwd, SECRET_FILENAME);
  await writeFile(target, JSON.stringify(secrets, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  // Explicit chmod as well as the create mode: an existing file keeps its old permissions, and a rotation
  // writes over one that may predate this.
  try {
    await chmod(target, 0o600);
  } catch {
    // Windows and some mounted filesystems have no POSIX mode. Not a reason to fail the write.
  }

  const ignore = await ensureIgnored(cwd, SECRET_FILENAME);

  return { path: target, ...ignore };
}

/**
 * Add a line to the project's `.gitignore` if it is not already covered, and report whether it now is.
 *
 * Deliberately conservative about the file: it appends one entry and never rewrites or reorders what is
 * there. A missing `.gitignore` is created, because a project without one is exactly the project that
 * would commit this.
 *
 * Not conservative about the ANSWER. Every failure — unreadable file, unwritable file, an entry that is
 * there but negated further down — comes back as `ignored: false` with a reason, because the caller's next
 * line is either an assurance or a warning and it has to be the right one.
 */
async function ensureIgnored(cwd: string, entry: string): Promise<{ ignored: boolean; reason?: string }> {
  const target = path.join(cwd, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(target, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      return { ignored: false, reason: `.gitignore could not be read (${code ?? 'unknown error'})` };
    }
  }

  if (ignoresEntry(existing, entry)) return { ignored: true };

  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  const block = `${separator}\n# Patchstack credential — never commit this\n${entry}\n`;
  try {
    await writeFile(target, existing + block, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;

    return { ignored: false, reason: `.gitignore could not be written (${code ?? 'unknown error'})` };
  }

  // Read back rather than assume. The write can succeed and still not produce coverage — a symlink into a
  // read-only location, a filesystem that silently truncates — and this is the only claim being made.
  try {
    const written = await readFile(target, 'utf8');
    if (ignoresEntry(written, entry)) return { ignored: true };

    return { ignored: false, reason: '.gitignore does not cover the file after writing it' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;

    return { ignored: false, reason: `.gitignore could not be read back (${code ?? 'unknown error'})` };
  }
}

/**
 * Whether the project currently ignores the credential file.
 *
 * A fresh verified read, for callers that are about to tell somebody their credential is safe but did not
 * write it themselves — the login flow rotates the credential several layers below the line that prints.
 */
export async function secretFileIgnored(cwd: string): Promise<{ ignored: boolean; reason?: string }> {
  try {
    const contents = await readFile(path.join(cwd, '.gitignore'), 'utf8');
    if (ignoresEntry(contents, SECRET_FILENAME)) return { ignored: true };

    return { ignored: false, reason: `.gitignore does not cover ${SECRET_FILENAME}` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;

    return {
      ignored: false,
      reason: code === 'ENOENT' ? 'this project has no .gitignore' : `.gitignore could not be read (${code ?? 'unknown error'})`,
    };
  }
}

/**
 * Does this `.gitignore` text actually ignore `entry`?
 *
 * Last match wins, as git resolves it: a `!entry` line below a matching pattern un-ignores the file, so a
 * scan that stops at the first positive line reports coverage a `git status` would contradict. Only exact
 * entries are recognised — a glob that happens to cover the file is not claimed, because claiming it wrong
 * is the failure this function exists to prevent.
 */
function ignoresEntry(contents: string, entry: string): boolean {
  let ignored = false;
  for (const raw of contents.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    const pattern = negated ? line.slice(1).trim() : line;
    if (pattern === entry || pattern === `/${entry}`) ignored = !negated;
  }

  return ignored;
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
 * Persist the WP-format api_key issued at provision. Authenticates both the Pulse endpoints and connector
 * log reporting. Never embed it in the public disclosure widget.
 *
 * Written to the credential file, which setup adds to the project's ignore list — the public config is
 * meant to be committed, so a credential in it is a credential in the repository.
 *
 * Any copy in the committed config is REMOVED at the same time. Leaving it would mean the value that just
 * got moved is still in the file everyone commits, which is the state this split exists to end. `pulseAuth`
 * goes with it: that field resolves ahead of `apiKey`, so a stale copy would keep authenticating with a
 * credential the server has replaced.
 */
export async function persistApiKey(cwd: string, apiKey: string): Promise<SecretFileResult> {
  const { apiKey: _movedKey, pulseAuth: _movedPulse, ...publicConfig } = await readConfigFile(cwd);
  const existingSecrets = await readSecretFile(cwd);

  const target = await writeSecretFile(cwd, { ...existingSecrets, apiKey, pulseAuth: undefined });

  // Only rewritten when it actually held a credential, so a normal provision does not touch it.
  if (_movedKey !== undefined || _movedPulse !== undefined) {
    await writeConfigFile(cwd, publicConfig);
  }

  return target;
}

/**
 * Persist a Pulse-specific credential.
 *
 * Only needed when Pulse ingest and block-log reporting must use *different*
 * credentials; they share one today, so `persistApiKey` covers both. Retained
 * for callers that separate them.
 */
export async function persistPulseAuth(cwd: string, pulseAuth: string): Promise<SecretFileResult> {
  const existing = await readSecretFile(cwd);

  return writeSecretFile(cwd, { ...existing, pulseAuth });
}

/**
 * Whether the committed config still holds a credential, so a caller can say so.
 *
 * Reported rather than fixed silently: the file is in the project's history if it was ever committed, and
 * rotating the credential is the only thing that actually resolves that. Moving it and saying nothing would
 * leave someone believing they were fine.
 */
export async function credentialInCommittedConfig(cwd: string): Promise<boolean> {
  const config = await readConfigFile(cwd);

  return config.apiKey !== undefined || config.pulseAuth !== undefined;
}

/** The credential file. Same shape as the config's credential fields, and nothing else. */
interface SecretFile {
  apiKey?: string;
  pulseAuth?: string;
}

async function readSecretFile(cwd: string): Promise<SecretFile> {
  const file = await readJsonFile(cwd, SECRET_FILENAME);

  return { apiKey: file.apiKey, pulseAuth: file.pulseAuth };
}

async function readConfigFile(cwd: string): Promise<ConfigFile> {
  return readJsonFile(cwd, CONFIG_FILENAME);
}

async function readJsonFile(cwd: string, filename: string): Promise<ConfigFile> {
  const target = path.join(cwd, filename);
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
