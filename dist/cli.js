#!/usr/bin/env node

// src/parsers/index.ts
import { access } from "fs/promises";
import path3 from "path";

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

// src/parsers/node_modules.ts
import { lstat, readFile as readFile2, readdir, stat } from "fs/promises";
import path2 from "path";
async function walkNodeModules(cwd) {
  const root = path2.join(cwd, "node_modules");
  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      throw new PatchstackError(
        `${root} exists but is not a directory.`,
        "LOCKFILE_NOT_FOUND"
      );
    }
  } catch (cause) {
    if (cause instanceof PatchstackError) {
      throw cause;
    }
    throw new PatchstackError(
      `node_modules/ not found at ${cwd}. Install dependencies first (e.g. \`bun install\` or \`npm install\`).`,
      "LOCKFILE_NOT_FOUND",
      cause
    );
  }
  const entries = [];
  await walk(root, entries, 0);
  return entries;
}
async function walk(dir, acc, depth) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(".")) {
      continue;
    }
    const fullPath = path2.join(dir, name);
    if (!await isPlainDirectory(fullPath)) {
      continue;
    }
    if (name.startsWith("@")) {
      let subNames;
      try {
        subNames = await readdir(fullPath);
      } catch {
        continue;
      }
      for (const sub of subNames) {
        if (sub.startsWith(".")) {
          continue;
        }
        const scopedDir = path2.join(fullPath, sub);
        if (!await isPlainDirectory(scopedDir)) {
          continue;
        }
        await readPackage(scopedDir, depth, acc);
        await walkNested(scopedDir, acc, depth);
      }
      continue;
    }
    await readPackage(fullPath, depth, acc);
    await walkNested(fullPath, acc, depth);
  }
}
async function readPackage(pkgDir, depth, acc) {
  let raw;
  try {
    raw = await readFile2(path2.join(pkgDir, "package.json"), "utf8");
  } catch {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof parsed.name !== "string" || parsed.name.length === 0) {
    return;
  }
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    return;
  }
  acc.push({
    name: parsed.name,
    version: parsed.version,
    direct: depth === 0
  });
}
async function walkNested(pkgDir, acc, depth) {
  const nested = path2.join(pkgDir, "node_modules");
  if (!await isPlainDirectory(nested)) {
    return;
  }
  await walk(nested, acc, depth + 1);
}
async function isPlainDirectory(dir) {
  try {
    const info = await lstat(dir);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

// src/parsers/pnpm.ts
import { readFile as readFile3 } from "fs/promises";
async function parsePnpmLockfile(lockfilePath) {
  let raw;
  try {
    raw = await readFile3(lockfilePath, "utf8");
  } catch (cause) {
    throw new PatchstackError(
      `Could not read lockfile at ${lockfilePath}`,
      "LOCKFILE_NOT_FOUND",
      cause
    );
  }
  const lines = raw.split(/\r?\n/);
  const directNames = collectDirectDepNames(lines);
  const packageKeys = collectPackagesBlockKeys(lines);
  if (packageKeys.length === 0) {
    throw new PatchstackError(
      `Lockfile at ${lockfilePath} has no "packages" entries`,
      "LOCKFILE_PARSE_ERROR"
    );
  }
  const entries = [];
  for (const key of packageKeys) {
    const parsed = parsePackageKey(key);
    if (parsed === null) {
      continue;
    }
    entries.push({
      name: parsed.name,
      version: parsed.version,
      direct: directNames.has(parsed.name)
    });
  }
  return entries;
}
function parsePackageKey(rawKey) {
  let k = rawKey.trim();
  if (k.length === 0) {
    return null;
  }
  if (k.startsWith("'") && k.endsWith("'") || k.startsWith('"') && k.endsWith('"')) {
    k = k.slice(1, -1);
  }
  if (k.startsWith("/")) {
    k = k.slice(1);
  }
  const parenIdx = k.indexOf("(");
  if (parenIdx >= 0) {
    k = k.slice(0, parenIdx);
  }
  let scopePrefix = "";
  let body = k;
  if (k.startsWith("@")) {
    const firstSlash = k.indexOf("/");
    if (firstSlash <= 0) {
      return null;
    }
    scopePrefix = k.slice(0, firstSlash + 1);
    body = k.slice(firstSlash + 1);
  }
  const slashIdx = body.indexOf("/");
  const atIdx = body.indexOf("@");
  let sepIdx;
  if (slashIdx < 0 && atIdx < 0) {
    return null;
  } else if (slashIdx < 0) {
    sepIdx = atIdx;
  } else if (atIdx < 0) {
    sepIdx = slashIdx;
  } else {
    sepIdx = Math.min(slashIdx, atIdx);
  }
  const name = scopePrefix + body.slice(0, sepIdx);
  let version = body.slice(sepIdx + 1);
  const underscoreIdx = version.indexOf("_");
  if (underscoreIdx >= 0) {
    version = version.slice(0, underscoreIdx);
  }
  if (name.length === 0 || version.length === 0) {
    return null;
  }
  return { name, version };
}
function indentOf(line) {
  let i = 0;
  while (i < line.length && line[i] === " ") {
    i++;
  }
  return i;
}
function isBlankOrComment(line) {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith("#");
}
function collectPackagesBlockKeys(lines) {
  const keys = [];
  let inBlock = false;
  let childIndent = null;
  for (const line of lines) {
    if (isBlankOrComment(line)) {
      continue;
    }
    const indent = indentOf(line);
    if (!inBlock) {
      if (indent === 0 && line.trim() === "packages:") {
        inBlock = true;
      }
      continue;
    }
    if (indent === 0) {
      break;
    }
    if (childIndent === null) {
      childIndent = indent;
    }
    if (indent !== childIndent) {
      continue;
    }
    const content = line.slice(indent);
    if (!content.endsWith(":")) {
      continue;
    }
    keys.push(content.slice(0, -1));
  }
  return keys;
}
function collectDirectDepNames(lines) {
  const names = /* @__PURE__ */ new Set();
  collectFromImporters(lines, names);
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    collectFromTopLevelSection(lines, section, names);
  }
  return names;
}
var DEP_SECTIONS = /* @__PURE__ */ new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies"
]);
function collectFromImporters(lines, out) {
  let inImporters = false;
  let importerIndent = null;
  let inDepSection = false;
  let depSectionIndent = null;
  let leafIndent = null;
  for (const line of lines) {
    if (isBlankOrComment(line)) {
      continue;
    }
    const indent = indentOf(line);
    const trimmed = line.trim();
    if (!inImporters) {
      if (indent === 0 && trimmed === "importers:") {
        inImporters = true;
      }
      continue;
    }
    if (indent === 0) {
      break;
    }
    if (importerIndent === null) {
      importerIndent = indent;
    }
    if (indent === importerIndent) {
      inDepSection = false;
      depSectionIndent = null;
      leafIndent = null;
      continue;
    }
    if (!inDepSection) {
      const key = stripTrailingColon(trimmed);
      if (key !== null && DEP_SECTIONS.has(key)) {
        inDepSection = true;
        depSectionIndent = indent;
      }
      continue;
    }
    if (depSectionIndent !== null && indent <= depSectionIndent) {
      inDepSection = false;
      depSectionIndent = null;
      leafIndent = null;
      const key = stripTrailingColon(trimmed);
      if (key !== null && DEP_SECTIONS.has(key)) {
        inDepSection = true;
        depSectionIndent = indent;
      }
      continue;
    }
    if (leafIndent === null) {
      leafIndent = indent;
    }
    if (indent !== leafIndent) {
      continue;
    }
    const name = extractLeafName(trimmed);
    if (name !== null) {
      out.add(name);
    }
  }
}
function collectFromTopLevelSection(lines, section, out) {
  let inSection = false;
  let leafIndent = null;
  for (const line of lines) {
    if (isBlankOrComment(line)) {
      continue;
    }
    const indent = indentOf(line);
    const trimmed = line.trim();
    if (!inSection) {
      if (indent === 0 && trimmed === `${section}:`) {
        inSection = true;
      }
      continue;
    }
    if (indent === 0) {
      break;
    }
    if (leafIndent === null) {
      leafIndent = indent;
    }
    if (indent !== leafIndent) {
      continue;
    }
    const name = extractLeafName(trimmed);
    if (name !== null) {
      out.add(name);
    }
  }
}
function stripTrailingColon(s) {
  if (!s.endsWith(":")) {
    return null;
  }
  return s.slice(0, -1).trim();
}
function extractLeafName(trimmed) {
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx < 0) {
    return null;
  }
  let name = trimmed.slice(0, colonIdx).trim();
  if (name.length === 0) {
    return null;
  }
  if (name.startsWith("'") && name.endsWith("'") || name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1);
  }
  return name.length > 0 ? name : null;
}

// src/parsers/index.ts
async function detectLockfile(cwd) {
  const npmLock = path3.join(cwd, "package-lock.json");
  if (await exists(npmLock)) {
    return {
      ecosystem: "npm",
      filePath: npmLock,
      filename: "package-lock.json",
      strategy: "npm-lockfile"
    };
  }
  const bunLock = path3.join(cwd, "bun.lock");
  if (await exists(bunLock)) {
    return {
      ecosystem: "npm",
      filePath: bunLock,
      filename: "bun.lock",
      strategy: "node-modules-walk"
    };
  }
  const bunLockB = path3.join(cwd, "bun.lockb");
  if (await exists(bunLockB)) {
    return {
      ecosystem: "npm",
      filePath: bunLockB,
      filename: "bun.lockb",
      strategy: "node-modules-walk"
    };
  }
  const pnpmLock = path3.join(cwd, "pnpm-lock.yaml");
  if (await exists(pnpmLock)) {
    return {
      ecosystem: "npm",
      filePath: pnpmLock,
      filename: "pnpm-lock.yaml",
      strategy: "pnpm-lockfile"
    };
  }
  const yarnLock = path3.join(cwd, "yarn.lock");
  if (await exists(yarnLock)) {
    throw new PatchstackError(
      "yarn.lock detected but not yet supported. Run `npm install` to generate a package-lock.json, or open an issue at github.com/patchstack/connect.",
      "LOCKFILE_UNSUPPORTED"
    );
  }
  throw new PatchstackError(
    `No lockfile found in ${cwd}. Expected one of: package-lock.json, bun.lock, bun.lockb, yarn.lock, pnpm-lock.yaml.`,
    "LOCKFILE_NOT_FOUND"
  );
}
async function scanLockfile(cwd) {
  const detected = await detectLockfile(cwd);
  const packages = await runStrategy(detected, cwd);
  return { ecosystem: detected.ecosystem, packages };
}
async function runStrategy(detected, cwd) {
  switch (detected.strategy) {
    case "npm-lockfile":
      return parseNpmLockfile(detected.filePath);
    case "pnpm-lockfile":
      return parsePnpmLockfile(detected.filePath);
    case "node-modules-walk":
      return walkNodeModules(cwd);
  }
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
var DEFAULT_ENDPOINT = "https://api.patchstack.com/monitor/pulse/manifest";
var DEFAULT_TIMEOUT_MS = 3e4;
function buildEndpointUrl(base, siteUuid) {
  const trimmed = base.replace(/\/$/, "");
  return siteUuid !== void 0 && siteUuid !== null && siteUuid.length > 0 ? `${trimmed}/${encodeURIComponent(siteUuid)}` : trimmed;
}
function buildClaimUrl(endpoint, siteUuid) {
  const origin = new URL(endpoint).origin;
  return `${origin}/monitor/claim?site=${encodeURIComponent(siteUuid)}`;
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
import { readFile as readFile4, writeFile } from "fs/promises";
import path4 from "path";
var CONFIG_FILENAME = ".patchstackrc.json";
async function resolveConfig(options) {
  const fromFile = await readConfigFile(options.cwd);
  const fromEnv = readEnv();
  const siteUuid = options.cliSiteUuid ?? fromEnv.siteUuid ?? fromFile.siteUuid ?? null;
  const endpoint = options.cliEndpoint ?? fromEnv.endpoint ?? fromFile.endpoint ?? DEFAULT_ENDPOINT;
  const timeoutMs = fromEnv.timeoutMs ?? fromFile.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (siteUuid !== null && siteUuid.length > 0 && !isUuid(siteUuid)) {
    throw new PatchstackError(
      `Site UUID "${siteUuid}" does not look like a valid UUID.`,
      "CONFIG_INVALID"
    );
  }
  if (options.requireSiteUuid && (siteUuid === null || siteUuid.length === 0)) {
    throw new PatchstackError(
      "No site UUID configured. Run `patchstack-connect scan` to provision one, or set PATCHSTACK_SITE_UUID.",
      "CONFIG_MISSING"
    );
  }
  return {
    siteUuid: siteUuid === null || siteUuid.length === 0 ? null : siteUuid,
    endpoint,
    timeoutMs
  };
}
async function writeConfigFile(cwd, config) {
  const target = path4.join(cwd, CONFIG_FILENAME);
  const content = JSON.stringify(config, null, 2) + "\n";
  await writeFile(target, content, "utf8");
  return target;
}
async function persistSiteUuid(cwd, siteUuid) {
  const existing = await readConfigFile(cwd);
  return writeConfigFile(cwd, { ...existing, siteUuid });
}
async function readConfigFile(cwd) {
  const target = path4.join(cwd, CONFIG_FILENAME);
  let raw;
  try {
    raw = await readFile4(target, "utf8");
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
  patchstack-connect scan   [options]                Scan lockfile and POST to Patchstack.
                                                     If no UUID is configured, the server
                                                     provisions one and we persist it.
  patchstack-connect init   <site-uuid>              Optional: pre-seed .patchstackrc.json
                                                     with an existing site UUID
  patchstack-connect status [options]                Show current configuration
  patchstack-connect help                            Print this message

Options (for scan and status):
  --site-uuid <uuid>      Override the configured site UUID
  --endpoint <url>        Override the API endpoint
  --dry-run               (scan only) Show the payload without posting

Environment:
  PATCHSTACK_SITE_UUID    Site UUID
  PATCHSTACK_ENDPOINT     API endpoint (default: https://api.patchstack.com/monitor/pulse/manifest)
  PATCHSTACK_TIMEOUT_MS   Request timeout in ms (default: 30000)

Precedence: CLI flag > environment variable > .patchstackrc.json.

Examples:
  npx @patchstack/connect scan
  npx @patchstack/connect scan --dry-run
  npx @patchstack/connect init 550e8400-e29b-41d4-a716-446655440000
  npx @patchstack/connect scan --site-uuid 550e8400-...-446655440000
`;
var VALUE_FLAGS = /* @__PURE__ */ new Set(["site-uuid", "endpoint"]);
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
    if (config.siteUuid === null) {
      console.log("--dry-run: no site UUID configured. A real run would provision one.");
    } else {
      console.log(`--dry-run: not posting to Patchstack (site UUID ${config.siteUuid}).`);
    }
    console.log("Payload preview:");
    const preview = JSON.stringify(payload, null, 2).split("\n");
    console.log(preview.slice(0, Math.min(preview.length, 30)).join("\n"));
    if (preview.length > 30) {
      console.log(`  ... (${preview.length - 30} more lines)`);
    }
    return 0;
  }
  const provisioning = config.siteUuid === null;
  if (provisioning) {
    console.log("No site UUID configured \u2014 provisioning a new Patchstack site from this manifest\u2026");
  }
  const response = await postManifest(config, payload);
  if (provisioning && response.uuid !== void 0 && response.uuid.length > 0) {
    const target = await persistSiteUuid(process.cwd(), response.uuid);
    console.log(`Provisioned site ${response.uuid}. Saved UUID to ${target}.`);
  }
  if (response.stored) {
    console.log(`Stored manifest #${response.manifest_id} (checksum ${response.checksum}).`);
  } else if (response.reason === "duplicate") {
    console.log("Manifest unchanged since last scan \u2014 nothing to store.");
  } else {
    console.log(`Server response: ${response.message ?? JSON.stringify(response)}`);
  }
  if (provisioning && response.uuid !== void 0 && response.uuid.length > 0) {
    console.log("");
    console.log("Claim this site to view vulnerability reports in your Patchstack dashboard:");
    console.log(`  ${buildClaimUrl(config.endpoint, response.uuid)}`);
  }
  return 0;
}
async function runStatus(args) {
  const config = await resolveConfig({
    cwd: process.cwd(),
    cliSiteUuid: getStringFlag(args.flags, "site-uuid"),
    cliEndpoint: getStringFlag(args.flags, "endpoint")
  });
  console.log(`Site UUID:  ${config.siteUuid ?? "(none yet \u2014 the next `scan` will provision one)"}`);
  console.log(`Endpoint:   ${config.endpoint}`);
  console.log(`Timeout:    ${config.timeoutMs}ms`);
  if (config.siteUuid !== null) {
    console.log(`Claim URL:  ${buildClaimUrl(config.endpoint, config.siteUuid)}`);
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