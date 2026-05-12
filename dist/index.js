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
var DEFAULT_ENDPOINT = "https://app.patchstack.com/monitor/pulse/manifest";
var DEFAULT_TIMEOUT_MS = 3e4;
function buildEndpointUrl(base, siteUuid) {
  const trimmed = base.replace(/\/$/, "");
  return `${trimmed}/${encodeURIComponent(siteUuid)}`;
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

// src/index.ts
async function scanAndReport(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const config = options.config ?? await resolveConfig({ cwd });
  const manifest = await scanLockfile(cwd);
  const { payload, stats } = buildWirePayload(manifest);
  const response = await postManifest(config, payload);
  return {
    manifest,
    response,
    duplicateNames: stats.duplicateNames,
    uniqueNames: stats.uniqueNames,
    totalEntries: stats.totalEntries
  };
}
export {
  DEFAULT_ENDPOINT,
  PatchstackError,
  buildEndpointUrl,
  buildWirePayload,
  compareVersions,
  detectLockfile,
  postManifest,
  resolveConfig,
  scanAndReport,
  scanLockfile,
  writeConfigFile
};
//# sourceMappingURL=index.js.map