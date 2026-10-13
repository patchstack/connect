import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSiteProject, installArgs, isPlainHtmlSite, SITE_BUILD_SCRIPT } from '../src/bootstrap.js';

describe('bootstrap', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'ps-bootstrap-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('recognises a folder of pages with no package.json, and nothing else', () => {
    expect(isPlainHtmlSite(cwd)).toBe(false);
    writeFileSync(path.join(cwd, 'index.html'), '<html></html>');
    expect(isPlainHtmlSite(cwd)).toBe(true);
    writeFileSync(path.join(cwd, 'package.json'), '{}');
    expect(isPlainHtmlSite(cwd)).toBe(false);
  });

  it('writes a package.json named after the folder, in the format npm writes', () => {
    const site = path.join(cwd, 'My Pet Shop!');
    mkdirSync(site);
    createSiteProject(site);
    const text = readFileSync(path.join(site, 'package.json'), 'utf8');
    expect(JSON.parse(text)).toEqual({ name: 'my-pet-shop', version: '1.0.0', private: true, scripts: { build: SITE_BUILD_SCRIPT } });
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  });

  it('adds node_modules and dist to an existing .gitignore without repeating what is there', () => {
    writeFileSync(path.join(cwd, '.gitignore'), '.env\n/dist');
    createSiteProject(cwd);
    expect(readFileSync(path.join(cwd, '.gitignore'), 'utf8')).toBe('.env\n/dist\nnode_modules\n');
  });

  it('builds a copy of the site in dist/, without the project files', () => {
    for (const file of ['index.html', 'style.css', 'script.js', '.patchstackrc.json', 'package-lock.json']) writeFileSync(path.join(cwd, file), file);
    mkdirSync(path.join(cwd, 'images'));
    writeFileSync(path.join(cwd, 'images', 'logo.svg'), 'svg');
    mkdirSync(path.join(cwd, 'node_modules'));
    createSiteProject(cwd);

    const script = (JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { scripts: { build: string } }).scripts.build;
    execFileSync('/bin/sh', ['-c', script], { cwd });

    for (const kept of ['index.html', 'style.css', 'script.js', 'images/logo.svg']) expect(existsSync(path.join(cwd, 'dist', kept)), kept).toBe(true);
    for (const left of ['package.json', 'package-lock.json', '.patchstackrc.json', 'node_modules', '.gitignore']) expect(existsSync(path.join(cwd, 'dist', left)), left).toBe(false);
  });

  it('uses each package manager’s own add command', () => {
    expect(installArgs('npm', '@patchstack/connect@1.2.3')).toEqual(['install', '--save', '@patchstack/connect@1.2.3']);
    expect(installArgs('bun', '@patchstack/connect')).toEqual(['add', '@patchstack/connect']);
    expect(installArgs('pnpm', '@patchstack/connect')).toEqual(['add', '@patchstack/connect']);
  });
});
