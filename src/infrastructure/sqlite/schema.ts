import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { RunStoreError } from '../../application/run-store.js';
import { asNumber, asText, type DatabaseRow } from './rows.js';
import { sqliteTables } from './tables.js';

export const BASELINE_SCHEMA_VERSION = 9;
export const SCHEMA_VERSION = BASELINE_SCHEMA_VERSION;
export const BASELINE_MIGRATION_ID = 'baseline-v9';
const MIGRATION_BACKUP_RETRIES = 3;
const PREPARED_LAUNCH_WINDOW_MS = 30_000;
const SQLITE_TRANSIENT_LOCK_CODES = new Set([5, 6]);
const SQLITE_WAL_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 400, 800, 1600];

export type SqliteMigration = {
  id: string;
  fromVersion: number;
  toVersion: number;
  sql: string;
};

function baselineSqlPath(): string {
  const candidates = [
    fileURLToPath(new URL('../../../migrations/0000_baseline_v9/migration.sql', import.meta.url)),
    fileURLToPath(new URL('./migrations/0000_baseline_v9/migration.sql', import.meta.url)),
  ];
  const match = candidates.find(existsSync);
  if (!match) throw new RunStoreError('datastore_schema_invalid', 'The schema 9 migration asset is missing from this Sheg installation.');
  return match;
}

export function baselineMigration(): SqliteMigration {
  return {
    id: BASELINE_MIGRATION_ID,
    fromVersion: 0,
    toVersion: BASELINE_SCHEMA_VERSION,
    sql: readFileSync(baselineSqlPath(), 'utf8'),
  };
}

export function registeredMigrations(): SqliteMigration[] {
  return [baselineMigration()];
}

function migrationChecksum(migration: SqliteMigration): string {
  return createHash('sha256').update(migration.sql).digest('hex');
}

function isTransientSqliteLock(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'errcode' in error &&
    typeof error.errcode === 'number' && SQLITE_TRANSIENT_LOCK_CODES.has(error.errcode);
}

function enableWriteAheadLogging(database: DatabaseSync): void {
  for (const delayMs of SQLITE_WAL_RETRY_DELAYS_MS) {
    try {
      database.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (error) {
      if (!isTransientSqliteLock(error)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  database.exec('PRAGMA journal_mode = WAL');
}

function runMigrationSql(database: DatabaseSync, migrationSql: string): void {
  const statements = migrationSql.split('--> statement-breakpoint').map((statement) => statement.trim()).filter(Boolean);
  if (statements.length === 0) throw new RunStoreError('datastore_schema_invalid', 'A schema migration contained no SQL statements.');
  for (const statement of statements) database.exec(statement);
}

function pragmaNumber(database: DatabaseSync, name: 'user_version' | 'data_version'): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as DatabaseRow | undefined;
  return asNumber(row?.[name], `SQLite ${name}`);
}

function applicationTableCount(database: DatabaseSync): number {
  const row = database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as DatabaseRow | undefined;
  return asNumber(row?.count, 'application table count');
}

export function validateSchemaShape(database: DatabaseSync, migrations = registeredMigrations()): void {
  const existingTables = new Set((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as DatabaseRow[])
    .map((row) => asText(row.name, 'schema table name')));
  for (const table of Object.values(sqliteTables)) {
    const definition = getTableConfig(table);
    if (!existingTables.has(definition.name)) throw new RunStoreError('datastore_schema_invalid', 'The Sheg datastore is missing required schema objects. Preserve its original files and use run_storage to inspect recovery options.');
    const actualColumns = new Map((database.prepare(`PRAGMA table_info("${definition.name}")`).all() as DatabaseRow[])
      .map((column) => [asText(column.name, `${definition.name} column name`), column]));
    const primaryKeyColumnCount = [...actualColumns.values()].filter((column) => asNumber(column.pk, `${definition.name} primary key position`) > 0).length;
    for (const expected of definition.columns) {
      const actual = actualColumns.get(expected.name);
      const implicitIntegerPrimaryKey = actual !== undefined && primaryKeyColumnCount === 1 &&
        asNumber(actual.pk, `${definition.name}.${expected.name} primary key position`) === 1 && actual.type === 'INTEGER';
      if (!actual || (expected.notNull && asNumber(actual.notnull, `${definition.name}.${expected.name} nullability`) !== 1 && !implicitIntegerPrimaryKey)) {
        throw new RunStoreError('datastore_schema_invalid', 'The Sheg datastore is missing required schema objects. Preserve its original files and use run_storage to inspect recovery options.');
      }
    }
  }
  const applied = database.prepare('SELECT version, migration_id, checksum FROM schema_migrations ORDER BY version').all() as DatabaseRow[];
  const expectedChain = [...migrations].sort((left, right) => left.toVersion - right.toVersion);
  let expectedFromVersion = 0;
  const historyMatches = expectedChain.length === applied.length && expectedChain.every((migration, index) => {
    const row = applied[index];
    const sequential = migration.fromVersion === expectedFromVersion && migration.toVersion === expectedFromVersion + (expectedFromVersion === 0 ? migration.toVersion : 1);
    expectedFromVersion = migration.toVersion;
    return sequential &&
      asNumber(row?.version, 'migration version') === migration.toVersion &&
      row?.migration_id === migration.id && row.checksum === migrationChecksum(migration);
  });
  if (!historyMatches || pragmaNumber(database, 'user_version') !== SCHEMA_VERSION || expectedChain.at(-1)?.toVersion !== SCHEMA_VERSION) {
    throw new RunStoreError('datastore_schema_invalid', 'The Sheg datastore has no recognized migration record for its current schema. Preserve its original files and use run_storage to inspect recovery options.');
  }
}

export function checkDatabaseIntegrity(database: DatabaseSync, checkForeignKeys = true): void {
  const integrity = database.prepare('PRAGMA integrity_check').all() as DatabaseRow[];
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new RunStoreError('migration_integrity_failed', 'The datastore failed its SQLite integrity check during migration. The original database was left recoverable.');
  }
  const foreignKeys = checkForeignKeys ? database.prepare('PRAGMA foreign_key_check').all() : [];
  if (foreignKeys.length > 0) {
    throw new RunStoreError('migration_integrity_failed', 'The datastore has foreign-key violations during migration. The original database was left recoverable.');
  }
}

export function verifiedBackup(database: DatabaseSync, dataRoot: string, fromVersion: number, toVersion: number, purpose = `before-${toVersion}`, checkForeignKeys = true): string {
  const backupRoot = path.join(dataRoot, 'backups');
  mkdirSync(backupRoot, { recursive: true });
  const backupPath = path.join(backupRoot, `runs-schema-${fromVersion}-${purpose}-${randomUUID()}.sqlite`);
  const escapedPath = backupPath.replaceAll("'", "''");
  try {
    database.exec(`VACUUM INTO '${escapedPath}'`);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      if (pragmaNumber(backup, 'user_version') !== fromVersion) throw new RunStoreError('migration_backup_failed', 'The datastore backup does not match the source schema version.');
      checkDatabaseIntegrity(backup, checkForeignKeys);
    } finally { backup.close(); }
    return backupPath;
  } catch (error) {
    try { unlinkSync(backupPath); } catch { /* Preserve the backup error. */ }
    if (error instanceof RunStoreError) throw error;
    throw new RunStoreError('migration_backup_failed', 'Sheg could not verify a recoverable datastore backup; the source database was not migrated.', { cause: error });
  }
}

function liveWorkExists(database: DatabaseSync, nowMs: number): boolean {
  const row = database.prepare(`SELECT 1 AS found FROM runs
    WHERE (status = 'prepared' AND COALESCE(lease_expires_ms, created_ms + ?) > ?)
       OR (status = 'running' AND lease_expires_ms > ?)
    LIMIT 1`).get(PREPARED_LAUNCH_WINDOW_MS, nowMs, nowMs) as DatabaseRow | undefined;
  return row !== undefined;
}

function applyUpgrade(database: DatabaseSync, dataRoot: string, migration: SqliteMigration, now: () => number): void {
  for (let retry = 0; retry < MIGRATION_BACKUP_RETRIES; retry += 1) {
    const observedVersion = pragmaNumber(database, 'user_version');
    if (observedVersion === migration.toVersion) return;
    if (observedVersion !== migration.fromVersion) throw new RunStoreError('unsupported_schema_version', `The Sheg datastore changed to schema ${observedVersion} while opening; preserve it and use run_storage to inspect compatibility.`);
    if (observedVersion === SCHEMA_VERSION) validateSchemaShape(database);
    if (liveWorkExists(database, now())) throw new RunStoreError('migration_deferred', 'A prepared launch or active worker lease is using the datastore. Wait for it to finish, then retry the upgrade.');
    const beforeBackupDataVersion = pragmaNumber(database, 'data_version');
    const backupPath = verifiedBackup(database, dataRoot, migration.fromVersion, migration.toVersion);
    let transactionOpen = false;
    let foreignKeysDisabled = false;
    try {
      database.exec('PRAGMA foreign_keys = OFF');
      foreignKeysDisabled = Number((database.prepare('PRAGMA foreign_keys').get() as DatabaseRow).foreign_keys) === 0;
      if (!foreignKeysDisabled) throw new RunStoreError('migration_failed', 'Sheg could not safely disable foreign keys for a schema rebuild.');
      database.exec('BEGIN IMMEDIATE');
      transactionOpen = true;
      const lockedVersion = pragmaNumber(database, 'user_version');
      if (lockedVersion === migration.toVersion) { database.exec('ROLLBACK'); transactionOpen = false; unlinkSync(backupPath); return; }
      if (lockedVersion !== migration.fromVersion) throw new RunStoreError('unsupported_schema_version', `The Sheg datastore changed to schema ${lockedVersion} while migrating; preserve it and use run_storage to inspect compatibility.`);
      if (pragmaNumber(database, 'data_version') !== beforeBackupDataVersion) {
        database.exec('ROLLBACK'); transactionOpen = false; unlinkSync(backupPath); continue;
      }
      if (liveWorkExists(database, now())) throw new RunStoreError('migration_deferred', 'A prepared launch or active worker lease is using the datastore. Wait for it to finish, then retry the upgrade.');
      runMigrationSql(database, migration.sql);
      const checksum = migrationChecksum(migration);
      database.prepare('INSERT INTO schema_migrations (version, migration_id, checksum, applied_at) VALUES (?, ?, ?, ?)')
        .run(migration.toVersion, migration.id, checksum, new Date(now()).toISOString());
      database.exec(`PRAGMA user_version = ${migration.toVersion}`);
      checkDatabaseIntegrity(database);
      if (migration.toVersion === SCHEMA_VERSION) validateSchemaShape(database);
      database.exec('COMMIT');
      transactionOpen = false;
      return;
    } catch (error) {
      if (transactionOpen) { try { database.exec('ROLLBACK'); } catch { /* Preserve the migration failure. */ } }
      if (isTransientSqliteLock(error) && retry + 1 < MIGRATION_BACKUP_RETRIES) { try { unlinkSync(backupPath); } catch { /* A recoverable backup may remain. */ } continue; }
      if (error instanceof RunStoreError) throw error;
      throw new RunStoreError('migration_failed', `Sheg could not migrate the datastore from schema ${migration.fromVersion} to ${migration.toVersion}. A verified backup was retained; use run_storage to inspect recovery options.`, { cause: error });
    } finally {
      if (foreignKeysDisabled) database.exec('PRAGMA foreign_keys = ON');
    }
  }
  throw new RunStoreError('migration_backup_stale', 'The datastore changed while Sheg prepared its migration backup. No migration was applied; retry when other writers are idle.');
}

export function applySchemaMigrations(database: DatabaseSync, dataRoot: string, migrations: readonly SqliteMigration[], targetVersion: number, now = Date.now): void {
  let currentVersion = pragmaNumber(database, 'user_version');
  while (currentVersion < targetVersion) {
    const migration = migrations.find(({ fromVersion }) => fromVersion === currentVersion);
    if (!migration || migration.toVersion !== currentVersion + 1 && currentVersion !== 0) {
      throw new RunStoreError('unsupported_schema_version', `The Sheg datastore schema ${currentVersion} has no supported sequential migration path to ${targetVersion}. Preserve it and use run_storage to inspect recovery options.`);
    }
    if (currentVersion === 0) {
      if (applicationTableCount(database) !== 0) throw new RunStoreError('unsupported_schema_version', 'The datastore contains unversioned tables and cannot be opened safely. Preserve it and use run_storage to inspect recovery options.');
      database.exec('BEGIN IMMEDIATE');
      try {
        const lockedVersion = pragmaNumber(database, 'user_version');
        const lockedTables = applicationTableCount(database);
        if (lockedVersion === SCHEMA_VERSION && lockedTables > 0) {
          database.exec('COMMIT');
          validateSchemaShape(database);
          return;
        }
        if (lockedVersion !== 0 || lockedTables !== 0) throw new RunStoreError('unsupported_schema_version', 'The datastore changed while being initialized; preserve it and use run_storage to inspect recovery options.');
        runMigrationSql(database, migration.sql);
        database.prepare('INSERT INTO schema_migrations (version, migration_id, checksum, applied_at) VALUES (?, ?, ?, ?)')
          .run(migration.toVersion, migration.id, migrationChecksum(migration), new Date(now()).toISOString());
        database.exec(`PRAGMA user_version = ${migration.toVersion}`);
        checkDatabaseIntegrity(database);
        validateSchemaShape(database);
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch { /* Preserve the initialization error. */ }
        if (error instanceof RunStoreError) throw error;
        throw new RunStoreError('migration_failed', 'Sheg could not initialize its schema; no partial schema was retained.', { cause: error });
      }
    } else {
      applyUpgrade(database, dataRoot, migration, now);
    }
    currentVersion = pragmaNumber(database, 'user_version');
  }
  if (currentVersion !== targetVersion) throw new RunStoreError('unsupported_schema_version', `The Sheg datastore schema ${currentVersion} is newer than this migration target ${targetVersion}. Preserve it and use run_storage to inspect compatibility.`);
}

export function hasMigrationPath(fromVersion: number, targetVersion = SCHEMA_VERSION): boolean {
  if (!Number.isSafeInteger(fromVersion) || !Number.isSafeInteger(targetVersion) || fromVersion < 0 || targetVersion < fromVersion) return false;
  const migrations = registeredMigrations();
  let current = fromVersion;
  while (current < targetVersion) {
    const next = migrations.find(({ fromVersion: migrationStart }) => migrationStart === current);
    if (!next) return false;
    current = next.toVersion;
  }
  return current === targetVersion;
}

export function initialize(database: DatabaseSync, dataRoot: string): void {
  const version = pragmaNumber(database, 'user_version');
  if (version > SCHEMA_VERSION) throw new RunStoreError('unsupported_schema_version', `The Sheg database schema version ${version} is newer than this build. Preserve it and use run_storage to inspect recovery options.`);
  if (version === 0 && applicationTableCount(database) !== 0) throw new RunStoreError('unsupported_schema_version', 'The datastore contains unversioned tables and cannot be opened safely. Preserve it and use run_storage to inspect recovery options.');
  if (version !== 0 && version !== SCHEMA_VERSION && !hasMigrationPath(version, SCHEMA_VERSION)) {
    throw new RunStoreError('unsupported_schema_version', `The Sheg datastore schema version ${version} predates the v0.3.0 release baseline or has no supported migration path to ${SCHEMA_VERSION}. Preserve it and use run_storage to inspect options.`);
  }
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec('PRAGMA synchronous = FULL;');
  enableWriteAheadLogging(database);
  if (version < SCHEMA_VERSION) applySchemaMigrations(database, dataRoot, registeredMigrations(), SCHEMA_VERSION);
  else {
    validateSchemaShape(database);
  }
}

export function openInitializedDatabase(databasePath: string, dataRoot: string): DatabaseSync {
  const database = new DatabaseSync(databasePath, { timeout: 5_000, enableForeignKeyConstraints: true });
  try { initialize(database, dataRoot); }
  catch (error) { database.close(); throw error; }
  return database;
}
