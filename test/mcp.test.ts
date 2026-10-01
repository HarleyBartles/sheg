import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { DecisionProvider } from '../src/domain/decision/provider.js';
import type { InlineRunRequest } from '../src/domain/run/request.js';
import { createRunService } from '../src/application/run-service.js';
import { openRunStore } from '../src/infrastructure/run-store.js';
import { createPollingServer } from '../src/entrypoints/mcp.js';
import { CredentialStoreError } from '../src/infrastructure/credentials/windows.js';

function request(): InlineRunRequest {
  return { kind: 'poll', respondents: [{ id: 'reader-a', intent: 'Understand', context: 'New reader', desired_outcome: 'Choose', engagement_cues: 'Examples', friction_cues: 'Hype' }], material: [{ id: 'opening', text: 'A short passage.' }], questions: [{ type: 'choice', id: 'interest', instructions: 'Would you continue?', options: { continue: 'Continue', leave: 'Leave' } }], provider: { kind: 'jev', route: 'openrouter', model: 'typesafe/jev-1.13' }, maxCalls: 1 };
}

async function connectedFixture(assertProviderReady: () => Promise<void> = async () => undefined) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-mcp-'));
  const store = openRunStore(root);
  const provider: DecisionProvider = { measure: () => ({ provider: 'jev', status: 'fits', method: 'test', modelIdentity: 'typesafe/jev-1.13', tokenCount: 'estimated', tokens: 10, contextLimit: 1000, headroomTokens: 100, effectiveLimit: 900, details: {} }), async decide() { throw new Error('MCP admission must not infer.'); } };
  const service = createRunService(store, root, () => provider, { async launch() {} }, { assertProviderReady });
  const server = createPollingServer(service);
  const client = new Client({ name: 'sheg-mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { root, store, server, client, close: async () => { await client.close(); await server.close(); store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('MCP accepts, discovers, reads, and cancels durable direct requests with structured errors', async () => {
  const f = await connectedFixture();
  try {
    const tools = await f.client.listTools();
    assert.deepEqual(tools.tools.map(({ name }) => name).sort(), ['run_cancel', 'run_delete', 'run_get', 'run_inspect', 'run_list', 'run_resume', 'run_start']);
    const inspected = await f.client.callTool({ name: 'run_inspect', arguments: { request: request() } });
    assert.equal(inspected.isError ?? false, false);
    assert.equal((inspected.structuredContent as { valid: boolean }).valid, true);

    const submissionId = randomUUID();
    const started = await f.client.callTool({ name: 'run_start', arguments: { submissionId, request: request() } });
    const run = started.structuredContent as { runId: string; status: string };
    assert.equal(run.status, 'prepared');
    const repeated = await f.client.callTool({ name: 'run_start', arguments: { submissionId, request: request() } });
    assert.equal((repeated.structuredContent as { runId: string }).runId, run.runId);

    const listing = await f.client.callTool({ name: 'run_list', arguments: { status: 'prepared', limit: 5 } });
    assert.equal((listing.structuredContent as { items: unknown[] }).items.length, 1);
    const storedRequest = await f.client.callTool({ name: 'run_get', arguments: { runId: run.runId, view: 'request' } });
    assert.equal((storedRequest.structuredContent as { request: { material: Array<{ text: string }> } }).request.material[0]?.text, 'A short passage.');
    const answers = await f.client.callTool({ name: 'run_get', arguments: { runId: run.runId, view: 'answers', limit: 1 } });
    assert.equal((answers.structuredContent as { items: Array<{ status: string; contextId: string }> }).items[0]?.status, 'pending');
    assert.ok((answers.structuredContent as { items: Array<{ contextId: string }> }).items[0]?.contextId);
    const cancelled = await f.client.callTool({ name: 'run_cancel', arguments: { runId: run.runId } });
    assert.equal((cancelled.structuredContent as { status: string }).status, 'cancelled');

    const unknown = await f.client.callTool({ name: 'run_get', arguments: { runId: randomUUID(), view: 'status' } });
    assert.equal(unknown.isError, true);
    assert.equal((unknown.structuredContent as { error: { code: string } }).error.code, 'run_not_found');
    const extra = await f.client.callTool({ name: 'run_get', arguments: { runId: run.runId, view: 'status', cursor: 'ignored' } });
    assert.equal(extra.isError, true);
  } finally { await f.close(); }
});

test('run_delete previews active blockers and deletes only after explicit cancellation', async () => {
  const f = await connectedFixture();
  try {
    const started = await f.client.callTool({ name: 'run_start', arguments: { submissionId: randomUUID(), request: request() } });
    const runId = (started.structuredContent as { runId: string }).runId;
    const preview = await f.client.callTool({ name: 'run_delete', arguments: { runIds: [runId], dryRun: true } });
    const previewData = preview.structuredContent as { blockedByActiveWork: boolean; runs: Array<{ runId: string; status: string }> };
    assert.equal(previewData.blockedByActiveWork, true);
    assert.equal(previewData.runs[0]?.status, 'prepared');
    assert.equal(f.store.getStatus(runId).status, 'prepared');
    await f.client.callTool({ name: 'run_cancel', arguments: { runId } });
    const deleted = await f.client.callTool({ name: 'run_delete', arguments: { runIds: [runId] } });
    assert.equal(deleted.isError ?? false, false);
    assert.deepEqual((deleted.structuredContent as { deletedRunIds: string[] }).deletedRunIds, [runId]);
    const missing = await f.client.callTool({ name: 'run_get', arguments: { runId, view: 'status' } });
    assert.equal(missing.isError, true);
  } finally { await f.close(); }
});

test('MCP exposes explicit run_resume with a strict run identity input', async () => {
  const f = await connectedFixture();
  try {
    const started = await f.client.callTool({ name: 'run_start', arguments: { submissionId: randomUUID(), request: request() } });
    const runId = (started.structuredContent as { runId: string }).runId;
    const now = Date.now();
    assert.ok(f.store.claim(runId, now, 1234));
    f.store.reconcile(runId, now + 31_000);
    const resumed = await f.client.callTool({ name: 'run_resume', arguments: { runId } });
    assert.equal(resumed.isError ?? false, false);
    assert.equal((resumed.structuredContent as { runId: string }).runId, runId);
    const invalid = await f.client.callTool({ name: 'run_resume', arguments: { runId, maxCalls: 100 } });
    assert.equal(invalid.isError, true);
  } finally { await f.close(); }
});

test('MCP explains an unsupported stored credential encoding without accepting the run', async () => {
  const f = await connectedFixture(async () => { throw new CredentialStoreError('credential_malformed', 'openrouter'); });
  try {
    const result = await f.client.callTool({ name: 'run_start', arguments: { submissionId: randomUUID(), request: request() } });
    assert.equal(result.isError, true);
    const error = (result.structuredContent as { error: { code: string; message: string } }).error;
    assert.equal(error.code, 'provider_credential_malformed');
    assert.match(error.message, /OpenRouter secure credential is present but uses an unsupported encoding/i);
    assert.match(error.message, /UTF-8 or UTF-16LE/);
    assert.equal(f.store.list({}).items.length, 0);
  } finally { await f.close(); }
});
