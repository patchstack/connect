import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { PackageManager } from './guide.js';
import { runProtect, runVerify } from './protect/install/index.js';
import { collectProtectLog } from './protect/install/util.js';
import type { ProtectResult, VerifyReport } from './protect/install/types.js';
import { writeProjectFileSync } from './safe-file.js';

const SCAN_COMMAND = 'patchstack-connect scan';
const MAP_COMMAND = 'patchstack-connect map --upload';
const MARK_BUILD_COMMAND = 'patchstack-connect mark-build';

interface PackageJson {
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

/** Explicit opt-in: wrap a recognizable single dev command, not an arbitrary shell program. */
export function wireDevelopmentScript(cwd: string): { wired: boolean; changed: boolean } {
  const target = path.join(cwd, 'package.json');
  const raw = readFileSync(target, 'utf8');
  const pkg = JSON.parse(raw) as PackageJson;
  const dev = pkg.scripts?.dev;
  if (typeof dev !== 'string') return { wired: false, changed: false };
  if (dev.startsWith('patchstack-connect dev -- ')) return { wired: true, changed: false };
  // Windows package-manager shims need a shell. Preserve them rather than changing quoting or
  // enabling shell execution; a caller may pass an explicit Node entry to the wrapper instead.
  if (process.platform === 'win32' && !dev.startsWith('node ')) return { wired: false, changed: false };
  if (!/^(?:vite(?:\s|$)|next\s+dev(?:\s|$)|nuxt\s+dev(?:\s|$)|astro\s+dev(?:\s|$)|tsx\s+watch(?:\s|$)|node\s+--watch(?:\s|$)|nodemon(?:\s|$))/.test(dev)
    || /[^a-zA-Z0-9_./:= @,+\-]/.test(dev) || dev.includes('\n')) return { wired: false, changed: false };
  pkg.scripts!.dev = `patchstack-connect dev -- ${dev}`;
  const indent = raw.match(/^[\t ]+(?=")/m)?.[0] ?? '  ';
  writeProjectFileSync(cwd, target, `${JSON.stringify(pkg, null, indent)}${raw.endsWith('\n') ? '\n' : ''}`, { encoding: 'utf8' });
  return { wired: true, changed: true };
}

export interface WireBuildScriptsResult {
  changed: boolean;
  strategy: 'build-chain' | 'lifecycle-hooks' | 'postinstall-only';
  detail: string;
}

export interface SetupProtectionResult {
  install: ProtectResult;
  verification: VerifyReport;
  /** What the installer said while it ran, for `--verbose`. */
  log: string[];
}

/**
 * Install the runtime guard after setup has provisioned a site UUID, then inspect
 * the resulting seam. Verification is deliberately separate from the installer's
 * best-effort result: an adapter can scaffold files but still need a manual merge
 * when an existing framework seam cannot safely be overwritten.
 */
export function setupProtection(cwd: string): SetupProtectionResult {
  const { result: install, lines: log } = collectProtectLog(() => runProtect(cwd));
  const verification = runVerify(cwd);
  return { install, verification, log };
}

/** Add `command` after an existing lifecycle hook without duplicating it. */
function appendHook(existing: string | undefined, command: string): string {
  if (existing === undefined || existing.trim().length === 0) {
    return command;
  }
  if (existing.includes(command)) {
    return existing;
  }
  return `${existing} && ${command}`;
}

/** Put a cleanup command first in an `&&` lifecycle chain without duplicating it. */
function prependHook(existing: string | undefined, command: string): string {
  if (existing === undefined || existing.trim().length === 0) return command;
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^\\s*${escaped}\\s*(?:;|\\|\\|)`).test(existing)) return existing;

  // A second scan after a map upload would clear the identity the upload just stamped.
  const remaining = splitAndChain(existing)
    .filter((part) => part.trim() !== command && part.trim().length > 0);

  return [command, ...remaining].join(' && ');
}

/** Only standalone commands may be reordered; quoted text and shell groups stay intact. */
function splitAndChain(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote = '';
  const groups: {close: string; quote: string}[] = [];
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (char === '\\' && quote !== "'") { i++; continue; }
    if (quote === "'" || quote === '`') {
      if (char === quote) quote = quote === '`' ? groups.pop()!.quote : '';
      continue;
    }
    if (char === '`') { groups.push({close:'`',quote}); quote = '`'; continue; }
    if (char === '$' && (source[i + 1] === '(' || source[i + 1] === '{')) {
      groups.push({close:source[++i] === '(' ? ')' : '}',quote});
      quote = '';
      continue;
    }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '#' && (i === 0 || /\s/.test(source[i - 1]!))) {
      const newline = source.indexOf('\n', i);
      if (newline === -1) break;
      i = newline;
      continue;
    }
    if (char === '(' || char === '{') groups.push({close:char === '(' ? ')' : '}',quote:''});
    if (char === groups.at(-1)?.close) quote = groups.pop()!.quote;
    if (groups.length === 0 && char === '&' && source[i + 1] === '&') {
      parts.push(source.slice(start, i).trim());
      start = ++i + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts;
}

/** Map after source-generating prebuild commands, including when an older map step came first. */
function finishWithMap(existing: string): string {
  if (/(?:^|&&|;)\s*patchstack-connect map --upload\s*$/.test(existing)) return existing;
  return `${existing} && ${MAP_COMMAND}`;
}

/** A literal bundler step can be preceded by code generation inside the build script itself. */
function mapBeforeBundler(source: string): string | null {
  const parts = splitAndChain(source);
  const builders = parts.flatMap((part, index) => /^(?:next|vite|astro|nuxt)\s+build(?:\s|$)/.test(part.trim()) ? [index] : []);
  if (builders.length !== 1) return null;
  const index = builders[0]!;
  if (parts[index - 1]?.trim() !== MAP_COMMAND) parts.splice(index, 0, MAP_COMMAND);
  return parts.join(' && ');
}

/**
 * Wire a scan after dependency installs and around the project's build without
 * invoking a shell. Only npm is assumed to run pre/post build hooks. Other managers
 * get a direct build chain, independent of their version and lifecycle settings. Existing
 * commands are preserved and the operation is idempotent.
 */
export function wireBuildScripts(
  cwd: string,
  packageManager: PackageManager,
): WireBuildScriptsResult {
  const target = path.join(cwd, 'package.json');
  const raw = readFileSync(target, 'utf8');
  const pkg = JSON.parse(raw) as PackageJson;
  const scripts = pkg.scripts ?? {};
  const build = scripts.build;
  const postinstall = appendHook(scripts.postinstall, SCAN_COMMAND);

  if (build === undefined || build.trim().length === 0) {
    if (postinstall === scripts.postinstall) {
      return {
        changed: false,
        strategy: 'postinstall-only',
        detail: 'dependency-install scan already wired; no build script to integrate.',
      };
    }
    scripts.postinstall = postinstall;
  } else if (packageManager !== 'npm') {
    let nextBuild = prependHook(build, SCAN_COMMAND);
    const ordered = mapBeforeBundler(nextBuild);
    if (ordered !== null) {
      nextBuild = ordered;
    } else if (!/^\s*patchstack-connect scan\s*&&\s*patchstack-connect map --upload(?:\s*(?:&&|;)|\s*$)/.test(nextBuild)) {
      nextBuild = nextBuild.replace(SCAN_COMMAND, `${SCAN_COMMAND} && ${MAP_COMMAND}`);
    }
    if (!nextBuild.includes(MARK_BUILD_COMMAND)) {
      nextBuild = `${nextBuild} && ${MARK_BUILD_COMMAND}`;
    }
    if (nextBuild === build && postinstall === scripts.postinstall) {
      return {
        changed: false,
        strategy: 'build-chain',
        detail: 'dependency-install scan and build chain already wired.',
      };
    }
    scripts.postinstall = postinstall;
    scripts.build = nextBuild;
  } else {
    // The scan clears a previous map identity. It has to precede any existing prebuild command because
    // that command may create and upload the new map which the bundled guard should retain.
    const prebuild = finishWithMap(prependHook(scripts.prebuild, SCAN_COMMAND));
    const postbuild = appendHook(scripts.postbuild, MARK_BUILD_COMMAND);
    // npm's prebuild runs before an inline code generator. Re-map immediately before the known
    // bundler as well; the scan prefix makes this explicit build chain a binding lifecycle.
    const nextBuild = splitAndChain(build).length > 1
      ? mapBeforeBundler(prependHook(build, SCAN_COMMAND)) ?? build : build;
    if (
      prebuild === scripts.prebuild &&
      postbuild === scripts.postbuild &&
      postinstall === scripts.postinstall
      && nextBuild === build
    ) {
      return {
        changed: false,
        strategy: 'lifecycle-hooks',
        detail: 'dependency-install, prebuild, and postbuild hooks are already wired.',
      };
    }
    scripts.postinstall = postinstall;
    scripts.build = nextBuild;
    scripts.prebuild = prebuild;
    scripts.postbuild = postbuild;
  }

  pkg.scripts = scripts;
  const indentMatch = raw.match(/^[\t ]+(?=")/m)?.[0];
  const indent = indentMatch?.includes('\t') ? '\t' : indentMatch?.length ?? 2;
  const trailingNewline = raw.endsWith('\n') ? '\n' : '';
  writeProjectFileSync(cwd, target, `${JSON.stringify(pkg, null, indent)}${trailingNewline}`, { encoding: 'utf8' });

  if (build === undefined || build.trim().length === 0) {
    return {
      changed: true,
      strategy: 'postinstall-only',
      detail: 'added a dependency-install scan; package.json has no build script.',
    };
  }

  return packageManager !== 'npm'
    ? {
        changed: true,
        strategy: 'build-chain',
        detail: 'added a dependency-install scan and chained scan/map-upload/mark-build around the build.',
      }
    : {
        changed: true,
        strategy: 'lifecycle-hooks',
        detail: 'added scans to postinstall/prebuild, map upload before bundling, and mark-build to postbuild.',
      };
}
