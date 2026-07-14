import { randomUUID } from 'node:crypto';
import { open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Replace a text file atomically from a temporary file in the same directory.
 * Existing permissions are retained, and an interrupted write cannot leave the
 * destination truncated or containing half-written JSON/markup.
 */
export async function atomicWriteTextFile(target: string, content: string): Promise<void> {
  let mode: number | undefined;
  try {
    mode = (await stat(target)).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, 'wx', mode);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
