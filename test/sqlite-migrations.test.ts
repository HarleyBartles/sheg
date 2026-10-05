import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { RunStoreError } from '../src/application/run-store.js';
import { openRunStore } from '../src/infrastructure/run-store.js';
import { applySchemaMigrations, baselineMigration } from '../src/infrastructure/sqlite/schema.js';

async function baseline(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'sheg-schema-migration-'));
  const store = openRunStore(root);
  store.close();
  return root;
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

const rebuildQuestionGroups = `CREATE TABLE question_groups_new (
  group_id TEXT NOT NULL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  context_id TEXT NOT NULL,
  respondent_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  question_ids_json TEXT NOT NULL,
  display_label TEXT NOT NULL,
  UNIQUE (run_id, ordinal),
  UNIQUE (run_id, group_id),
  CHECK (ordinal >= 0)
);
INSERT INTO question_groups_new (group_id, run_id, ordinal, context_id, respondent_id, state_json, question_ids_json, display_label)
  SELECT group_id, run_id, ordinal, context_id, respondent_id, state_json, question_ids_json, 'preserved' FROM question_groups;
DROP TABLE question_groups;
ALTER TABLE question_groups_new RENAME TO question_groups;`;

test('a sequential upgrade keeps a verified source backup and commits its checksum ledger with the schema step', async () => {
  const root = await baseline();
  const database = new DatabaseSync(path.join(root, 'runs.sqlite'));
  populateLinkedEvidence(database);
  const oldConnection = openRunStore(root);
  try {
    applySchemaMigrations(database, root, [baselineMigration(), {
      id: 'test-v9-to-v10', fromVersion: 9, toVersion: 10,
      sql: rebuildQuestionGroups,
    }], 10);
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 10);
    const migrationRows = database.prepare('SELECT version, migration_id, length(checksum) AS checksum_length, length(schema_fingerprint) AS fingerprint_length FROM schema_migrations ORDER BY version').all() as Array<{ version: number; migration_id: string; checksum_length: number; fingerprint_length: number }>;
    assert.deepEqual(migrationRows.map(({ version, migration_id, checksum_length, fingerprint_length }) => ({ version, migration_id, checksum_length, fingerprint_length })), [
      { version: 9, migration_id: 'baseline-v9', checksum_length: 64, fingerprint_length: 64 },
      { version: 10, migration_id: 'test-v9-to-v10', checksum_length: 64, fingerprint_length: 64 },
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
    assert.equal((database.prepare('SELECT display_label FROM question_groups WHERE group_id = ?').get('group-1') as { display_label: string }).display_label, 'preserved');
    assert.throws(() => oldConnection.getStatus('missing'), (error: unknown) => error instanceof RunStoreError && error.code === 'datastore_schema_changed');
    const backups = (await readdir(path.join(root, 'backups'))).filter((name) => name.endsWith('.sqlite'));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(path.join(root, 'backups', backups[0]!), { readOnly: true });
    try {
      assert.equal((backup.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 9);
      assert.equal((backup.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
      assert.equal((backup.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number }).count, 1);
      assert.equal((backup.prepare('SELECT COUNT(*) AS count FROM evaluation_answer_attempts').get() as { count: number }).count, 1);
    } finally { backup.close(); }
  } finally { oldConnection.close(); database.close(); await rm(root, { recursive: true, force: true }); }
});

test('a failed upgrade rolls back every schema change and retains the verified backup', async () => {
  const root = await baseline();
  const database = new DatabaseSync(path.join(root, 'runs.sqlite'));
  try {
    assert.throws(() => applySchemaMigrations(database, root, [baselineMigration(), {
      id: 'test-v9-to-v10', fromVersion: 9, toVersion: 10,
      sql: 'CREATE TABLE migration_probe (id TEXT PRIMARY KEY NOT NULL); CREATE TABLE runs (invalid TEXT);',
    }], 10), (error: unknown) => error instanceof RunStoreError && error.code === 'migration_failed');
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 9);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'migration_probe'").get(), undefined);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number }).count, 1);
    const backups = (await readdir(path.join(root, 'backups'))).filter((name) => name.endsWith('.sqlite'));
    assert.equal(backups.length, 1);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test('migration waits for a prepared launch and does not leave a preflight backup', async () => {
  const root = await baseline();
  const database = new DatabaseSync(path.join(root, 'runs.sqlite'));
  const now = Date.now();
  try {
    database.prepare(`INSERT INTO runs (run_id, submission_id, request_fingerprint, created_at, created_ms, status, request_json, evaluation_count, max_calls)
      VALUES ('live', 'live-submit', 'fingerprint', ?, ?, 'prepared', '{}', 1, 1)`).run(new Date(now).toISOString(), now);
    assert.throws(() => applySchemaMigrations(database, root, [baselineMigration(), {
      id: 'test-v9-to-v10', fromVersion: 9, toVersion: 10, sql: 'CREATE TABLE migration_probe (id TEXT);',
    }], 10, () => now), (error: unknown) => error instanceof RunStoreError && error.code === 'migration_deferred');
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 9);
    assert.deepEqual((await readdir(root)).filter((name) => name === 'backups'), []);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test('a successor migration refuses a source whose schema differs from its recorded migration chain', async () => {
  const root = await baseline();
  const database = new DatabaseSync(path.join(root, 'runs.sqlite'));
  try {
    database.exec('DROP INDEX runs_expired_lease');
    assert.throws(() => applySchemaMigrations(database, root, [
      baselineMigration(),
      { id: 'test-v9-to-v10', fromVersion: 9, toVersion: 10, sql: 'CREATE TABLE migration_probe (id TEXT);' },
    ], 10), (error: unknown) => error instanceof RunStoreError && error.code === 'datastore_schema_invalid');
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 9);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'migration_probe'").get(), undefined);
    assert.deepEqual((await readdir(root)).filter((name) => name === 'backups'), []);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
