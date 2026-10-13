import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectHost, parseHost, renderGoLive, type Host } from '../src/go-live.js';

describe('detectHost', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'ps-go-live-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  const write = (file: string, content = ''): void => writeFileSync(path.join(cwd, file), content);

  it.each([
    ['vercel.json', 'vercel'],
    ['netlify.toml', 'netlify'],
    ['fly.toml', 'fly'],
    ['render.yaml', 'render'],
    ['railway.json', 'railway'],
    ['amplify.yml', 'amplify'],
    ['Procfile', 'heroku'],
    ['.replit', 'replit'],
  ] as const)('reads %s as %s', (file, host) => {
    write(file);
    expect(detectHost(cwd, {})).toBe(host);
  });

  it('tells Cloudflare Pages from a Worker by the build output setting', () => {
    write('wrangler.toml', 'pages_build_output_dir = "dist"');
    expect(detectHost(cwd, {})).toBe('cloudflare-pages');
    write('wrangler.toml', 'main = "src/index.ts"');
    expect(detectHost(cwd, {})).toBe('cloudflare-workers');
  });

  it('reads a .vercel folder the Vercel CLI leaves behind', () => {
    mkdirSync(path.join(cwd, '.vercel'));
    expect(detectHost(cwd, {})).toBe('vercel');
  });

  it('recognises a Lovable project from its packages', () => {
    write('package.json', JSON.stringify({ devDependencies: { 'lovable-tagger': '1.0.0' } }));
    expect(detectHost(cwd, {})).toBe('lovable');
  });

  it('falls back to the environment of a build already running on a host', () => {
    expect(detectHost(cwd, { VERCEL: '1' })).toBe('vercel');
    expect(detectHost(cwd, { FLY_APP_NAME: 'x' })).toBe('fly');
  });

  it('returns null when nothing says', () => {
    expect(detectHost(cwd, {})).toBeNull();
  });
});

describe('parseHost', () => {
  it('accepts the names people use', () => {
    expect(parseHost('Vercel')).toBe('vercel');
    expect(parseHost('cloudflare')).toBe('cloudflare-pages');
    expect(parseHost('workers')).toBe('cloudflare-workers');
    expect(parseHost('fly.io')).toBe('fly');
    expect(parseHost('aws')).toBe('amplify');
    expect(parseHost('nowhere')).toBeNull();
  });
});

describe('renderGoLive', () => {
  const hosts: Host[] = ['vercel', 'netlify', 'cloudflare-pages', 'cloudflare-workers', 'render', 'railway', 'fly', 'heroku', 'amplify', 'replit', 'lovable'];

  it('gives every host its steps, and never asks to print the key', () => {
    for (const host of hosts) {
      const text = renderGoLive(host, { useColor: false }).join('\n');
      expect(text, host).toMatch(/^Go live on /);
      expect(text, host).not.toMatch(/cat .*patchstackrc\.local\.json|echo .*apiKey/);
    }
  });

  it('adds the key, commits and deploys, in that order', () => {
    const lines = renderGoLive('vercel', { useColor: false });
    expect(lines).toEqual([
      'Go live on Vercel',
      '',
      ' 1. Add your Patchstack key to Vercel',
      '    Your live app uses it to report its packages and fetch protection rules.',
      `    node -p "require('./.patchstackrc.local.json').apiKey" | npx vercel env add PATCHSTACK_API_KEY production --sensitive`,
      '',
      ' 2. Commit your changes',
      '    Never commit .patchstackrc.local.json. It holds the key.',
      '',
      ' 3. Deploy',
      '    Push to your production branch, or run: npx vercel --prod',
    ]);
  });

  it('points a dashboard host at the value instead of printing it', () => {
    const text = renderGoLive('render', { useColor: false }).join('\n');
    expect(text).toContain('Environment, and add PATCHSTACK_API_KEY');
    expect(text).toContain('Use the apiKey value from .patchstackrc.local.json.');
  });

  it('lists the hosts to choose from when none was found', () => {
    const lines = renderGoLive(null, { useColor: false });
    expect(lines[0]).toBe('Where is your app hosted?');
    expect(lines).toContain('  npx @patchstack/connect go-live --host vercel      Vercel');
    expect(lines.some((line) => line.includes('--host cloudflare '))).toBe(true);
  });
});
