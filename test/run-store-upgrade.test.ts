import assert from 'node:assert/strict';
import { readFile, readdir, rm, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openRunStore, RunStoreError } from '../src/infrastructure/run-store.js';

async function fixtureRoot(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'sheg-schema-upgrade-'));
  const database = new DatabaseSync(path.join(root, 'runs.sqlite'));
  try { database.exec(await readFile(new URL(`./fixtures/datastore/${name}`, import.meta.url), 'utf8')); }
  finally { database.close(); }
  return root;
}

test('pre-release schemas require explicit recovery and remain byte-for-byte unchanged', async () => {
  for (const fixture of ['schema-v7.sql', 'schema-v8.sql']) {
    const root = await fixtureRoot(fixture);
    try {
      const databasePath = path.join(root, 'runs.sqlite');
      const before = await readFile(databasePath);
      const entriesBefore = (await readdir(root)).sort();
      assert.throws(() => openRunStore(root), (error: unknown) => error instanceof RunStoreError &&
        error.code === 'unsupported_schema_version' && /predates the v0.3.0 release baseline/.test(error.message));
      assert.deepEqual(await readFile(databasePath), before);
      assert.deepEqual((await readdir(root)).sort(), entriesBefore);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('inspection rejects a future schema without changing database bytes or sidecars', async () => {
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

test('fresh schema initialization records the recognized schema 9 migration identity and checksum', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sheg-schema-baseline-'));
  try {
    const store = openRunStore(root);
    store.close();
    const database = new DatabaseSync(path.join(root, 'runs.sqlite'), { readOnly: true });
    try {
      const row = database.prepare('SELECT version, migration_id, length(checksum) AS checksum_length FROM schema_migrations').get() as { version: number; migration_id: string; checksum_length: number };
      assert.deepEqual({ version: row.version, migration_id: row.migration_id, checksum_length: row.checksum_length }, {
        version: 9, migration_id: 'baseline-v9', checksum_length: 64,
      });
    } finally { database.close(); }
    const reopened = openRunStore(root);
    reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a current schema with an altered migration identity is refused', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sheg-schema-identity-'));
  try {
    const store = openRunStore(root);
    store.close();
    const database = new DatabaseSync(path.join(root, 'runs.sqlite'));
    database.exec("UPDATE schema_migrations SET migration_id = 'unrecognized-v9' WHERE version = 9");
    database.close();
    assert.throws(() => openRunStore(root), (error: unknown) => error instanceof RunStoreError && error.code === 'datastore_schema_invalid');
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
  await writeFile(corruptPath, corruptBytes);
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
