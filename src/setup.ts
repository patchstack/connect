import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { PackageManager } from './guide.js';
import { runProtect, runVerify } from './protect/install/index.js';
import type { ProtectResult, VerifyReport } from './protect/install/types.js';

const SCAN_COMMAND = 'patchstack-connect scan';
const MARK_BUILD_COMMAND = 'patchstack-connect mark-build';

interface PackageJson {
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

export interface WireBuildScriptsResult {
  changed: boolean;
  strategy: 'build-chain' | 'lifecycle-hooks' | 'skipped';
  detail: string;
}

export interface SetupProtectionResult {
  install: ProtectResult;
  verification: VerifyReport;
}

/**
 * Install the runtime guard after setup has provisioned a site UUID, then inspect
 * the resulting seam. Verification is deliberately separate from the installer's
 * best-effort result: an adapter can scaffold files but still need a manual merge
 * when an existing framework seam cannot safely be overwritten.
 */
export function setupProtection(cwd: string): SetupProtectionResult {
  const install = runProtect(cwd);
  const verification = runVerify(cwd);
  return { install, verification };
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

/**
 * Wire scans around the project's build without invoking a shell or running the
 * build. Bun skips npm-style pre/post hooks, so Bun projects get a direct build
 * chain; other package managers get lifecycle hooks. Existing commands are
 * preserved and the operation is idempotent.
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

  if (build === undefined || build.trim().length === 0) {
    return {
      changed: false,
      strategy: 'skipped',
      detail: 'package.json has no build script; no build integration was added.',
    };
  }

  if (packageManager === 'bun') {
    let nextBuild = build;
    if (!nextBuild.includes(SCAN_COMMAND)) {
      nextBuild = `${SCAN_COMMAND} && ${nextBuild}`;
    }
    if (!nextBuild.includes(MARK_BUILD_COMMAND)) {
      nextBuild = `${nextBuild} && ${MARK_BUILD_COMMAND}`;
    }
    if (nextBuild === build) {
      return {
        changed: false,
        strategy: 'build-chain',
        detail: 'build script already runs scan and mark-build.',
      };
    }
    scripts.build = nextBuild;
  } else {
    const prebuild = appendHook(scripts.prebuild, SCAN_COMMAND);
    const postbuild = appendHook(scripts.postbuild, MARK_BUILD_COMMAND);
    if (prebuild === scripts.prebuild && postbuild === scripts.postbuild) {
      return {
        changed: false,
        strategy: 'lifecycle-hooks',
        detail: 'prebuild and postbuild hooks are already wired.',
      };
    }
    scripts.prebuild = prebuild;
    scripts.postbuild = postbuild;
  }

  pkg.scripts = scripts;
  const indentMatch = raw.match(/^[\t ]+(?=")/m)?.[0];
  const indent = indentMatch?.includes('\t') ? '\t' : indentMatch?.length ?? 2;
  const trailingNewline = raw.endsWith('\n') ? '\n' : '';
  writeFileSync(target, `${JSON.stringify(pkg, null, indent)}${trailingNewline}`, 'utf8');

  return packageManager === 'bun'
    ? {
        changed: true,
        strategy: 'build-chain',
        detail: 'chained scan and mark-build around the existing build command.',
      }
    : {
        changed: true,
        strategy: 'lifecycle-hooks',
        detail: 'added scan to prebuild and mark-build to postbuild.',
      };
}
