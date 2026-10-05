import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RunStoreError } from '../../application/run-store.js';
import { asNumber, type DatabaseRow } from './rows.js';
import { checkDatabaseIntegrity, hasMigrationPath, SCHEMA_VERSION, validateSchemaShape, verifiedBackup } from './schema.js';

export type StoreCompatibility =
  | { status: 'current'; schemaVersion: number }
  | { status: 'migration_available'; schemaVersion: number; targetSchemaVersion: number }
  | { status: 'unsupported'; schemaVersion: number | null; targetSchemaVersion: number }
  | { status: 'uninitialized'; schemaVersion: 0; targetSchemaVersion: number }
  | { status: 'unreadable'; schemaVersion: null; targetSchemaVersion: number };

export type RecoveryFileOperations = { rename?: typeof renameSync };

export function inspectRunStoreCompatibility(dataRoot: string): StoreCompatibility {
  if (!path.isAbsolute(dataRoot)) return { status: 'unreadable', schemaVersion: null, targetSchemaVersion: SCHEMA_VERSION };
  const databasePath = path.join(dataRoot, 'runs.sqlite');
  if (!existsSync(databasePath)) return { status: 'uninitialized', schemaVersion: 0, targetSchemaVersion: SCHEMA_VERSION };
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true, timeout: 5_000 });
    const versionRow = database.prepare('PRAGMA user_version').get() as DatabaseRow | undefined;
    const version = asNumber(versionRow?.user_version, 'schema version');
    const existing = database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as DatabaseRow | undefined;
    const tableCount = asNumber(existing?.count, 'table count');
    if (version === SCHEMA_VERSION) {
      checkDatabaseIntegrity(database);
      validateSchemaShape(database);
      return { status: 'current', schemaVersion: SCHEMA_VERSION };
    }
    if (version === 0 && tableCount === 0) return { status: 'uninitialized', schemaVersion: 0, targetSchemaVersion: SCHEMA_VERSION };
    if (version >= 7 && version < SCHEMA_VERSION && hasMigrationPath(version)) return { status: 'migration_available', schemaVersion: version, targetSchemaVersion: SCHEMA_VERSION };
    return { status: 'unsupported', schemaVersion: version, targetSchemaVersion: SCHEMA_VERSION };
  } catch {
    return { status: 'unreadable', schemaVersion: null, targetSchemaVersion: SCHEMA_VERSION };
  } finally { database?.close(); }
}

export function runStoreBackupAvailable(dataRoot: string): boolean {
  const backupRoot = path.join(dataRoot, 'backups');
  if (!existsSync(backupRoot)) return false;
  try { return readdirSync(backupRoot).some((name) => name.startsWith('runs-schema-') && name.endsWith('.sqlite')); }
  catch { return false; }
}

export function resetRunStore(dataRoot: string, openFreshStore: () => void, operations: RecoveryFileOperations = {}): { reset: true; backupRetained: true; preservation: 'verified-sqlite-backup'; schemaVersion: number } | { reset: true; backupRetained: false; preservation: 'quarantined-original-files'; schemaVersion: number } {
  if (!path.isAbsolute(dataRoot)) throw new RunStoreError('invalid_data_root', 'Sheg data directory must be an absolute path.');
  const databasePath = path.join(dataRoot, 'runs.sqlite');
  let inspectionDatabase: DatabaseSync | undefined;
  let version: number;
  try {
    inspectionDatabase = new DatabaseSync(databasePath, { readOnly: true, timeout: 5_000 });
    const versionRow = inspectionDatabase.prepare('PRAGMA user_version').get() as DatabaseRow | undefined;
    version = asNumber(versionRow?.user_version, 'schema version');
    checkDatabaseIntegrity(inspectionDatabase, false);
  } catch {
    inspectionDatabase?.close();
    return resetUnreadableRunStore(dataRoot, databasePath, openFreshStore, operations);
  }
  inspectionDatabase.close();
  const database = new DatabaseSync(databasePath, { timeout: 5_000 });
  try {
    verifiedBackup(database, dataRoot, version, version, 'before-reset', false);
  } catch (error) {
    database.close();
    if (error instanceof RunStoreError) throw error;
    throw new RunStoreError('recovery_backup_failed', 'Sheg could not verify a recoverable datastore backup; the original files were left untouched.', { cause: error });
  }
  database.close();

  const recoveryRoot = path.join(dataRoot, 'recovery', randomUUID());
  mkdirSync(recoveryRoot, { recursive: true });
  const files = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
  const moved: Array<{ original: string; archived: string }> = [];
  try {
    for (const original of files) {
      if (!existsSync(original)) continue;
      const archived = path.join(recoveryRoot, path.basename(original));
      (operations.rename ?? renameSync)(original, archived);
      moved.push({ original, archived });
    }
    openFreshStore();
    return { reset: true, backupRetained: true, preservation: 'verified-sqlite-backup', schemaVersion: SCHEMA_VERSION };
  } catch (error) {
    for (const original of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      try { unlinkSync(original); } catch { /* Preserve the reset error. */ }
    }
    const retainedRecoveryFiles = restoreMovedFiles(moved, operations.rename ?? renameSync);
    const restoration = retainedRecoveryFiles.length === 0
      ? 'Original files were restored to their active paths.'
      : `Original files not restored to active paths remain in recovery storage: ${retainedRecoveryFiles.join(', ')}.`;
    if (error instanceof RunStoreError) throw new RunStoreError(error.code, `${error.message} ${restoration}`, { cause: error });
    throw new RunStoreError('recovery_reset_failed', `Sheg could not complete the explicit datastore reset; the verified backup remains available. ${restoration}`, { cause: error });
  }
}

function resetUnreadableRunStore(dataRoot: string, databasePath: string, openFreshStore: () => void, operations: RecoveryFileOperations): { reset: true; backupRetained: false; preservation: 'quarantined-original-files'; schemaVersion: number } {
  if (!existsSync(databasePath)) throw new RunStoreError('recovery_backup_failed', 'Sheg could not find the original datastore files to preserve; no reset was performed.');
  const recoveryRoot = path.join(dataRoot, 'recovery', randomUUID());
  mkdirSync(recoveryRoot, { recursive: true });
  const files = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
  const moved: Array<{ original: string; archived: string; size: number }> = [];
  try {
    for (const original of files) {
      if (!existsSync(original)) continue;
      const size = statSync(original).size;
      const archived = path.join(recoveryRoot, path.basename(original));
      (operations.rename ?? renameSync)(original, archived);
      if (statSync(archived).size !== size) throw new Error('Quarantined datastore file size changed.');
      moved.push({ original, archived, size });
    }
    openFreshStore();
    return { reset: true, backupRetained: false, preservation: 'quarantined-original-files', schemaVersion: SCHEMA_VERSION };
  } catch (error) {
    for (const original of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      try { unlinkSync(original); } catch { /* Preserve the reset error. */ }
    }
    const retainedRecoveryFiles = restoreMovedFiles(moved, operations.rename ?? renameSync);
    const restoration = retainedRecoveryFiles.length === 0
      ? 'Original unreadable files were restored to their active paths.'
      : `Original files not restored to active paths remain in recovery storage: ${retainedRecoveryFiles.join(', ')}.`;
    throw new RunStoreError('recovery_reset_failed', `Sheg could not complete the explicit reset. ${restoration}`, { cause: error });
  }
}

function restoreMovedFiles(moved: Array<{ original: string; archived: string }>, rename: typeof renameSync): string[] {
  const retained: string[] = [];
  for (const item of moved.toReversed()) {
    try { rename(item.archived, item.original); }
    catch { retained.push(path.basename(item.archived)); }
  }
  return retained;
}

