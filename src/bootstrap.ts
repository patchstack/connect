// What `setup` does before its own work when the project is not ready for it: give a plain HTML folder the
// small Node project Connect needs, and add `@patchstack/connect` to a project that does not have it. Both
// exist so that setup is one command — the one a person approves once — rather than a chain of them.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { PackageManager } from './guide.js';
import { writeProjectFileSync } from './safe-file.js';

/**
 * Copies the site into `dist/` for a build, leaving out what is not part of the site. The pages stay where
 * the person keeps them; the copy is what `mark-build` stamps as the live site, so the files they edit
 * never carry the production marker.
 */
export const SITE_BUILD_SCRIPT =
  `node -e "const fs=require('fs');` +
  `const skip=new Set(['node_modules','dist','package.json','package-lock.json','patchstack']);` +
  `fs.rmSync('dist',{recursive:true,force:true});fs.mkdirSync('dist');` +
  `for(const f of fs.readdirSync('.'))if(!skip.has(f)&&!f.startsWith('.'))fs.cpSync(f,'dist/'+f,{recursive:true})"`;

/** A folder with HTML pages at its root and no package.json: a site with no Node project yet. */
export function isPlainHtmlSite(cwd: string): boolean {
  if (existsSync(path.join(cwd, 'package.json'))) return false;
  try {
    return readdirSync(cwd).some((name) => name.toLowerCase().endsWith('.html'));
  } catch {
    return false;
  }
}

/** A package name npm accepts, from the folder's name. */
function packageNameFor(cwd: string): string {
  const name = path
    .basename(cwd)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return name === '' ? 'site' : name;
}

/**
 * Write the package.json a plain HTML site needs: a name and a build script that copies the site into
 * `dist/`, and nothing else. `node_modules` and `dist` are added to `.gitignore`.
 */
export function createSiteProject(cwd: string): void {
  const manifest = { name: packageNameFor(cwd), version: '1.0.0', private: true, scripts: { build: SITE_BUILD_SCRIPT } };
  // The format `npm` itself writes, so a later `npm install` does not reformat the file.
  writeProjectFileSync(cwd, path.join(cwd, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8' });

  const ignoreFile = path.join(cwd, '.gitignore');
  const existing = existsSync(ignoreFile) ? readFileSync(ignoreFile, 'utf8') : '';
  const lines = new Set(existing.split('\n').map((line) => line.trim()));
  const missing = ['node_modules', 'dist'].filter((entry) => !lines.has(entry) && !lines.has(`/${entry}`));
  if (missing.length > 0) {
    const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
    writeProjectFileSync(cwd, ignoreFile, `${existing}${separator}${missing.join('\n')}\n`, { encoding: 'utf8' });
  }
}

/** The package manager's own add command, as argv. */
export function installArgs(pm: PackageManager, spec: string): string[] {
  return pm === 'npm' ? ['install', '--save', spec] : ['add', spec];
}

/**
 * Add `@patchstack/connect` to the project with its own package manager, at the version that is running,
 * so the project gets the code the person just approved. Output goes straight to the terminal. Like any
 * install, the package manager runs the project's own install scripts.
 */
export function installSelf(cwd: string, pm: PackageManager, version: string): { ok: boolean; command: string } {
  const spec = /^\d+\.\d+\.\d+/.test(version) ? `@patchstack/connect@${version}` : '@patchstack/connect';
  const args = installArgs(pm, spec);
  const result = spawnSync(pm, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  return { ok: result.status === 0, command: [pm, ...args].join(' ') };
}
