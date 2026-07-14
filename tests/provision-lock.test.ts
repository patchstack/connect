import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PROVISION_LOCK_FILENAME,
  acquireProvisionLock,
} from '../src/provision-lock.js';

describe('acquireProvisionLock', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-provision-lock-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('serializes two provisioning attempts in one checkout', async () => {
    const first = await acquireProvisionLock(cwd, 1_000);
    let secondAcquired = false;
    const secondPromise = acquireProvisionLock(cwd, 1_000).then((lock) => {
      secondAcquired = true;
      return lock;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondAcquired).toBe(false);
    await first.release();

    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    await second.release();
    await expect(readFile(path.join(cwd, PROVISION_LOCK_FILENAME))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('requires explicit cleanup after a previous process crashes', async () => {
    const target = path.join(cwd, PROVISION_LOCK_FILENAME);
    await writeFile(
      target,
      `${JSON.stringify({
        token: 'abandoned',
        pid: 2_147_483_647,
        hostname: hostname(),
        createdAt: new Date().toISOString(),
      })}\n`,
    );

    await expect(acquireProvisionLock(cwd, 40)).rejects.toThrow(
      /confirm no scan is running and remove .patchstack-connect.provision.lock manually/,
    );
    expect(JSON.parse(await readFile(target, 'utf8'))).toMatchObject({
      token: 'abandoned',
    });
  });

  it('never age-deletes a lock owned by a live local process', async () => {
    const first = await acquireProvisionLock(cwd, 1_000);
    const target = path.join(cwd, PROVISION_LOCK_FILENAME);
    const old = new Date(Date.now() - 60 * 60_000);
    await utimes(target, old, old);

    await expect(acquireProvisionLock(cwd, 40)).rejects.toThrow(
      /already provisioning this checkout/,
    );
    expect(JSON.parse(await readFile(target, 'utf8'))).toMatchObject({ pid: process.pid });

    await first.release();
  });
});
