import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';
import { sourceIdentity } from '../../src/protect/rules/store.js';

const SITE = '00000000-0000-4000-8000-000000000000';

// The runtime is plain JavaScript and its types are declared by hand, so nothing but this test keeps the
// two in step. It compares what the runtime reads and returns with what the declarations say.

const read = (path: string) => readFileSync(new URL(`../../src/protect/${path}`, import.meta.url), 'utf8');
const declarations = read('protect.d.ts');

/** The member names declared directly inside `export interface <name> { … }`. */
function declaredMembers(name: string): Set<string> {
  const start = declarations.indexOf(`export interface ${name} {`);
  expect(start, `interface ${name}`).toBeGreaterThanOrEqual(0);
  const body = declarations.slice(declarations.indexOf('{', start) + 1);
  const members = new Set<string>();
  let depth = 0;
  for (const line of body.split('\n')) {
    if (depth === 0) {
      if (line.startsWith('}')) break;
      const member = /^ {2}(?:readonly )?([A-Za-z_$][\w$]*)\??(?:\(|:)/.exec(line);
      if (member) members.add(member[1]);
    }
    for (const ch of line.replace(/\/\*.*?\*\/|\/\/.*$|"[^"]*"|'[^']*'|`[^`]*`/g, '')) {
      if (ch === '{' || ch === '(' || ch === '[') depth++;
      else if (ch === '}' || ch === ')' || ch === ']') depth--;
    }
  }
  return members;
}

/** Option names the runtime and its rule lifecycle read from the `createProtection` options object. */
function optionsRead(): Set<string> {
  const names = new Set<string>();
  for (const file of ['runtime.js', 'rules/source.js', 'rules/store.js']) {
    for (const match of read(file).matchAll(/\boptions\.([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  }
  // Credential fields are read by name through one helper.
  for (const match of read('runtime.js').matchAll(/readCredentialField\(options, '([A-Za-z_$][\w$]*)'\)/g)) names.add(match[1]);
  return names;
}

afterEach(() => vi.unstubAllGlobals());

describe('protect.d.ts', () => {
  it('declares every option the runtime reads', () => {
    const declared = declaredMembers('CreateProtectionOptions');
    expect([...optionsRead()].filter((name) => !declared.has(name)).sort()).toEqual([]);
  });

  it('declares no option the runtime ignores', () => {
    const readNames = optionsRead();
    expect([...declaredMembers('CreateProtectionOptions')].filter((name) => !readNames.has(name)).sort()).toEqual([]);
  });

  it('declares every member of the protection object, and nothing it lacks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bundle = { firewall: [], whitelists: [], whitelist_keys: {} };
    const configurations = [
      { rules: bundle, reportFirewallLog: false },
      { rules: bundle, reportFirewallLog: false, egress: true },
      // Block-log reporting on.
      { rules: bundle, apiKey: 'samplesamplesamplesamplesamplesamplesamp-7', fetchImpl: async () => new Response('{}') },
      { rules: bundle, reportFirewallLog: false, token: 'sample-token', refreshSecret: 'sample-secret', bootTimeoutMs: 50, cacheDir: false as any },
      {
        // Patchstack-delivered rules from the cache, so detection reporting is on.
        siteUuid: SITE,
        pulseAuth: 'sample-credential',
        reportManifest: false,
        bootTimeoutMs: 50,
        fetchImpl: async () => new Response('{}', { status: 503 }),
        ruleCache: {
          read: async () => ({ bundle, etag: null, source: await sourceIdentity({ siteUuid: SITE }) }),
          write: async () => {},
        },
      },
    ];
    const present = new Set<string>();
    for (const options of configurations) {
      const protection: any = await createProtection(options);
      for (let o = protection; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
        for (const key of Object.getOwnPropertyNames(o)) {
          const descriptor = Object.getOwnPropertyDescriptor(o, key)!;
          const value = descriptor.get ? descriptor.get.call(protection) : descriptor.value;
          if (value !== undefined) present.add(key);
        }
      }
      protection.uninstallEgress?.();
      await protection.stop();
    }
    const declared = declaredMembers('Protection');
    expect([...present].filter((name) => !declared.has(name)).sort()).toEqual([]);
    expect([...declared].filter((name) => !present.has(name)).sort()).toEqual([]);
  });
});
