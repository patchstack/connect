#!/usr/bin/env node

// src/cli.ts
import { readFile as readFile3, writeFile as writeFile2 } from "fs/promises";
import path4 from "path";

// src/parsers/index.ts
import { access } from "fs/promises";
import path2 from "path";

// src/types.ts
var PatchstackError = class extends Error {
  constructor(message, code, cause) {
    super(message);
    this.code = code;
    this.cause = cause;
    this.name = "PatchstackError";
  }
  code;
  cause;
};

// src/parsers/npm.ts
import { readFile } from "fs/promises";
import path from "path";
async function parseNpmLockfile(lockfilePath) {
  let raw;
  try {
    raw = await readFile(lockfilePath, "utf8");
  } catch (cause) {
    throw new PatchstackError(`Could not read lockfile at ${lockfilePath}`, "LOCKFILE_NOT_FOUND", cause);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new PatchstackError(`Lockfile at ${lockfilePath} is not valid JSON`, "LOCKFILE_PARSE_ERROR", cause);
  }
  if (parsed.packages) {
    return extractFromV2(parsed.packages);
  }
  if (parsed.dependencies) {
    return extractFromV1(parsed.dependencies);
  }
  throw new PatchstackError(
    `Lockfile at ${lockfilePath} has no "packages" or "dependencies" key`,
    "LOCKFILE_PARSE_ERROR"
  );
}
function extractFromV2(packages) {
  const entries = [];
  for (const [pkgPath, pkg] of Object.entries(packages)) {
    if (pkgPath === "") {
      continue;
    }
    if (pkg.link === true) {
      continue;
    }
    if (typeof pkg.version !== "string" || pkg.version.length === 0) {
      continue;
    }
    const name = pkg.name ?? extractNameFromPath(pkgPath);
    if (name === null) {
      continue;
    }
    entries.push({
      name,
      version: pkg.version,
      path: pkgPath,
      direct: isDirectV2(pkgPath)
    });
  }
  return entries;
}
function extractFromV1(deps, acc = [], depth = 0) {
  for (const [name, dep] of Object.entries(deps)) {
    if (typeof dep.version === "string" && dep.version.length > 0) {
      acc.push({ name, version: dep.version, direct: depth === 0 });
    }
    if (dep.dependencies) {
      extractFromV1(dep.dependencies, acc, depth + 1);
    }
  }
  return acc;
}
function extractNameFromPath(pkgPath) {
  const segments = pkgPath.split("node_modules" + path.sep === pkgPath ? path.sep : "/");
  const parts = pkgPath.split("/");
  const nmIndex = parts.lastIndexOf("node_modules");
  if (nmIndex === -1 || nmIndex >= parts.length - 1) {
    return segments[segments.length - 1] ?? null;
  }
  const tail = parts.slice(nmIndex + 1);
  if (tail.length === 0) {
    return null;
  }
  const first = tail[0];
  if (first !== void 0 && first.startsWith("@") && tail.length >= 2) {
    return `${first}/${tail[1]}`;
  }
  return first ?? null;
}
function isDirectV2(pkgPath) {
  const parts = pkgPath.split("/");
  const nmCount = parts.filter((p) => p === "node_modules").length;
  return nmCount === 1;
}

// src/parsers/index.ts
async function detectLockfile(cwd) {
  const npmLock = path2.join(cwd, "package-lock.json");
  if (await exists(npmLock)) {
    return { ecosystem: "npm", filePath: npmLock, filename: "package-lock.json" };
  }
  const yarnLock = path2.join(cwd, "yarn.lock");
  if (await exists(yarnLock)) {
    throw new PatchstackError(
      "yarn.lock detected but not yet supported. Run `npm install` to generate a package-lock.json, or open an issue at github.com/patchstack/connect.",
      "LOCKFILE_UNSUPPORTED"
    );
  }
  const pnpmLock = path2.join(cwd, "pnpm-lock.yaml");
  if (await exists(pnpmLock)) {
    throw new PatchstackError(
      "pnpm-lock.yaml detected but not yet supported. Open an issue at github.com/patchstack/connect to request support.",
      "LOCKFILE_UNSUPPORTED"
    );
  }
  throw new PatchstackError(
    `No lockfile found in ${cwd}. Expected one of: package-lock.json, yarn.lock, pnpm-lock.yaml.`,
    "LOCKFILE_NOT_FOUND"
  );
}
async function scanLockfile(cwd) {
  const detected = await detectLockfile(cwd);
  const packages = await parseNpmLockfile(detected.filePath);
  return { ecosystem: detected.ecosystem, packages };
}
async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

// src/normalize.ts
function buildWirePayload(manifest) {
  const seen = /* @__PURE__ */ new Map();
  const wirePackages = [];
  for (const entry of manifest.packages) {
    const versions = seen.get(entry.name);
    if (versions) {
      if (versions.has(entry.version)) {
        continue;
      }
      versions.add(entry.version);
    } else {
      seen.set(entry.name, /* @__PURE__ */ new Set([entry.version]));
    }
    wirePackages.push({ name: entry.name, version: entry.version });
  }
  wirePackages.sort((a, b) => {
    if (a.name === b.name) {
      return compareVersions(a.version, b.version);
    }
    return a.name < b.name ? -1 : 1;
  });
  const duplicateNames = [];
  for (const [name, versions] of seen) {
    if (versions.size > 1) {
      duplicateNames.push(name);
    }
  }
  return {
    payload: { ecosystem: manifest.ecosystem, packages: wirePackages },
    stats: {
      uniqueNames: seen.size,
      duplicateNames,
      totalEntries: manifest.packages.length
    }
  };
}
function compareVersions(a, b) {
  if (a === b) {
    return 0;
  }
  const [aBase, aPre] = splitPrerelease(a);
  const [bBase, bPre] = splitPrerelease(b);
  const baseCmp = compareSegments(aBase.split("."), bBase.split("."));
  if (baseCmp !== 0) {
    return baseCmp;
  }
  if (aPre === null && bPre === null) {
    return 0;
  }
  if (aPre === null) {
    return 1;
  }
  if (bPre === null) {
    return -1;
  }
  return compareSegments(aPre.split("."), bPre.split("."));
}
function splitPrerelease(version) {
  const cleaned = version.replace(/^[v=]+/, "").split("+")[0];
  const dashIndex = cleaned.indexOf("-");
  if (dashIndex === -1) {
    return [cleaned, null];
  }
  return [cleaned.slice(0, dashIndex), cleaned.slice(dashIndex + 1)];
}
function compareSegments(a, b) {
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const aPart = a[i];
    const bPart = b[i];
    if (aPart === void 0) {
      return -1;
    }
    if (bPart === void 0) {
      return 1;
    }
    const aNum = /^\d+$/.test(aPart);
    const bNum = /^\d+$/.test(bPart);
    if (aNum && bNum) {
      const diff = Number(aPart) - Number(bPart);
      if (diff !== 0) {
        return diff < 0 ? -1 : 1;
      }
      continue;
    }
    if (aNum) {
      return -1;
    }
    if (bNum) {
      return 1;
    }
    if (aPart < bPart) {
      return -1;
    }
    if (aPart > bPart) {
      return 1;
    }
  }
  return 0;
}

// src/client.ts
var DEFAULT_API_BASE_URL = "https://app.patchstack.com/monitor";
var DEFAULT_ENDPOINT = `${DEFAULT_API_BASE_URL}/pulse/manifest`;
var DEFAULT_TIMEOUT_MS = 3e4;
function buildEndpointUrl(base, siteUuid) {
  const trimmed = base.replace(/\/$/, "");
  return `${trimmed}/${encodeURIComponent(siteUuid)}`;
}
function buildRedeemUrl(apiBaseUrl) {
  const trimmed = apiBaseUrl.replace(/\/$/, "");
  return `${trimmed}/pulse/integration/redeem`;
}
function buildManifestEndpoint(apiBaseUrl) {
  const trimmed = apiBaseUrl.replace(/\/$/, "");
  return `${trimmed}/pulse/manifest`;
}
async function redeemIntegrationToken(token, options = {}) {
  const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = buildRedeemUrl(apiBaseUrl);
  const body = { token };
  if (options.url !== void 0 && options.url !== "") body.url = options.url;
  if (options.appType !== void 0 && options.appType !== "") body.app_type = options.appType;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "@patchstack/connect"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (cause) {
    if (isTimeoutError(cause)) {
      throw new PatchstackError(
        `Patchstack request to ${url} timed out after ${timeoutMs}ms.`,
        "NETWORK_TIMEOUT",
        cause
      );
    }
    throw new PatchstackError(
      `Could not reach Patchstack at ${url}. Check your network connection.`,
      "NETWORK_ERROR",
      cause
    );
  }
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (response.status === 404) {
    throw new PatchstackError(
      parsed?.error ?? "Integration token not recognised. Generate a fresh one from the Patchstack dashboard.",
      "TOKEN_INVALID"
    );
  }
  if (response.status === 410) {
    throw new PatchstackError(
      parsed?.error ?? "Integration token has already been used or expired. Generate a fresh one from the Patchstack dashboard.",
      "TOKEN_USED_OR_EXPIRED"
    );
  }
  if (response.status === 422) {
    throw new PatchstackError(
      parsed?.error ?? "Patchstack rejected the token redemption request.",
      "VALIDATION_ERROR"
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new PatchstackError(
      `Patchstack returned ${response.status}: ${text.slice(0, 200)}`,
      "SERVER_ERROR"
    );
  }
  if (parsed === null || typeof parsed.uuid !== "string" || parsed.uuid.length === 0) {
    throw new PatchstackError("Patchstack did not return a site UUID for the integration token.", "SERVER_ERROR");
  }
  return { uuid: parsed.uuid, site_id: parsed.site_id };
}
async function postManifest(config, payload) {
  const url = buildEndpointUrl(config.endpoint, config.siteUuid);
  const timeoutMs = config.timeoutMs;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "@patchstack/connect"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (cause) {
    if (isTimeoutError(cause)) {
      throw new PatchstackError(
        `Patchstack request to ${url} timed out after ${timeoutMs}ms. Override with PATCHSTACK_TIMEOUT_MS.`,
        "NETWORK_TIMEOUT",
        cause
      );
    }
    throw new PatchstackError(
      `Could not reach Patchstack at ${url}. Check your network connection.`,
      "NETWORK_ERROR",
      cause
    );
  }
  const text = await response.text();
  let body = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (response.status === 404) {
    throw new PatchstackError(
      body?.error ?? "Site not found. Check that your site UUID is correct and that the app is registered as a Pulse app in your Patchstack dashboard.",
      "SITE_NOT_FOUND"
    );
  }
  if (response.status === 422) {
    throw new PatchstackError(
      body?.message ?? "Patchstack rejected the manifest payload (validation failed).",
      "VALIDATION_ERROR"
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new PatchstackError(
      `Patchstack returned ${response.status}: ${text.slice(0, 200)}`,
      "SERVER_ERROR"
    );
  }
  if (body === null) {
    throw new PatchstackError("Patchstack returned an empty response.", "SERVER_ERROR");
  }
  return body;
}
function isTimeoutError(cause) {
  if (cause instanceof Error) {
    return cause.name === "TimeoutError" || cause.name === "AbortError";
  }
  return false;
}

// src/config.ts
import { readFile as readFile2, writeFile } from "fs/promises";
import path3 from "path";
var CONFIG_FILENAME = ".patchstackrc.json";
async function resolveConfig(options) {
  const fromFile = await readConfigFile(options.cwd);
  const fromEnv = readEnv();
  const siteUuid = options.cliSiteUuid ?? fromEnv.siteUuid ?? fromFile.siteUuid ?? null;
  const endpoint = options.cliEndpoint ?? fromEnv.endpoint ?? fromFile.endpoint ?? DEFAULT_ENDPOINT;
  const timeoutMs = fromEnv.timeoutMs ?? fromFile.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (siteUuid === null || siteUuid.length === 0) {
    throw new PatchstackError(
      "No site UUID configured. Run `patchstack-connect init <site-uuid>` or set PATCHSTACK_SITE_UUID.",
      "CONFIG_MISSING"
    );
  }
  if (!isUuid(siteUuid)) {
    throw new PatchstackError(
      `Site UUID "${siteUuid}" does not look like a valid UUID.`,
      "CONFIG_INVALID"
    );
  }
  return { siteUuid, endpoint, timeoutMs };
}
async function writeConfigFile(cwd, config) {
  const target = path3.join(cwd, CONFIG_FILENAME);
  const content = JSON.stringify(config, null, 2) + "\n";
  await writeFile(target, content, "utf8");
  return target;
}
async function readConfigFile(cwd) {
  const target = path3.join(cwd, CONFIG_FILENAME);
  let raw;
  try {
    raw = await readFile2(target, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return {};
    }
    throw new PatchstackError(
      `Could not read ${target}: ${err.message}`,
      "CONFIG_INVALID",
      err
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new PatchstackError(
      `Config file ${target} contains invalid JSON.`,
      "CONFIG_INVALID",
      err
    );
  }
}
function readEnv() {
  const timeoutRaw = process.env.PATCHSTACK_TIMEOUT_MS;
  let timeoutMs;
  if (timeoutRaw !== void 0 && timeoutRaw.length > 0) {
    const parsed = Number(timeoutRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new PatchstackError(
        `PATCHSTACK_TIMEOUT_MS must be a positive number; got "${timeoutRaw}".`,
        "CONFIG_INVALID"
      );
    }
    timeoutMs = parsed;
  }
  return {
    siteUuid: process.env.PATCHSTACK_SITE_UUID ?? void 0,
    endpoint: process.env.PATCHSTACK_ENDPOINT ?? void 0,
    timeoutMs
  };
}
function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// src/cli.ts
var HELP = `@patchstack/connect \u2014 scan your lockfile and report packages to Patchstack.

Usage:
  patchstack-connect bootstrap <token>               One-shot: redeem an integration token, save config,
                                                     add the prebuild script, and run the first scan
  patchstack-connect init <site-uuid>                Save the site UUID to .patchstackrc.json
  patchstack-connect scan   [options]                Scan lockfile and POST to Patchstack
  patchstack-connect status [options]                Show current configuration
  patchstack-connect help                            Print this message

Options (for bootstrap):
  --api-url <url>         API base URL (default: https://app.patchstack.com/monitor)
  --url <url>             Optional site URL to register (e.g. https://my-app.lovable.app)
  --app-type <type>       Optional app type label (e.g. lovable, bolt-diy)
  --skip-prebuild         Do not patch package.json
  --skip-scan             Do not run an initial scan after bootstrap

Options (for scan and status):
  --site-uuid <uuid>      Override the configured site UUID
  --endpoint <url>        Override the API endpoint
  --dry-run               (scan only) Show the payload without posting

Environment:
  PATCHSTACK_SITE_UUID    Site UUID
  PATCHSTACK_ENDPOINT     API endpoint (default: https://app.patchstack.com/monitor/pulse/manifest)
  PATCHSTACK_API_URL      API base URL (default: https://app.patchstack.com/monitor)
  PATCHSTACK_TIMEOUT_MS   Request timeout in ms (default: 30000)

Precedence: CLI flag > environment variable > .patchstackrc.json.

Examples:
  npx @patchstack/connect bootstrap ac963c7608a8c527aac8a14bd92c0e519b84ff63400063a4e10e7e6c02b308d3
  npx @patchstack/connect init 550e8400-e29b-41d4-a716-446655440000
  npx @patchstack/connect scan
  npx @patchstack/connect scan --dry-run
`;
var VALUE_FLAGS = /* @__PURE__ */ new Set(["site-uuid", "endpoint", "api-url", "url", "app-type"]);
function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  const flags = /* @__PURE__ */ new Map();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const stripped = arg.slice(2);
    const eqIdx = stripped.indexOf("=");
    if (eqIdx !== -1) {
      flags.set(stripped.slice(0, eqIdx), stripped.slice(eqIdx + 1));
      continue;
    }
    const next = args[i + 1];
    if (VALUE_FLAGS.has(stripped) && next !== void 0 && !next.startsWith("--")) {
      flags.set(stripped, next);
      i++;
    } else {
      flags.set(stripped, true);
    }
  }
  return {
    command: positional.shift() ?? null,
    positional,
    flags
  };
}
function getStringFlag(flags, name) {
  const value = flags.get(name);
  return typeof value === "string" ? value : void 0;
}
async function runInit(args) {
  const uuid = args.positional[0];
  if (!uuid) {
    console.error("Error: site UUID is required.\n");
    console.error("Usage: patchstack-connect init <site-uuid>");
    return 1;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    console.error(`Error: "${uuid}" does not look like a valid UUID.`);
    return 1;
  }
  const target = await writeConfigFile(process.cwd(), { siteUuid: uuid });
  console.log(`Wrote ${target}`);
  console.log("");
  console.log("Next: run `npx @patchstack/connect scan` to send your first manifest.");
  return 0;
}
async function runScan(args) {
  const dryRun = args.flags.get("dry-run") === true;
  const config = await resolveConfig({
    cwd: process.cwd(),
    cliSiteUuid: getStringFlag(args.flags, "site-uuid"),
    cliEndpoint: getStringFlag(args.flags, "endpoint")
  });
  const manifest = await scanLockfile(process.cwd());
  const { payload, stats } = buildWirePayload(manifest);
  console.log(
    `Found ${payload.packages.length} unique package versions across ${stats.uniqueNames} package names in ${manifest.ecosystem} lockfile.`
  );
  if (stats.duplicateNames.length > 0) {
    console.log(`${stats.duplicateNames.length} package(s) appear at multiple versions:`);
    if (stats.duplicateNames.length <= 10) {
      console.log(`  ${stats.duplicateNames.join(", ")}`);
    }
  }
  if (dryRun) {
    console.log("");
    console.log("--dry-run: not posting to Patchstack. Payload preview:");
    const preview = JSON.stringify(payload, null, 2).split("\n");
    console.log(preview.slice(0, Math.min(preview.length, 30)).join("\n"));
    if (preview.length > 30) {
      console.log(`  ... (${preview.length - 30} more lines)`);
    }
    return 0;
  }
  const response = await postManifest(config, payload);
  if (response.stored) {
    console.log(`Stored manifest #${response.manifest_id} (checksum ${response.checksum}).`);
  } else if (response.reason === "duplicate") {
    console.log("Manifest unchanged since last scan \u2014 nothing to store.");
  } else {
    console.log(`Server response: ${response.message ?? JSON.stringify(response)}`);
  }
  return 0;
}
async function runStatus(args) {
  try {
    const config = await resolveConfig({
      cwd: process.cwd(),
      cliSiteUuid: getStringFlag(args.flags, "site-uuid"),
      cliEndpoint: getStringFlag(args.flags, "endpoint")
    });
    console.log(`Site UUID:  ${config.siteUuid}`);
    console.log(`Endpoint:   ${config.endpoint}`);
    console.log(`Timeout:    ${config.timeoutMs}ms`);
    return 0;
  } catch (err) {
    if (err instanceof PatchstackError && err.code === "CONFIG_MISSING") {
      console.log("Not configured. Run `patchstack-connect init <site-uuid>` to get started.");
      return 0;
    }
    throw err;
  }
}
async function patchPackageJsonPrebuild(cwd) {
  const target = path4.join(cwd, "package.json");
  let raw;
  try {
    raw = await readFile3(target, "utf8");
  } catch {
    return "skipped \u2014 no package.json in current directory";
  }
  const indentMatch = raw.match(/\n([ \t]+)\S/);
  const indent = indentMatch?.[1] ?? "  ";
  const newline = raw.endsWith("\n") ? "\n" : "";
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return "skipped \u2014 package.json is not valid JSON";
  }
  const scripts = pkg.scripts ?? {};
  if (typeof scripts.prebuild === "string" && scripts.prebuild.includes("patchstack-connect")) {
    return "unchanged \u2014 prebuild already calls patchstack-connect";
  }
  if (typeof scripts.prebuild === "string" && scripts.prebuild.length > 0) {
    return `skipped \u2014 package.json scripts.prebuild already exists ("${scripts.prebuild}"). Add "patchstack-connect scan" to it manually.`;
  }
  scripts.prebuild = "patchstack-connect scan";
  pkg.scripts = scripts;
  await writeFile2(target, JSON.stringify(pkg, null, indent) + newline, "utf8");
  return 'patched \u2014 added "prebuild": "patchstack-connect scan"';
}
async function runBootstrap(args) {
  const token = args.positional[0];
  if (!token) {
    console.error("Error: integration token is required.\n");
    console.error("Usage: patchstack-connect bootstrap <token>");
    return 1;
  }
  const apiBaseUrl = getStringFlag(args.flags, "api-url") ?? process.env.PATCHSTACK_API_URL ?? DEFAULT_API_BASE_URL;
  const siteUrl = getStringFlag(args.flags, "url");
  const appType = getStringFlag(args.flags, "app-type");
  const skipPrebuild = args.flags.get("skip-prebuild") === true;
  const skipScan = args.flags.get("skip-scan") === true;
  console.log(`Redeeming integration token at ${apiBaseUrl}\u2026`);
  const redeem = await redeemIntegrationToken(token, {
    apiBaseUrl,
    url: siteUrl,
    appType,
    timeoutMs: DEFAULT_TIMEOUT_MS
  });
  const manifestEndpoint = buildManifestEndpoint(apiBaseUrl);
  const configPath = await writeConfigFile(process.cwd(), {
    siteUuid: redeem.uuid,
    endpoint: manifestEndpoint
  });
  console.log(`Created Pulse site (id ${redeem.site_id}, uuid ${redeem.uuid}).`);
  console.log(`Wrote ${configPath}`);
  if (!skipPrebuild) {
    const result = await patchPackageJsonPrebuild(process.cwd());
    console.log(`package.json: ${result}`);
  }
  if (skipScan) {
    console.log("");
    console.log("Skipping initial scan (--skip-scan).");
    return 0;
  }
  console.log("");
  console.log("Running first scan\u2026");
  const config = await resolveConfig({ cwd: process.cwd() });
  const manifest = await scanLockfile(process.cwd());
  const { payload, stats } = buildWirePayload(manifest);
  console.log(
    `Found ${payload.packages.length} unique package versions across ${stats.uniqueNames} package names in ${manifest.ecosystem} lockfile.`
  );
  const response = await postManifest(config, payload);
  if (response.stored) {
    console.log(`Stored manifest #${response.manifest_id} (checksum ${response.checksum}).`);
  } else if (response.reason === "duplicate") {
    console.log("Manifest unchanged since last scan \u2014 nothing to store.");
  } else {
    console.log(`Server response: ${response.message ?? JSON.stringify(response)}`);
  }
  return 0;
}
async function main() {
  const args = parseArgs(process.argv);
  if (args.flags.has("help") || args.command === "help" || args.command === null) {
    console.log(HELP);
    return 0;
  }
  switch (args.command) {
    case "bootstrap":
      return runBootstrap(args);
    case "init":
      return runInit(args);
    case "scan":
      return runScan(args);
    case "status":
      return runStatus(args);
    default:
      console.error(`Unknown command: ${args.command}
`);
      console.error(HELP);
      return 1;
  }
}
main().then((code) => process.exit(code)).catch((err) => {
  if (err instanceof PatchstackError) {
    console.error(`Error (${err.code}): ${err.message}`);
    process.exit(1);
  }
  console.error("Unexpected error:", err);
  process.exit(2);
});
//# sourceMappingURL=cli.js.map