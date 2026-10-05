import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RunStoreError } from '../../application/run-store.js';
import { asNumber, asText, type DatabaseRow } from './rows.js';
import { hasSequentialMigrationPath } from '../schema-migration-path.js';

export const SCHEMA_VERSION = 8;

function isTransientSqliteLock(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'errcode' in error &&
    (error.errcode === 5 || error.errcode === 6);
}

function setWriteAheadLogMode(database: DatabaseSync): void {
  const deadline = Date.now() + 5_000;
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      database.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (error) {
      if (!isTransientSqliteLock(error) || Date.now() >= deadline) throw error;
      Atomics.wait(waitCell, 0, 0, Math.min(25, deadline - Date.now()));
    }
  }
}

type SchemaMigration = { fromVersion: number; toVersion: number; id: string; apply(database: DatabaseSync): void };

const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [{
  fromVersion: 7,
  toVersion: 8,
  id: 'schema-v7-to-v8-ledger',
  apply(database) {
    database.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, migration_id TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)');
    database.prepare('INSERT INTO schema_migrations (version, migration_id, applied_at) VALUES (?, ?, ?)')
      .run(8, 'schema-v7-to-v8-ledger', new Date().toISOString());
  },
}];

export function hasMigrationPath(fromVersion: number, targetVersion = SCHEMA_VERSION): boolean {
  return hasSequentialMigrationPath(fromVersion, targetVersion, SCHEMA_MIGRATIONS);
}

const REQUIRED_SCHEMA_COLUMNS = {
  runs: ['run_id', 'submission_id', 'request_fingerprint', 'created_at', 'created_ms', 'label', 'status', 'request_json', 'evaluation_count', 'max_calls', 'used_calls', 'reserved_calls', 'cancel_requested', 'owner_token', 'owner_pid', 'lease_expires_ms', 'failure_scope', 'failure_code', 'failure_message'],
  question_groups: ['group_id', 'run_id', 'ordinal', 'context_id', 'respondent_id', 'state_json', 'question_ids_json'],
  evaluations: ['evaluation_id', 'run_id', 'ordinal', 'context_id', 'respondent_id', 'question_id', 'group_id', 'turn_id', 'node_id', 'path_id', 'occurrence', 'packet_json', 'packet_fingerprint', 'status', 'result_json', 'failure_code', 'failure_message', 'failure_detail_json'],
  journey_respondents: ['run_id', 'respondent_id', 'status', 'current_node_id', 'current_turn_id', 'current_context_id', 'revision', 'events_json', 'route_json', 'outcome'],
  attempts: ['attempt_sequence', 'attempt_id', 'run_id', 'group_id', 'evaluation_id', 'packet_fingerprint', 'owner_token', 'status', 'started_ms', 'settled_ms', 'result_json', 'execution_json', 'failure_code', 'failure_message', 'failure_scope'],
  attempt_evaluations: ['attempt_id', 'evaluation_id', 'failure_json'],
  evaluation_answer_attempts: ['evaluation_id', 'attempt_id'],
  schema_migrations: ['version', 'migration_id', 'applied_at'],
} as const;

export function validateSchemaShape(database: DatabaseSync): void {
  const rows = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as DatabaseRow[];
  const actual = new Set(rows.map((row) => asText(row.name, 'schema table name')));
  for (const [table, requiredColumns] of Object.entries(REQUIRED_SCHEMA_COLUMNS)) {
    if (!actual.has(table)) throw new RunStoreError('datastore_schema_invalid', 'The Sheg datastore is missing required schema objects. Preserve its original files and use run_storage to inspect recovery options.');
    const columns = database.prepare(`PRAGMA table_info("${table}")`).all() as DatabaseRow[];
    const columnNames = new Set(columns.map((column) => asText(column.name, `${table} column name`)));
    if (requiredColumns.some((column) => !columnNames.has(column))) throw new RunStoreError('datastore_schema_invalid', 'The Sheg datastore is missing required schema objects. Preserve its original files and use run_storage to inspect recovery options.');
  }
  const migration = database.prepare('SELECT migration_id FROM schema_migrations WHERE version = ?').get(SCHEMA_VERSION) as DatabaseRow | undefined;
  const migrationId = migration?.migration_id;
  const validMigrationIds = [`baseline-v${SCHEMA_VERSION}`, ...SCHEMA_MIGRATIONS.filter(({ toVersion }) => toVersion === SCHEMA_VERSION).map(({ id }) => id)];
  if (typeof migrationId !== 'string' || !validMigrationIds.includes(migrationId)) throw new RunStoreError('datastore_schema_invalid', 'The Sheg datastore has no recognized applied-migration record for its current schema. Preserve its original files and use run_storage to inspect recovery options.');
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
      const versionRow = backup.prepare('PRAGMA user_version').get() as DatabaseRow | undefined;
      if (asNumber(versionRow?.user_version, 'backup schema version') !== fromVersion) {
        throw new RunStoreError('migration_backup_failed', 'The datastore backup does not match the source schema version.');
      }
      checkDatabaseIntegrity(backup, checkForeignKeys);
    } finally { backup.close(); }
    return backupPath;
  } catch (error) {
    try { unlinkSync(backupPath); } catch { /* Preserve the backup error. */ }
    if (error instanceof RunStoreError) throw error;
    throw new RunStoreError('migration_backup_failed', 'Sheg could not verify a recoverable datastore backup; the source database was not migrated.', { cause: error });
  }
}

function migrate(database: DatabaseSync, dataRoot: string, startingVersion: number): void {
  let version = startingVersion;
  while (version < SCHEMA_VERSION) {
    const step = SCHEMA_MIGRATIONS.find(({ fromVersion }) => fromVersion === version);
    if (!step || step.toVersion !== step.fromVersion + 1 || step.toVersion > SCHEMA_VERSION) {
      throw new RunStoreError('unsupported_schema_version', `The Sheg datastore schema ${version} has no supported migration path to ${SCHEMA_VERSION}. Preserve the database and use run_storage to inspect recovery options.`);
    }
    const liveVersion = asNumber((database.prepare('PRAGMA user_version').get() as DatabaseRow).user_version, 'schema version');
    if (liveVersion === step.toVersion) { version = liveVersion; continue; }
    if (liveVersion !== step.fromVersion) throw new RunStoreError('unsupported_schema_version', `The Sheg datastore changed to schema ${liveVersion} while opening; preserve it and use run_storage to inspect compatibility.`);
    try { verifiedBackup(database, dataRoot, step.fromVersion, step.toVersion); }
    catch (error) {
      const updatedVersion = asNumber((database.prepare('PRAGMA user_version').get() as DatabaseRow).user_version, 'schema version');
      if (updatedVersion === step.toVersion) { version = updatedVersion; continue; }
      throw error;
    }
    database.exec('BEGIN IMMEDIATE');
    try {
      const lockedVersion = asNumber((database.prepare('PRAGMA user_version').get() as DatabaseRow).user_version, 'schema version');
      if (lockedVersion === step.toVersion) {
        database.exec('COMMIT');
        version = lockedVersion;
        continue;
      }
      if (lockedVersion !== step.fromVersion) throw new RunStoreError('unsupported_schema_version', `The Sheg datastore changed to schema ${lockedVersion} while migrating; preserve it and use run_storage to inspect compatibility.`);
      step.apply(database);
      database.exec(`PRAGMA user_version = ${step.toVersion}`);
      checkDatabaseIntegrity(database);
      if (step.toVersion === SCHEMA_VERSION) validateSchemaShape(database);
      database.exec('COMMIT');
      version = step.toVersion;
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch { /* Preserve the migration error. */ }
      if (error instanceof RunStoreError) throw error;
      throw new RunStoreError('migration_failed', `Sheg could not migrate the datastore from schema ${step.fromVersion} to ${step.toVersion}. A verified backup was retained; use run_storage to inspect recovery options.`, { cause: error });
    }
  }
}

export function initialize(database: DatabaseSync, dataRoot: string): void {
  const versionRow = database.prepare('PRAGMA user_version').get() as DatabaseRow | undefined;
  const version = asNumber(versionRow?.user_version, 'schema version');
  const existing = database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as DatabaseRow | undefined;
  const tableCount = asNumber(existing?.count, 'table count');

  if (version === 0 && tableCount !== 0) {
    throw new RunStoreError('unsupported_schema_version', 'The datastore contains unversioned tables and cannot be opened safely. Preserve it and use run_storage to inspect recovery options.');
  }
  if (version > SCHEMA_VERSION) {
    throw new RunStoreError('unsupported_schema_version', `The Sheg database schema version ${version} is newer than this build. Preserve it and use run_storage to inspect recovery options.`);
  }
  if (version !== 0 && version < 7) {
    throw new RunStoreError('unsupported_schema_version', `The Sheg database schema version ${version} is not supported. Export or reset this pre-v1 datastore only through explicit run_storage recovery.`);
  }

  database.exec('PRAGMA foreign_keys = ON;');
  database.exec('PRAGMA synchronous = FULL;');

  if (version === SCHEMA_VERSION) {
    checkDatabaseIntegrity(database);
    validateSchemaShape(database);
    setWriteAheadLogMode(database);
    return;
  }
  if (version >= 7 && version < SCHEMA_VERSION) {
    migrate(database, dataRoot, version);
    setWriteAheadLogMode(database);
    return;
  }

  setWriteAheadLogMode(database);
  database.exec('BEGIN IMMEDIATE');
  try {
    const lockedVersion = asNumber((database.prepare('PRAGMA user_version').get() as DatabaseRow).user_version, 'schema version');
    const lockedTables = asNumber((database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as DatabaseRow).count, 'table count');
    if (lockedVersion === SCHEMA_VERSION && lockedTables > 0) {
      database.exec('COMMIT');
      checkDatabaseIntegrity(database);
      return;
    }
    if (lockedVersion !== 0 || lockedTables !== 0) throw new RunStoreError('unsupported_schema_version', 'The Sheg datastore changed while being initialized; preserve it and use run_storage to inspect compatibility.');
    database.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL UNIQUE,
      request_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_ms INTEGER NOT NULL,
      label TEXT,
      status TEXT NOT NULL CHECK (status IN ('prepared', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted')),
      request_json TEXT NOT NULL,
      evaluation_count INTEGER NOT NULL CHECK (evaluation_count > 0),
      max_calls INTEGER NOT NULL CHECK (max_calls > 0),
      used_calls INTEGER NOT NULL DEFAULT 0 CHECK (used_calls >= 0),
      reserved_calls INTEGER NOT NULL DEFAULT 0 CHECK (reserved_calls >= 0),
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
      owner_token TEXT,
      owner_pid INTEGER,
      lease_expires_ms INTEGER,
      failure_scope TEXT CHECK (failure_scope IS NULL OR failure_scope IN ('evaluation', 'run')),
      failure_code TEXT,
      failure_message TEXT,
      CHECK (used_calls + reserved_calls <= max_calls)
    );
    CREATE TABLE evaluations (
      evaluation_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      context_id TEXT NOT NULL,
      respondent_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      turn_id TEXT,
      node_id TEXT,
      path_id TEXT,
      occurrence INTEGER,
      packet_json TEXT NOT NULL,
      packet_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'failed', 'unreached')),
      result_json TEXT,
      failure_code TEXT,
      failure_message TEXT,
      failure_detail_json TEXT,
      UNIQUE (run_id, ordinal),
      UNIQUE (run_id, evaluation_id),
      FOREIGN KEY (run_id, group_id) REFERENCES question_groups(run_id, group_id) ON DELETE CASCADE,
      UNIQUE (run_id, turn_id),
      UNIQUE (run_id, respondent_id, node_id, occurrence),
      CHECK ((turn_id IS NULL AND node_id IS NULL AND path_id IS NULL AND occurrence IS NULL) OR
             (turn_id IS NOT NULL AND node_id IS NOT NULL AND path_id IS NOT NULL AND occurrence IS NOT NULL AND occurrence >= 1))
    );
    CREATE TABLE journey_respondents (
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      respondent_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed', 'unreached')),
      current_node_id TEXT,
      current_turn_id TEXT,
      current_context_id TEXT,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      events_json TEXT NOT NULL,
      route_json TEXT NOT NULL,
      outcome TEXT,
      PRIMARY KEY (run_id, respondent_id),
      CHECK ((status = 'active' AND current_node_id IS NOT NULL AND current_turn_id IS NOT NULL AND current_context_id IS NOT NULL) OR
             (status <> 'active' AND current_node_id IS NULL AND current_turn_id IS NULL AND current_context_id IS NULL))
    );
    CREATE TABLE attempts (
      attempt_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      group_id TEXT NOT NULL,
      evaluation_id TEXT NOT NULL,
      packet_fingerprint TEXT NOT NULL,
      owner_token TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('reserved', 'answered', 'failed', 'uncertain')),
      started_ms INTEGER NOT NULL,
      settled_ms INTEGER,
      result_json TEXT,
      execution_json TEXT,
      failure_code TEXT,
      failure_message TEXT,
      failure_scope TEXT CHECK (failure_scope IS NULL OR failure_scope IN ('evaluation', 'run')),
      FOREIGN KEY (run_id, evaluation_id) REFERENCES evaluations(run_id, evaluation_id) ON DELETE CASCADE,
      FOREIGN KEY (run_id, group_id) REFERENCES question_groups(run_id, group_id) ON DELETE CASCADE
    );
    CREATE TABLE question_groups (
      group_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      context_id TEXT NOT NULL,
      respondent_id TEXT NOT NULL,
      state_json TEXT NOT NULL,
      question_ids_json TEXT NOT NULL,
      UNIQUE (run_id, ordinal),
      UNIQUE (run_id, group_id)
    );
    CREATE TABLE attempt_evaluations (
      attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
      evaluation_id TEXT NOT NULL REFERENCES evaluations(evaluation_id) ON DELETE CASCADE,
      failure_json TEXT,
      PRIMARY KEY (attempt_id, evaluation_id)
    );
    CREATE TABLE evaluation_answer_attempts (
      evaluation_id TEXT PRIMARY KEY REFERENCES evaluations(evaluation_id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL,
      FOREIGN KEY (attempt_id, evaluation_id) REFERENCES attempt_evaluations(attempt_id, evaluation_id) ON DELETE CASCADE
    );
    CREATE INDEX evaluations_run_ordinal ON evaluations(run_id, ordinal);
    CREATE INDEX runs_created_identity ON runs(created_ms, run_id);
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, migration_id TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations (version, migration_id, applied_at) VALUES (${SCHEMA_VERSION}, 'baseline-v${SCHEMA_VERSION}', '${new Date().toISOString()}');
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* Preserve the initialization error. */ }
    throw error;
  }
}


export function openInitializedDatabase(databasePath: string, dataRoot: string): DatabaseSync {
  const database = new DatabaseSync(databasePath, { timeout: 5_000, enableForeignKeyConstraints: true });
  try { initialize(database, dataRoot); }
  catch (error) { database.close(); throw error; }
  return database;
}
