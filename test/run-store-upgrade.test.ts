import assert from 'node:assert/strict';
import { readFile, readdir, rm, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openRunStore, RunStoreError } from '../src/infrastructure/run-store.js';

async function fixtureRoot(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'sheg-schema-upgrade-'));
  const baseSql = await readFile(new URL('./fixtures/datastore/schema-v7.sql', import.meta.url), 'utf8');
  const versionSql = name === 'schema-v7.sql' ? '' : await readFile(new URL(`./fixtures/datastore/${name}`, import.meta.url), 'utf8');
  const database = new DatabaseSync(path.join(root, 'runs.sqlite'));
  try { database.exec(baseSql); if (versionSql) database.exec(versionSql); } finally { database.close(); }
  return root;
}

async function rows(root: string, sql: string): Promise<Record<string, unknown>[]> {
  const database = new DatabaseSync(path.join(root, 'runs.sqlite'), { readOnly: true });
  try { return database.prepare(sql).all() as Record<string, unknown>[]; } finally { database.close(); }
}

test('schema 7 migrates to the v0.3.0 schema 8 baseline without changing run evidence or call accounting', async () => {
  const root = await fixtureRoot('schema-v7.sql');
  try {
    const before = {
      runs: await rows(root, 'SELECT * FROM runs ORDER BY run_id'),
      groups: await rows(root, 'SELECT * FROM question_groups ORDER BY group_id'),
      evaluations: await rows(root, 'SELECT * FROM evaluations ORDER BY evaluation_id'),
      journeyRespondents: await rows(root, 'SELECT * FROM journey_respondents ORDER BY run_id, respondent_id'),
      attempts: await rows(root, 'SELECT * FROM attempts ORDER BY attempt_sequence'),
      attemptEvaluations: await rows(root, 'SELECT * FROM attempt_evaluations ORDER BY attempt_id, evaluation_id'),
      answerAttempts: await rows(root, 'SELECT * FROM evaluation_answer_attempts ORDER BY evaluation_id'),
    };
    assert.equal(before.runs.length, 3);
    assert.equal(before.evaluations.length, 5);
    assert.equal(before.journeyRespondents.length, 1);
    assert.deepEqual(new Set(before.evaluations.map(({ result_json }) => JSON.parse(String(result_json)).type)), new Set(['choice', 'score', 'noul']));
    assert.ok(String(before.runs.find(({ run_id }) => run_id === 'run-follow-on')?.request_json).includes('evaluation-source'));
    const store = openRunStore(root);
    store.close();
    const database = new DatabaseSync(path.join(root, 'runs.sqlite'), { readOnly: true });
    try {
      assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 8);
      assert.deepEqual((database.prepare('SELECT version, migration_id FROM schema_migrations').all() as Array<{ version: number; migration_id: string }>).map((row) => ({ version: row.version, migration_id: row.migration_id })), [{ version: 8, migration_id: 'schema-v7-to-v8-ledger' }]);
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal((database.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
    } finally { database.close(); }
    assert.deepEqual(await rows(root, 'SELECT * FROM runs ORDER BY run_id'), before.runs);
    assert.deepEqual(await rows(root, 'SELECT * FROM question_groups ORDER BY group_id'), before.groups);
    assert.deepEqual(await rows(root, 'SELECT * FROM evaluations ORDER BY evaluation_id'), before.evaluations);
    assert.deepEqual(await rows(root, 'SELECT * FROM journey_respondents ORDER BY run_id, respondent_id'), before.journeyRespondents);
    assert.deepEqual(await rows(root, 'SELECT * FROM attempts ORDER BY attempt_sequence'), before.attempts);
    assert.deepEqual(await rows(root, 'SELECT * FROM attempt_evaluations ORDER BY attempt_id, evaluation_id'), before.attemptEvaluations);
    assert.deepEqual(await rows(root, 'SELECT * FROM evaluation_answer_attempts ORDER BY evaluation_id'), before.answerAttempts);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('inspection rejects a future schema without changing the database bytes or sidecars', async () => {
  const root = await fixtureRoot('schema-v7.sql');
  try {
    const databasePath = path.join(root, 'runs.sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA user_version = 99');
    database.close();
    const before = await readFile(databasePath);
    const entriesBefore = (await readdir(root)).sort();
    assert.throws(() => openRunStore(root), (error: unknown) => error instanceof RunStoreError && error.code === 'unsupported_schema_version');
    assert.deepEqual(await readFile(databasePath), before);
    assert.deepEqual((await readdir(root)).sort(), entriesBefore);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('schema 8 baseline fixture has an explicit migration identity', async () => {
  const root = await fixtureRoot('schema-v8.sql');
  try {
    const database = new DatabaseSync(path.join(root, 'runs.sqlite'), { readOnly: true });
    try {
      assert.deepEqual((database.prepare('SELECT version, migration_id FROM schema_migrations').all() as Array<{ version: number; migration_id: string }>).map((row) => ({ version: row.version, migration_id: row.migration_id })), [{ version: 8, migration_id: 'schema-v7-to-v8-ledger' }]);
    } finally { database.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fresh schema initialization records a recognized baseline identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sheg-schema-baseline-'));
  try {
    const store = openRunStore(root);
    store.close();
    assert.deepEqual((await rows(root, 'SELECT version, migration_id FROM schema_migrations')).map(({ version, migration_id }) => ({ version, migration_id })), [{ version: 8, migration_id: 'baseline-v8' }]);
    const reopened = openRunStore(root);
    reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a current schema with an unrecognized migration identity is refused', async () => {
  const root = await fixtureRoot('schema-v8.sql');
  try {
    const database = new DatabaseSync(path.join(root, 'runs.sqlite'));
    database.exec("UPDATE schema_migrations SET migration_id = 'unrecognized-v8' WHERE version = 8");
    database.close();
    assert.throws(() => openRunStore(root), (error: unknown) => error instanceof RunStoreError && error.code === 'datastore_schema_invalid');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failed schema step leaves the source at version 7 and retains a verified recoverable backup', async () => {
  const root = await fixtureRoot('schema-v7.sql');
  const database = new DatabaseSync(path.join(root, 'runs.sqlite'));
  database.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, migration_id TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)');
  database.close();
  try {
    assert.throws(() => openRunStore(root));
    const names = (await readdir(path.join(root, 'backups'))).filter((name) => name.startsWith('runs-schema-7-before-8-') && name.endsWith('.sqlite'));
    assert.equal(names.length, 1);
    const source = new DatabaseSync(path.join(root, 'runs.sqlite'), { readOnly: true });
    const backup = new DatabaseSync(path.join(root, 'backups', names[0]!), { readOnly: true });
    try {
      assert.equal((source.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 7);
      assert.equal((backup.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 7);
      assert.equal((backup.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
      assert.equal((backup.prepare('SELECT COUNT(*) AS count FROM attempts').get() as { count: number }).count, 5);
    } finally { source.close(); backup.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unversioned and corrupt datastores are refused without replacing their contents', async () => {
  const emptyRoot = await mkdtemp(path.join(tmpdir(), 'sheg-schema-unversioned-'));
  const corruptRoot = await mkdtemp(path.join(tmpdir(), 'sheg-schema-corrupt-'));
  const emptyPath = path.join(emptyRoot, 'runs.sqlite');
  const emptyDb = new DatabaseSync(emptyPath);
  emptyDb.exec('CREATE TABLE legacy_data (value TEXT)');
  emptyDb.close();
  const beforeUnversioned = await readFile(emptyPath);
  const corruptPath = path.join(corruptRoot, 'runs.sqlite');
  const corruptBytes = Buffer.from('This is not a SQLite database.');
  await import('node:fs/promises').then(({ writeFile }) => writeFile(corruptPath, corruptBytes));
  try {
    assert.throws(() => openRunStore(emptyRoot));
    assert.deepEqual(await readFile(emptyPath), beforeUnversioned);
    assert.throws(() => openRunStore(corruptRoot));
    assert.deepEqual(await readFile(corruptPath), corruptBytes);
  } finally {
    await rm(emptyRoot, { recursive: true, force: true });
    await rm(corruptRoot, { recursive: true, force: true });
  }
});
