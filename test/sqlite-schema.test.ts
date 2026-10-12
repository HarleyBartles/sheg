import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openRunStore } from '../src/infrastructure/run-store.js';

test('fresh stores apply the schema 9 baseline and sequential feature migrations', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sheg-schema-nine-'));
  try {
    const store = openRunStore(root);
    store.close();
    const database = new DatabaseSync(path.join(root, 'runs.sqlite'), { readOnly: true });
    try {
      assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 12);
      const runIdentity = (database.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string; notnull: number }>).find(({ name }) => name === 'run_id');
      assert.equal(runIdentity?.notnull, 1);
      const attemptColumns = new Set((database.prepare('PRAGMA table_info(attempts)').all() as Array<{ name: string }>).map(({ name }) => name));
      assert.ok(attemptColumns.has('charged_calls'));
      const migrations = database.prepare('SELECT version, migration_id, checksum, schema_fingerprint FROM schema_migrations ORDER BY version').all() as Array<{ version: number; migration_id: string; checksum: string; schema_fingerprint: string }>;
      assert.deepEqual(migrations.map(({ version, migration_id }) => ({ version, migration_id })), [
        { version: 9, migration_id: 'baseline-v9' }, { version: 10, migration_id: 'image-assets-v10' }, { version: 11, migration_id: 'run-visual-assets-v11' }, { version: 12, migration_id: 'provider-selection-v12' },
      ]);
      for (const migration of migrations) {
        assert.match(migration.checksum, /^[a-f0-9]{64}$/);
        assert.match(migration.schema_fingerprint, /^[a-f0-9]{64}$/);
      }
      const imageAssets = new Set((database.prepare('PRAGMA table_info(image_assets)').all() as Array<{ name: string }>).map(({ name }) => name));
      assert.deepEqual([...imageAssets].sort(), ['asset_id', 'byte_length', 'content', 'format', 'height', 'sha256', 'width']);
      const derivations = new Set((database.prepare('PRAGMA table_info(image_derivations)').all() as Array<{ name: string }>).map(({ name }) => name));
      assert.deepEqual([...derivations].sort(), ['algorithm', 'candidate_asset_id', 'created_at', 'height', 'policy_version', 'source_asset_id', 'width']);
      const visualAssets = new Set((database.prepare('PRAGMA table_info(run_visual_assets)').all() as Array<{ name: string }>).map(({ name }) => name));
      assert.deepEqual([...visualAssets].sort(), ['asset_id', 'material_id', 'run_id']);
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { database.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('SQLite constraints reject null identities, over-budget counters, and cross-run evidence links', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sheg-schema-constraints-'));
  const store = openRunStore(root);
  store.close();
  const database = new DatabaseSync(path.join(root, 'runs.sqlite'), { enableForeignKeyConstraints: true });
  const insertRun = database.prepare(`INSERT INTO runs (run_id, submission_id, request_fingerprint, created_at, created_ms, status, request_json, evaluation_count, max_calls, used_calls, reserved_calls)
    VALUES (?, ?, 'fingerprint', '2026-10-05T00:00:00.000Z', 1791158400000, 'prepared', '{}', 1, 2, 0, 0)`);
  try {
    assert.throws(() => database.prepare(`INSERT INTO runs (run_id, submission_id, request_fingerprint, created_at, created_ms, status, request_json, evaluation_count, max_calls)
      VALUES (NULL, 'null-id', 'fingerprint', '2026-10-05T00:00:00.000Z', 1791158400000, 'prepared', '{}', 1, 1)`).run());
    insertRun.run('run-a', 'submission-a');
    insertRun.run('run-b', 'submission-b');
    assert.throws(() => database.prepare(`UPDATE runs SET used_calls = 2, reserved_calls = 1 WHERE run_id = 'run-a'`).run());
    database.prepare(`INSERT INTO question_groups (group_id, run_id, ordinal, context_id, respondent_id, state_json, question_ids_json)
      VALUES ('group-a', 'run-a', 0, 'context-a', 'respondent-a', '{}', '[]')`).run();
    database.prepare(`INSERT INTO question_groups (group_id, run_id, ordinal, context_id, respondent_id, state_json, question_ids_json)
      VALUES ('group-b', 'run-b', 0, 'context-b', 'respondent-b', '{}', '[]')`).run();
    assert.throws(() => database.prepare(`INSERT INTO evaluations (evaluation_id, run_id, ordinal, context_id, respondent_id, question_id, group_id, packet_json, packet_fingerprint, status)
      VALUES ('evaluation-cross-run', 'run-b', 0, 'context-a', 'respondent-a', 'question-a', 'group-a', '{}', 'fingerprint', 'pending')`).run());
    database.prepare(`INSERT INTO evaluations (evaluation_id, run_id, ordinal, context_id, respondent_id, question_id, group_id, packet_json, packet_fingerprint, status)
      VALUES ('evaluation-a', 'run-a', 0, 'context-a', 'respondent-a', 'question-a', 'group-a', '{}', 'fingerprint', 'pending')`).run();
    database.prepare(`INSERT INTO evaluations (evaluation_id, run_id, ordinal, context_id, respondent_id, question_id, group_id, packet_json, packet_fingerprint, status)
      VALUES ('evaluation-b', 'run-b', 0, 'context-b', 'respondent-b', 'question-b', 'group-b', '{}', 'fingerprint', 'pending')`).run();
    database.prepare(`INSERT INTO attempts (attempt_id, run_id, group_id, evaluation_id, packet_fingerprint, owner_token, status, started_ms)
      VALUES ('attempt-a', 'run-a', 'group-a', 'evaluation-a', 'fingerprint', 'owner-a', 'reserved', 1791158400000)`).run();
    database.prepare(`INSERT INTO attempt_evaluations (run_id, attempt_id, evaluation_id) VALUES ('run-a', 'attempt-a', 'evaluation-a')`).run();
    assert.throws(() => database.prepare(`INSERT INTO attempt_evaluations (run_id, attempt_id, evaluation_id) VALUES ('run-a', 'attempt-a', 'evaluation-b')`).run());
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
