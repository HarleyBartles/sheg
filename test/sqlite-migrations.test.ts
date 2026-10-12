import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { RunStoreError } from '../src/application/run-store.js';
import { openRunStore } from '../src/infrastructure/run-store.js';
import { applySchemaMigrations, baselineMigration, registeredMigrations } from '../src/infrastructure/sqlite/schema.js';

async function schema10(): Promise<string> {
  const root = await releasedSchema9();
  const database = new DatabaseSync(path.join(root, 'runs.sqlite'));
  applySchemaMigrations(database, root, registeredMigrations(), 10);
  database.close();
  return root;
}

async function releasedSchema9(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'sheg-schema-nine-fixture-'));
  const database = new DatabaseSync(path.join(root, 'runs.sqlite'));
  try {
    const migration = baselineMigration();
    for (const statement of migration.sql.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) database.exec(statement);
    database.exec('PRAGMA user_version = 9');
    const fingerprint = createHash('sha256').update(JSON.stringify(database.prepare(`SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name, tbl_name`).all())).digest('hex');
    const checksum = createHash('sha256').update(migration.sql).digest('hex');
    database.prepare('INSERT INTO schema_migrations (version, migration_id, checksum, schema_fingerprint, applied_at) VALUES (9, ?, ?, ?, ?)')
      .run(migration.id, checksum, fingerprint, '2026-10-05T00:00:00.000Z');
    return root;
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  finally { database.close(); }
}

function populateLinkedEvidence(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = ON');
  database.prepare(`INSERT INTO runs
    (run_id, submission_id, request_fingerprint, created_at, created_ms, status, request_json, evaluation_count, max_calls, used_calls)
    VALUES ('run-1', 'submission-1', 'fingerprint-1', '2026-10-05T00:00:00.000Z', 1, 'completed', '{}', 1, 1, 1)`).run();
  database.prepare(`INSERT INTO question_groups (group_id, run_id, ordinal, context_id, respondent_id, state_json, question_ids_json)
    VALUES ('group-1', 'run-1', 0, 'context-1', 'respondent-1', '{}', '["question-1"]')`).run();
  database.prepare(`INSERT INTO evaluations
    (evaluation_id, run_id, ordinal, context_id, respondent_id, question_id, group_id, packet_json, packet_fingerprint, status, result_json)
    VALUES ('evaluation-1', 'run-1', 0, 'context-1', 'respondent-1', 'question-1', 'group-1', '{}', 'packet-1', 'answered', '{"formatVersion":1,"kind":"decision-value","value":{"type":"noul","noul":0.5}}')`).run();
  database.prepare(`INSERT INTO attempts
    (attempt_id, run_id, group_id, evaluation_id, packet_fingerprint, owner_token, status, started_ms, settled_ms, charged_calls, result_json, execution_json)
    VALUES ('attempt-1', 'run-1', 'group-1', 'evaluation-1', 'packet-1', 'worker-1', 'answered', 1, 2, 1, '{}', '{}')`).run();
  database.prepare(`INSERT INTO attempt_evaluations (run_id, attempt_id, evaluation_id) VALUES ('run-1', 'attempt-1', 'evaluation-1')`).run();
  database.prepare(`INSERT INTO evaluation_answer_attempts (run_id, evaluation_id, attempt_id) VALUES ('run-1', 'evaluation-1', 'attempt-1')`).run();
}

test('a sequential upgrade keeps a verified source backup and commits its checksum ledger with the schema step', async () => {
  const root = await releasedSchema9();
  const database = new DatabaseSync(path.join(root, 'runs.sqlite'));
  populateLinkedEvidence(database);
  try {
    applySchemaMigrations(database, root, registeredMigrations(), 10);
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 10);
    const migrationRows = database.prepare('SELECT version, migration_id, length(checksum) AS checksum_length, length(schema_fingerprint) AS fingerprint_length FROM schema_migrations ORDER BY version').all() as Array<{ version: number; migration_id: string; checksum_length: number; fingerprint_length: number }>;
    assert.deepEqual(migrationRows.map(({ version, migration_id, checksum_length, fingerprint_length }) => ({ version, migration_id, checksum_length, fingerprint_length })), [
      { version: 9, migration_id: 'baseline-v9', checksum_length: 64, fingerprint_length: 64 },
      { version: 10, migration_id: 'image-assets-v10', checksum_length: 64, fingerprint_length: 64 },
    ]);
    assert.equal((database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(database.prepare(`SELECT r.run_id, qg.group_id, e.evaluation_id, a.attempt_id,
      ae.attempt_id AS membership_attempt_id, winner.attempt_id AS winner_attempt_id, e.result_json
      FROM runs r JOIN question_groups qg ON qg.run_id = r.run_id
      JOIN evaluations e ON e.run_id = r.run_id AND e.group_id = qg.group_id
      JOIN attempts a ON a.run_id = r.run_id AND a.evaluation_id = e.evaluation_id
      JOIN attempt_evaluations ae ON ae.run_id = r.run_id AND ae.attempt_id = a.attempt_id AND ae.evaluation_id = e.evaluation_id
      JOIN evaluation_answer_attempts winner ON winner.run_id = r.run_id AND winner.evaluation_id = e.evaluation_id
      WHERE r.run_id = 'run-1'`).all().map((row) => ({ ...row })), [{
      run_id: 'run-1', group_id: 'group-1', evaluation_id: 'evaluation-1', attempt_id: 'attempt-1',
      membership_attempt_id: 'attempt-1', winner_attempt_id: 'attempt-1',
      result_json: '{"formatVersion":1,"kind":"decision-value","value":{"type":"noul","noul":0.5}}',
    }]);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM image_assets').get() as { count: number }).count, 0);
    const backups = (await readdir(path.join(root, 'backups'))).filter((name) => name.endsWith('.sqlite'));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(path.join(root, 'backups', backups[0]!), { readOnly: true });
    try {
      assert.equal((backup.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 9);
      assert.equal((backup.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
      assert.equal((backup.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number }).count, 1);
      assert.equal((backup.prepare('SELECT COUNT(*) AS count FROM evaluation_answer_attempts').get() as { count: number }).count, 1);
      const preserved = backup.prepare(`SELECT r.request_json, qg.state_json, e.result_json, a.execution_json, winner.attempt_id
        FROM runs r JOIN question_groups qg ON qg.run_id = r.run_id
        JOIN evaluations e ON e.run_id = r.run_id AND e.group_id = qg.group_id
        JOIN attempts a ON a.run_id = r.run_id AND a.evaluation_id = e.evaluation_id
        JOIN evaluation_answer_attempts winner ON winner.run_id = r.run_id AND winner.evaluation_id = e.evaluation_id
        WHERE r.run_id = 'run-1'`).get() as Record<string, unknown>;
      assert.deepEqual({ ...preserved }, {
        request_json: '{}', state_json: '{}',
        result_json: '{"formatVersion":1,"kind":"decision-value","value":{"type":"noul","noul":0.5}}',
        execution_json: '{}', attempt_id: 'attempt-1',
      });
    } finally { backup.close(); }
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test('a schema 10 datastore upgrades additively through current schema and leaves its released run rows unchanged', async () => {
  const root = await releasedSchema9();
  const legacy = new DatabaseSync(path.join(root, 'runs.sqlite'));
  applySchemaMigrations(legacy, root, registeredMigrations(), 10);
  populateLinkedEvidence(legacy);
  const before = {
    run: { ...(legacy.prepare("SELECT run_id, request_json, evaluation_count, used_calls FROM runs WHERE run_id = 'run-1'").get() as Record<string, unknown>) },
    packet: { ...(legacy.prepare("SELECT packet_json, packet_fingerprint, result_json FROM evaluations WHERE evaluation_id = 'evaluation-1'").get() as Record<string, unknown>) },
  };
  legacy.close();
  const store = openRunStore(root);
  store.close();
  const database = new DatabaseSync(path.join(root, 'runs.sqlite'), { readOnly: true });
  try {
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 12);
    assert.deepEqual({
      run: { ...(database.prepare("SELECT run_id, request_json, evaluation_count, used_calls FROM runs WHERE run_id = 'run-1'").get() as Record<string, unknown>) },
      packet: { ...(database.prepare("SELECT packet_json, packet_fingerprint, result_json FROM evaluations WHERE evaluation_id = 'evaluation-1'").get() as Record<string, unknown>) },
    }, before);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM run_visual_assets').get() as { count: number }).count, 0);
    assert.deepEqual({ ...(database.prepare('SELECT revision, catalogue_json, preferences_json FROM provider_settings WHERE singleton_id = 1').get() as Record<string, unknown>) }, {
      revision: 0, catalogue_json: '{"revision":0,"entries":[]}', preferences_json: '{"preferredOrder":[]}',
    });
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test('a failed upgrade rolls back every schema change and retains the verified backup', async () => {
  const root = await releasedSchema9();
  const database = new DatabaseSync(path.join(root, 'runs.sqlite'));
  populateLinkedEvidence(database);
  try {
    const migrations = registeredMigrations();
    const imageAssetMigration = migrations[1]!;
    assert.throws(() => applySchemaMigrations(database, root, [migrations[0]!, {
      ...imageAssetMigration,
      sql: `${imageAssetMigration.sql}\n; CREATE TABLE runs (invalid TEXT);`,
    }], 10), (error: unknown) => error instanceof RunStoreError && error.code === 'migration_failed');
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 9);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'image_assets'").get(), undefined);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM runs WHERE run_id = 'run-1'").get() as { count: number }).count, 1);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number }).count, 1);
    const backups = (await readdir(path.join(root, 'backups'))).filter((name) => name.endsWith('.sqlite'));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(path.join(root, 'backups', backups[0]!), { readOnly: true });
    try { assert.equal((backup.prepare("SELECT COUNT(*) AS count FROM runs WHERE run_id = 'run-1'").get() as { count: number }).count, 1); }
    finally { backup.close(); }
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test('migration waits for a prepared launch and does not leave a preflight backup', async () => {
  const root = await schema10();
  const backupsBefore = (await readdir(path.join(root, 'backups'))).filter((name) => name.endsWith('.sqlite'));
  const database = new DatabaseSync(path.join(root, 'runs.sqlite'));
  const now = Date.now();
  try {
    database.prepare(`INSERT INTO runs (run_id, submission_id, request_fingerprint, created_at, created_ms, status, request_json, evaluation_count, max_calls)
      VALUES ('live', 'live-submit', 'fingerprint', ?, ?, 'prepared', '{}', 1, 1)`).run(new Date(now).toISOString(), now);
    const migrations = registeredMigrations().filter(({ fromVersion }) => fromVersion !== 10);
    assert.throws(() => applySchemaMigrations(database, root, [...migrations, {
      id: 'test-v10-to-v11', fromVersion: 10, toVersion: 11, sql: 'CREATE TABLE migration_probe (id TEXT);',
    }], 11, () => now), (error: unknown) => error instanceof RunStoreError && error.code === 'migration_deferred');
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 10);
    assert.deepEqual((await readdir(path.join(root, 'backups'))).filter((name) => name.endsWith('.sqlite')), backupsBefore);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test('a successor migration refuses a source whose schema differs from its recorded migration chain', async () => {
  const root = await schema10();
  const backupsBefore = (await readdir(path.join(root, 'backups'))).filter((name) => name.endsWith('.sqlite'));
  const database = new DatabaseSync(path.join(root, 'runs.sqlite'));
  try {
    database.exec('DROP INDEX runs_expired_lease');
    assert.throws(() => applySchemaMigrations(database, root, [...registeredMigrations().filter(({ fromVersion }) => fromVersion !== 10),
      { id: 'test-v10-to-v11', fromVersion: 10, toVersion: 11, sql: 'CREATE TABLE migration_probe (id TEXT);' },
    ], 11), (error: unknown) => error instanceof RunStoreError && error.code === 'datastore_schema_invalid');
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 10);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'migration_probe'").get(), undefined);
    assert.deepEqual((await readdir(path.join(root, 'backups'))).filter((name) => name.endsWith('.sqlite')), backupsBefore);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
