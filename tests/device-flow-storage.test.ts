import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clearPending, readPending, savePending, type PendingDeviceFlow } from '../src/device-flow.js';

const created: string[] = [];
const siteUuid = `storage-${process.pid}-${Date.now()}`;
const pending: PendingDeviceFlow = {
  deviceCode: 'device-secret',
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://example.test/device',
  expiresAt: Date.now() + 60_000,
  intervalMs: 1000,
};

function pendingPath(intent: 'login' | 'claim') {
  const key = createHash('sha256').update(siteUuid).digest('hex').slice(0, 16);
  return path.join(tmpdir(), `patchstack-${intent}-${key}.json`);
}

afterEach(() => {
  clearPending(siteUuid, 'login');
  clearPending(siteUuid, 'claim');
  for (const target of created.splice(0)) rmSync(target, { force: true });
});

describe('pending device-flow storage', () => {
  it('replaces rather than follows a pre-existing symlink when saving', () => {
    if (process.platform === 'win32') return;
    const outside = path.join(tmpdir(), `patchstack-outside-${process.pid}-${Date.now()}.json`);
    created.push(outside);
    writeFileSync(outside, 'untouched');
    symlinkSync(outside, pendingPath('login'));

    savePending(siteUuid, 'login', pending);

    expect(readFileSync(outside, 'utf8')).toBe('untouched');
    expect(readPending(siteUuid, 'login')).toEqual(pending);
  });

  it('does not read pending state through a symlink', () => {
    if (process.platform === 'win32') return;
    const outside = path.join(tmpdir(), `patchstack-outside-${process.pid}-${Date.now()}.json`);
    created.push(outside);
    writeFileSync(outside, JSON.stringify(pending), { mode: 0o600 });
    symlinkSync(outside, pendingPath('claim'));

    expect(readPending(siteUuid, 'claim')).toBeNull();
  });
});
