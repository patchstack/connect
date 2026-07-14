// The fixture's "framework build": copy every static file into dist/. Just
// enough to give prebuild/postbuild something real to wrap.
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const cwd = process.cwd();
const dist = path.join(cwd, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

for (const entry of readdirSync(cwd)) {
  if (['dist', 'node_modules', 'package.json', 'package-lock.json', 'build.mjs', '.patchstackrc.json'].includes(entry)) {
    continue;
  }
  cpSync(path.join(cwd, entry), path.join(dist, entry), { recursive: true });
}

console.log('build: copied site files to dist/');
