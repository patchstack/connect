import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assessFinding, assessFindings, collectProjectFacts, renderAssessments, type Finding, type ProjectFacts } from '../src/impact.js';

// Synthetic packages and advisories; none of these names or ids refer to a real report.
const facts = (overrides: Partial<ProjectFacts> = {}): ProjectFacts => ({
  packageManager: 'npm',
  declared: new Map([
    ['web-client', { dev: false }],
    ['framework-kit', { dev: false }],
    ['bundle-tool', { dev: true }],
  ]),
  devOnly: new Set(['glob-matcher@3.0.2']),
  broughtInBy: new Map([
    ['cookie-reader', ['framework-kit']],
    ['glob-matcher', ['bundle-tool']],
  ]),
  importedFrom: new Map([['web-client', ['src/api/client.ts', 'src/lib/fetch.ts']]]),
  hasServer: true,
  ...overrides,
});

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  name: 'web-client',
  version: '1.6.0',
  severity: 'high',
  type: 'Server Side Request Forgery (SSRF)',
  cve: 'CVE-0000-0001',
  fixedIn: '1.7.4',
  ...overrides,
});

describe('assessFinding', () => {
  it('marks a high-severity package the code uses, in a server app, as fix now with a direct install', () => {
    const result = assessFinding(finding({ exploited: true }), facts());

    expect(result.verdict).toBe('now');
    expect(result.whatItIs).toBe('Someone could make your server send requests to places it should not reach.');
    expect(result.reasons).toEqual([
      'Attackers are already using this one.',
      'Your code uses it: src/api/client.ts, src/lib/fetch.ts.',
      'It is part of your live app.',
    ]);
    expect(result.fix).toBe('npm install web-client@1.7.4');
    expect(result.fixSize).toBe('small');
  });

  it('says a dev-only package never reaches the live app, whatever its severity', () => {
    const result = assessFinding(finding({ name: 'glob-matcher', version: '3.0.2', type: 'ReDoS', fixedIn: '3.0.3' }), facts());

    expect(result.verdict).toBe('low');
    expect(result.reasons[0]).toBe('Only used while building your app, never in the live app.');
    expect(result.fix).toBe('npm update glob-matcher');
    expect(result.fallback).toBe('If glob-matcher stays below 3.0.3, update bundle-tool.');
  });

  it('names the package a deep dependency comes in with, without playing it down', () => {
    const result = assessFinding(finding({ name: 'cookie-reader', version: '0.4.0', severity: 'medium', type: 'Improper input validation', fixedIn: '0.7.0' }), facts());

    expect(result.verdict).toBe('soon');
    expect(result.reasons).toContain('Your code does not use it directly. It comes in with framework-kit.');
  });

  it('lowers a server-only attack in an app with no server, and says why', () => {
    const result = assessFinding(finding(), facts({ hasServer: false }));

    expect(result.verdict).toBe('soon');
    expect(result.reasons).toContain('This attack needs a server, and your app runs in the browser.');
  });

  it('keeps a browser attack urgent in a browser-only app', () => {
    const result = assessFinding(finding({ type: 'Cross Site Scripting (XSS)' }), facts({ hasServer: false }));

    expect(result.verdict).toBe('now');
    expect(result.reasons).toContain("It is part of your live app, in your visitors' browsers.");
  });

  it('flags a major update and says when no fix is out', () => {
    expect(assessFinding(finding({ fixedIn: '2.0.0' }), facts()).fixSize).toBe('major');

    const none = assessFinding(finding({ fixedIn: null }), facts());
    expect(none.fix).toBeNull();
    expect(none.reasons).toContain('No fixed version is out yet.');
  });

  it("uses the project's package manager and keeps a dev dependency in devDependencies", () => {
    const dev = finding({ name: 'bundle-tool', version: '5.0.0', fixedIn: '5.0.1' });
    expect(assessFinding(dev, facts({ devOnly: new Set() })).fix).toBe('npm install -D bundle-tool@5.0.1');
    expect(assessFinding(finding(), facts({ packageManager: 'pnpm' })).fix).toBe('pnpm add web-client@1.7.4');
    expect(assessFinding(finding({ name: 'cookie-reader' }), facts({ packageManager: 'yarn' })).fix).toBe('yarn up cookie-reader');
  });

  it('falls back to the title when the kind is not one it knows', () => {
    expect(assessFinding(finding({ type: null, title: 'Unusual flaw in parser' }), facts()).whatItIs).toBe('Unusual flaw in parser.');
  });
});

describe('assessFindings and renderAssessments', () => {
  it('puts the most urgent first and says how many need fixing now', () => {
    const assessed = assessFindings(
      [
        finding({ name: 'glob-matcher', version: '3.0.2', severity: 'high', type: 'ReDoS', fixedIn: '3.0.3' }),
        finding({ exploited: true }),
      ],
      facts(),
    );
    expect(assessed.map((entry) => entry.finding.name)).toEqual(['web-client', 'glob-matcher']);

    const text = renderAssessments(assessed).join('\n');
    expect(text.split('\n')[0]).toBe('⚠ 2 vulnerabilities. 1 needs fixing now.');
    expect(text).toContain('🔴 FIX NOW · web-client 1.6.0');
    expect(text).toContain('   Fix: npm install web-client@1.7.4   (small update)');
    expect(text).toContain('🟢 LOW RISK FOR YOU · glob-matcher 3.0.2');
  });

  it('says so plainly when there is nothing', () => {
    expect(renderAssessments([])).toEqual(['✔ No known vulnerabilities in your packages.']);
  });
});

describe('collectProjectFacts', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-impact-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const write = (file: string, content: string): void => {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), content);
  };

  it('reads declared, dev-only, what brings a package in, and which files import it', () => {
    write('package.json', JSON.stringify({ dependencies: { 'framework-kit': '^4.0.0', 'web-client': '^1.6.0' }, devDependencies: { 'bundle-tool': '^5.0.0' } }));
    write(
      'package-lock.json',
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/framework-kit': { version: '4.0.0', dependencies: { 'body-reader': '^1.0.0' } },
          'node_modules/body-reader': { version: '1.0.0', dependencies: { 'cookie-reader': '^0.4.0' } },
          'node_modules/cookie-reader': { version: '0.4.0' },
          'node_modules/web-client': { version: '1.6.0' },
          'node_modules/bundle-tool': { version: '5.0.0', dev: true, dependencies: { 'glob-matcher': '^3.0.0' } },
          'node_modules/glob-matcher': { version: '3.0.2', dev: true },
        },
      }),
    );
    write('src/api/client.ts', "import client from 'web-client';\n");
    write('src/lib/fetch.js', "const c = require('web-client/lib/core');\n");
    write('node_modules/framework-kit/index.js', "require('cookie-reader');\n");

    const result = collectProjectFacts(cwd, ['web-client', 'cookie-reader', 'glob-matcher'], { packageManager: 'npm', hasServer: true });

    expect(result.declared.get('bundle-tool')).toEqual({ dev: true });
    expect(result.devOnly.has('glob-matcher@3.0.2')).toBe(true);
    expect(result.devOnly.has('cookie-reader@0.4.0')).toBe(false);
    expect(result.broughtInBy.get('cookie-reader')).toEqual(['framework-kit']);
    expect(result.broughtInBy.get('glob-matcher')).toEqual(['bundle-tool']);
    expect(result.importedFrom.get('web-client')).toEqual(['src/api/client.ts', 'src/lib/fetch.js']);
    expect(result.importedFrom.has('cookie-reader')).toBe(false);
  });

  it('works without a lockfile', () => {
    write('package.json', JSON.stringify({ dependencies: { 'web-client': '^1.6.0' } }));
    const result = collectProjectFacts(cwd, ['web-client'], { packageManager: 'npm', hasServer: false });
    expect(result.devOnly.size).toBe(0);
    expect(result.declared.get('web-client')).toEqual({ dev: false });
  });
});
