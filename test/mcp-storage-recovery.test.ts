import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import test from 'node:test';
import { createPollingServer } from '../src/entrypoints/mcp.js';
import { openRunStore } from '../src/infrastructure/run-store.js';
import { resetRunStore } from '../src/infrastructure/sqlite/recovery.js';

const resetConfirmation = 'RESET SHEG DATASTORE';

function directRequest() {
  return { kind: 'poll' as const, respondents: [{ id: 'reader-a', intent: 'Understand', context: 'New reader', desired_outcome: 'Choose', engagement_cues: 'Examples', friction_cues: 'Hype' }], material: [{ id: 'opening', text: 'A short passage.' }], questions: [{ type: 'choice' as const, id: 'interest', instructions: 'Would you continue?', options: { continue: 'Continue', leave: 'Leave' } }], provider: { kind: 'jev' as const, route: 'openrouter' as const, model: 'typesafe/jev-1.13' }, maxCalls: 1 };
}

async function temporaryRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'sheg-mcp-recovery-'));
}

async function seedSchemaV7(root: string, options: { future?: boolean } = {}): Promise<void> {
  const sql = await readFile(new URL('./fixtures/datastore/schema-v7.sql', import.meta.url), 'utf8');
  const databasePath = path.join(root, 'runs.sqlite');
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(sql);
    if (options.future) database.exec('PRAGMA user_version = 99');
  } finally { database.close(); }
}

async function connectDefault(root: string) {
  const previousRoot = process.env.SHEG_DATA_DIR;
  process.env.SHEG_DATA_DIR = root;
  let server: ReturnType<typeof createPollingServer>;
  try { server = createPollingServer(); } finally {
    if (previousRoot === undefined) delete process.env.SHEG_DATA_DIR;
    else process.env.SHEG_DATA_DIR = previousRoot;
  }
  const client = new Client({ name: 'sheg-storage-recovery-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client, close: async () => { await client.close(); await server.close(); } };
}

test('a fresh supported datastore registers the normal tools and reports schema 9', async () => {
  const root = await temporaryRoot();
  const f = await connectDefault(root);
  try {
    const tools = await f.client.listTools();
    assert.ok(tools.tools.some(({ name }) => name === 'run_list'));
    const result = await f.client.callTool({ name: 'run_storage', arguments: { operation: 'inspect' } });
    assert.equal(result.isError ?? false, false);
    const details = result.structuredContent as { recoveryRequired: boolean; compatibility: { status: string; schemaVersion: number } };
    assert.equal(details.recoveryRequired, false);
    assert.deepEqual(details.compatibility, { status: 'current', schemaVersion: 9 });
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});

test('a future schema keeps the MCP handshake and maintenance inspection while blocking study tools until confirmed reset', async () => {
  const root = await temporaryRoot();
  await seedSchemaV7(root, { future: true });
  const original = await readFile(path.join(root, 'runs.sqlite'));
  const f = await connectDefault(root);
  const stale = await connectDefault(root);
  try {
    const inspection = await f.client.callTool({ name: 'run_storage', arguments: { operation: 'inspect' } });
    assert.equal(inspection.isError ?? false, false);
    assert.deepEqual(inspection.structuredContent, {
      recoveryRequired: true,
      compatibility: { status: 'unsupported', schemaVersion: 99 },
      issue: { code: 'unsupported_schema_version' },
      backupAvailable: false,
    });
    const calls = [
      ['run_inspect', { request: directRequest() }],
      ['run_start', { submissionId: randomUUID(), request: directRequest() }],
      ['run_list', {}],
      ['run_query', { sourceRunId: randomUUID(), criteria: { materialId: 'opening' } }],
      ['run_get', { runId: randomUUID(), view: 'status' }],
      ['run_cancel', { runId: randomUUID() }],
      ['run_resume', { runId: randomUUID() }],
      ['run_delete', { runIds: [randomUUID()] }],
      ['run_storage', { operation: 'optimize' }],
    ] as const;
    for (const [name, args] of calls) {
      const blocked = await f.client.callTool({ name, arguments: args });
      assert.equal(blocked.isError, true, `${name} must be blocked during recovery`);
      assert.equal((blocked.structuredContent as { error: { code: string } }).error.code, 'datastore_recovery_required', `${name} must report the recovery state`);
    }
    const wrongConfirmation = await f.client.callTool({ name: 'run_storage', arguments: { operation: 'reset', confirmation: 'yes' } });
    assert.equal(wrongConfirmation.isError, true);
    const reset = await f.client.callTool({ name: 'run_storage', arguments: { operation: 'reset', confirmation: resetConfirmation } });
    assert.equal(reset.isError ?? false, false, JSON.stringify(reset.structuredContent));
    assert.equal((reset.structuredContent as { reset: boolean; backupRetained: boolean; schemaVersion: number }).reset, true);
    assert.equal((reset.structuredContent as { backupRetained: boolean }).backupRetained, true);
    assert.equal((reset.structuredContent as { schemaVersion: number }).schemaVersion, 9);
    const markerDatabase = new DatabaseSync(path.join(root, 'runs.sqlite'));
    try { markerDatabase.prepare('UPDATE schema_migrations SET applied_at = ? WHERE version = 9').run('saved-after-reset'); }
    finally { markerDatabase.close(); }
    const staleReset = await stale.client.callTool({ name: 'run_storage', arguments: { operation: 'reset', confirmation: resetConfirmation } });
    assert.equal(staleReset.isError, true);
    assert.equal((staleReset.structuredContent as { error: { code: string } }).error.code, 'recovery_not_required');
    const markerCheck = new DatabaseSync(path.join(root, 'runs.sqlite'), { readOnly: true });
    try { assert.equal((markerCheck.prepare('SELECT applied_at FROM schema_migrations WHERE version = 9').get() as { applied_at: string }).applied_at, 'saved-after-reset'); } finally { markerCheck.close(); }
    const staleInspection = await stale.client.callTool({ name: 'run_storage', arguments: { operation: 'inspect' } });
    assert.equal((staleInspection.structuredContent as { recoveryRequired: boolean }).recoveryRequired, false);
    const recovered = await f.client.callTool({ name: 'run_list', arguments: {} });
    assert.equal(recovered.isError ?? false, false);
    const directories = await readdir(path.join(root, 'recovery'));
    assert.equal(directories.length, 1);
    assert.deepEqual(await readFile(path.join(root, 'recovery', directories[0]!, 'runs.sqlite')), original);
    assert.ok((await readdir(path.join(root, 'backups'))).length >= 1);
  } finally { await f.close(); await stale.close(); await rm(root, { recursive: true, force: true }); }
});

test('an unreadable datastore can be explicitly reset after its original files are quarantined', async () => {
  const root = await temporaryRoot();
  const corruptBytes = Buffer.from('Not a valid SQLite database.');
  await writeFile(path.join(root, 'runs.sqlite'), corruptBytes);
  const f = await connectDefault(root);
  try {
    const inspection = await f.client.callTool({ name: 'run_storage', arguments: { operation: 'inspect' } });
    assert.equal(inspection.isError ?? false, false);
    assert.equal((inspection.structuredContent as { recoveryRequired: boolean }).recoveryRequired, true);
    assert.equal((inspection.structuredContent as { compatibility: { status: string } }).compatibility.status, 'unreadable');
    const blocked = await f.client.callTool({ name: 'run_resume', arguments: { runId: randomUUID() } });
    assert.equal((blocked.structuredContent as { error: { code: string } }).error.code, 'datastore_recovery_required');
    const reset = await f.client.callTool({ name: 'run_storage', arguments: { operation: 'reset', confirmation: resetConfirmation } });
    assert.equal(reset.isError ?? false, false, JSON.stringify(reset.structuredContent));
    assert.deepEqual(reset.structuredContent, { reset: true, backupRetained: false, preservation: 'quarantined-original-files', schemaVersion: 9, recoveryRequired: false, compatibility: { status: 'current', schemaVersion: 9 } });
    const directories = await readdir(path.join(root, 'recovery'));
    assert.equal(directories.length, 1);
    assert.deepEqual(await readFile(path.join(root, 'recovery', directories[0]!, 'runs.sqlite')), corruptBytes);
    const recovered = await f.client.callTool({ name: 'run_list', arguments: {} });
    assert.equal(recovered.isError ?? false, false);
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});

test('failed recovery restoration reports original files retained in recovery storage', async () => {
  const root = await temporaryRoot();
  const databasePath = path.join(root, 'runs.sqlite');
  const original = Buffer.from('Not a valid SQLite database.');
  await writeFile(databasePath, original);
  const rename = (from: Parameters<typeof renameSync>[0], to: Parameters<typeof renameSync>[1]): void => {
    if (from.toString().includes(`${path.sep}recovery${path.sep}`) && to.toString() === databasePath) throw new Error('Injected restoration failure.');
    renameSync(from, to);
  };

  try {
    assert.throws(() => resetRunStore(root, () => { throw new Error('Injected fresh-store failure.'); }, { rename }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /remain in recovery storage: runs\.sqlite/);
      return true;
    });
    assert.equal(await readFile(databasePath).then(() => true, () => false), false);
    const recoveryDirectories = await readdir(path.join(root, 'recovery'));
    assert.equal(recoveryDirectories.length, 1);
    assert.deepEqual(await readFile(path.join(root, 'recovery', recoveryDirectories[0]!, 'runs.sqlite')), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a damaged current schema enters recovery and preserves a verified copy before reset', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  store.close();
  const database = new DatabaseSync(path.join(root, 'runs.sqlite'));
  try {
    database.exec('DROP TABLE journey_respondents');
  } finally { database.close(); }
  const f = await connectDefault(root);
  try {
    const inspection = await f.client.callTool({ name: 'run_storage', arguments: { operation: 'inspect' } });
    assert.equal(inspection.isError ?? false, false);
    assert.equal((inspection.structuredContent as { compatibility: { status: string }; issue: { code: string } }).compatibility.status, 'unreadable');
    assert.equal((inspection.structuredContent as { issue: { code: string } }).issue.code, 'datastore_schema_invalid');
    const reset = await f.client.callTool({ name: 'run_storage', arguments: { operation: 'reset', confirmation: resetConfirmation } });
    assert.equal(reset.isError ?? false, false);
    assert.equal((reset.structuredContent as { preservation: string }).preservation, 'verified-sqlite-backup');
    assert.equal((await f.client.callTool({ name: 'run_list', arguments: {} })).isError ?? false, false);
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});

test('a current datastore missing a declared column enters recovery before normal queries fail', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  store.close();
  const database = new DatabaseSync(path.join(root, 'runs.sqlite'));
  try {
    database.exec('ALTER TABLE runs DROP COLUMN label');
  } finally { database.close(); }
  const f = await connectDefault(root);
  try {
    const inspection = await f.client.callTool({ name: 'run_storage', arguments: { operation: 'inspect' } });
    assert.equal(inspection.isError ?? false, false);
    assert.deepEqual((inspection.structuredContent as { compatibility: { status: string; schemaVersion: number | null } }).compatibility, { status: 'unreadable', schemaVersion: null });
    assert.equal((inspection.structuredContent as { issue: { code: string } }).issue.code, 'datastore_schema_invalid');
    const blocked = await f.client.callTool({ name: 'run_list', arguments: {} });
    assert.equal(blocked.isError, true);
    assert.equal((blocked.structuredContent as { error: { code: string } }).error.code, 'datastore_recovery_required');
    const reset = await f.client.callTool({ name: 'run_storage', arguments: { operation: 'reset', confirmation: resetConfirmation } });
    assert.equal(reset.isError ?? false, false);
    assert.equal((reset.structuredContent as { preservation: string }).preservation, 'verified-sqlite-backup');
    assert.equal((await f.client.callTool({ name: 'run_list', arguments: {} })).isError ?? false, false);
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});

test('an unsupported pre-release schema remains inspectable and explicitly resettable with a verified backup', async () => {
  const root = await temporaryRoot();
  await seedSchemaV7(root);
  const f = await connectDefault(root);
  try {
    const inspection = await f.client.callTool({ name: 'run_storage', arguments: { operation: 'inspect' } });
    assert.equal(inspection.isError ?? false, false);
    const details = inspection.structuredContent as { recoveryRequired: boolean; compatibility: { status: string; schemaVersion: number }; issue: { code: string }; backupAvailable: boolean };
    assert.equal(details.recoveryRequired, true);
    assert.deepEqual(details.compatibility, { status: 'unsupported', schemaVersion: 7 });
    assert.equal(details.issue.code, 'unsupported_schema_version');
    assert.equal(details.backupAvailable, false);
    const blocked = await f.client.callTool({ name: 'run_delete', arguments: { runIds: [randomUUID()], dryRun: true } });
    assert.equal((blocked.structuredContent as { error: { code: string } }).error.code, 'datastore_recovery_required');
    const reset = await f.client.callTool({ name: 'run_storage', arguments: { operation: 'reset', confirmation: resetConfirmation } });
    assert.equal(reset.isError ?? false, false);
    assert.equal((reset.structuredContent as { backupRetained: boolean }).backupRetained, true);
    const status = await f.client.callTool({ name: 'run_storage', arguments: { operation: 'inspect' } });
    assert.equal((status.structuredContent as { recoveryRequired: boolean }).recoveryRequired, false);
    const database = new DatabaseSync(path.join(root, 'runs.sqlite'), { readOnly: true });
    try { assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 9); } finally { database.close(); }
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});
