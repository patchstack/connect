import { randomUUID } from 'node:crypto';
import { open, readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

import { PatchstackError } from './types.js';

export const PROVISION_LOCK_FILENAME = '.patchstack-connect.provision.lock';

interface LockRecord {
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

export interface ProvisionLock {
  release(): Promise<void>;
}

/**
 * Serialize first-site provisioning within one checkout. Callers must resolve
 * config again after acquiring the lock because another scan may have saved the
 * UUID while this process was waiting.
 */
export async function acquireProvisionLock(
  cwd: string,
  waitMs: number,
): Promise<ProvisionLock> {
  const target = path.join(cwd, PROVISION_LOCK_FILENAME);
  const deadline = Date.now() + Math.max(0, waitMs);
  const token = randomUUID();

  while (true) {
    try {
      const handle = await open(target, 'wx', 0o600);
      const record: LockRecord = {
        token,
        pid: process.pid,
        hostname: hostname(),
        createdAt: new Date().toISOString(),
      };
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(target, { force: true }).catch(() => undefined);
        throw error;
      }

      let released = false;
      let closed = false;
      return {
        async release(): Promise<void> {
          if (released) return;
          if (!closed) {
            await handle.close();
            closed = true;
          }
          try {
            const current = JSON.parse(await readFile(target, 'utf8')) as Partial<LockRecord>;
            if (current.token === token) {
              await rm(target);
            }
            released = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              released = true;
              return;
            }
            throw new PatchstackError(
              `Could not release the local provisioning lock ${target}: ${(error as Error).message}`,
              'CONFIG_INVALID',
              error,
            );
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new PatchstackError(
          `Could not acquire the local provisioning lock: ${(error as Error).message}`,
          'CONFIG_INVALID',
          error,
        );
      }
    }

    if (Date.now() >= deadline) {
      throw new PatchstackError(
        `Another Patchstack scan is already provisioning this checkout. Wait for it to finish, then run scan again. If a previous process crashed, first confirm no scan is running and remove ${PROVISION_LOCK_FILENAME} manually.`,
        'CONFIG_INVALID',
      );
    }
    await delay(Math.min(100, Math.max(10, deadline - Date.now())));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
