import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { makeStore } from '../../src/protect/rules/store.js';

const roots: string[] = [];
const temporaryDirectory = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'connect-rule-store-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('filesystem rule store', () => {
  it('updates the cache through an atomic sibling file', async () => {
    const cacheDir = temporaryDirectory();
    const store = makeStore({ cacheDir });
    const envelope = { bundle: { firewall: [], whitelists: [], whitelist_keys: {} }, etag: 'v1' };

    await store.write(envelope);

    expect(await makeStore({ cacheDir }).read()).toEqual(expect.objectContaining(envelope));
    expect(readFileSync(join(cacheDir, 'patchstack-rules.json'), 'utf8')).toBe(JSON.stringify(envelope));
  });

  it('does not read or replace a linked cache file', async () => {
    const cacheDir = temporaryDirectory();
    const outside = join(temporaryDirectory(), 'outside.json');
    writeFileSync(outside, JSON.stringify({ bundle: { firewall: [{ id: 'outside' }] } }));
    const target = join(cacheDir, 'patchstack-rules.json');
    symlinkSync(outside, target);
    const store = makeStore({ cacheDir });

    expect(await store.read()).toBeNull();
    await store.write({ bundle: { firewall: [], whitelists: [], whitelist_keys: {} }, etag: 'v2' });

    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(outside, 'utf8')).bundle.firewall[0].id).toBe('outside');
  });
});
