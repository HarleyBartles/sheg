import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

type LockRecord = { pid: number; token: string };
type LockOperations = { rename?: typeof rename; afterStaleRename?: () => Promise<void> };

export class ProcessLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessLockError';
  }
}

export class ProcessLock {
  private constructor(private readonly lockPath: string, private readonly record: LockRecord) {}

  static async acquire(directory: string, name: string, operations: LockOperations = {}): Promise<ProcessLock> {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(name)) throw new TypeError('Lock name contains unsupported characters.');
    const lockPath = path.join(directory, `${name}.lock`);
    const record = { pid: process.pid, token: randomUUID() };
    const content = `${JSON.stringify(record)}\n`;
    const temporaryPath = `${lockPath}.${process.pid}.${record.token}.tmp`;
    await mkdir(directory, { recursive: true });

    for (let attempt = 0; attempt < 25; attempt += 1) {
      try {
        const handle = await open(temporaryPath, 'wx', 0o600);
        try {
          await handle.writeFile(content, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        // A hard link publishes the complete, synced record atomically and fails
        // if another owner has already created the destination.
        try {
          await link(temporaryPath, lockPath);
        } finally {
          await rm(temporaryPath, { force: true });
        }
        const claims = await staleClaims(lockPath);
        const activeClaims: Array<{ file: string; record: LockRecord }> = [];
        for (const file of claims) {
          const claimed = await readLock(file);
          if (!claimed) continue;
          if (processExists(claimed.pid)) activeClaims.push({ file, record: claimed });
          else await rm(file, { force: true });
        }
        if (activeClaims.length > 0) {
          await removeIfOwned(lockPath, record);
          for (const claim of activeClaims) await restoreClaim(lockPath, claim.file, claim.record);
          throw new ProcessLockError(`Run is already owned by process ${activeClaims[0]!.record.pid}.`);
        }
        return new ProcessLock(lockPath, record);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'EPERM') throw error;
      }

      const existing = await readLock(lockPath);
      if (!existing) {
        await delay(Math.min(2 + attempt, 20));
        continue;
      }
      if (existing && processExists(existing.pid)) throw new ProcessLockError(`Run is already owned by process ${existing.pid}.`);
      const stalePath = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
      try {
        await (operations.rename ?? rename)(lockPath, stalePath);
        await operations.afterStaleRename?.();
        const claimed = await readLock(stalePath);
        if (claimed?.pid !== existing.pid || claimed.token !== existing.token || processExists(claimed.pid)) {
          if (claimed && processExists(claimed.pid)) await restoreClaim(lockPath, stalePath, claimed);
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
    await removeIfOwned(this.lockPath, this.record);
    for (const file of await staleClaims(this.lockPath)) {
      const current = await readLock(file);
      if (current?.token === this.record.token) await rm(file, { force: true });
    }
  }
}

async function staleClaims(lockPath: string): Promise<string[]> {
  const directory = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.`;
  try {
    const entries = await readdir(directory);
    return entries.filter((entry) => entry.startsWith(prefix) && entry.endsWith('.stale')).map((entry) => path.join(directory, entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function removeIfOwned(lockPath: string, record: LockRecord): Promise<void> {
  const current = await readLock(lockPath);
  if (current?.token === record.token) await rm(lockPath, { force: true });
}

async function restoreClaim(lockPath: string, claimPath: string, record: LockRecord): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const claimed = await readLock(claimPath);
    if (claimed?.token !== record.token || !processExists(record.pid)) return;
    try {
      await link(claimPath, lockPath);
      await rm(claimPath, { force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = await readLock(lockPath);
      if (current?.token === record.token) {
        await rm(claimPath, { force: true });
        return;
      }
      await delay(Math.min(2 + attempt, 20));
    }
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
