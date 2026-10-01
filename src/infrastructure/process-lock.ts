import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

type LockRecord = { pid: number; token: string };

export class ProcessLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessLockError';
  }
}

export class ProcessLock {
  private constructor(private readonly lockPath: string, private readonly record: LockRecord) {}

  static async acquire(directory: string, name: string, renameLock: typeof rename = rename): Promise<ProcessLock> {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(name)) throw new TypeError('Lock name contains unsupported characters.');
    const lockPath = path.join(directory, `${name}.lock`);
    const record = { pid: process.pid, token: randomUUID() };
    const content = `${JSON.stringify(record)}\n`;
    await mkdir(directory, { recursive: true });

    for (let attempt = 0; attempt < 25; attempt += 1) {
      try {
        const handle = await open(lockPath, 'wx', 0o600);
        try {
          await handle.writeFile(content, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        return new ProcessLock(lockPath, record);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'EPERM') throw error;
      }

      const existing = await readLock(lockPath);
      // The exclusive create publishes the file before its contents. Never treat
      // that short, unreadable interval as stale ownership and rename a live lock.
      if (!existing) {
        await delay(Math.min(2 + attempt, 20));
        continue;
      }
      if (existing && processExists(existing.pid)) throw new ProcessLockError(`Run is already owned by process ${existing.pid}.`);
      const stalePath = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
      try {
        await renameLock(lockPath, stalePath);
        const claimed = await readLock(stalePath);
        if (claimed?.pid !== existing.pid || claimed.token !== existing.token || processExists(claimed.pid)) {
          // Another process replaced the stale record after our read. Restore the
          // claimed file only if the canonical path is still free; link is
          // exclusive, so restoration cannot overwrite a newer owner.
          try {
            await link(stalePath, lockPath);
            await rm(stalePath, { force: true });
          } catch (restoreError) {
            if ((restoreError as NodeJS.ErrnoException).code !== 'EEXIST') throw restoreError;
          }
          throw new ProcessLockError('Lock ownership changed during stale recovery.');
        }
        await rm(stalePath, { force: true });
      } catch (error) {
        if (error instanceof ProcessLockError) throw error;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
    }
    throw new ProcessLockError('Could not acquire process lock after retrying incomplete or stale ownership.');
  }

  async release(): Promise<void> {
    const current = await readLock(this.lockPath);
    if (current?.token === this.record.token) await rm(this.lockPath, { force: true });
  }
}

async function readLock(filePath: string): Promise<LockRecord | null> {
  try {
    const value = JSON.parse(await readFile(filePath, 'utf8')) as Partial<LockRecord>;
    return Number.isInteger(value.pid) && typeof value.token === 'string' ? { pid: value.pid!, token: value.token } : null;
  } catch {
    return null;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

