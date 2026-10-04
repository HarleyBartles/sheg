import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import test from 'node:test';
import { seedWorkflowState } from '../../scripts/skill-testing/workflow-seeds.js';
import { openRunStore } from '../../src/infrastructure/run-store.js';

test('selected-material workflow seeds mapped Choices and serves query plus fit inspection through Sheg MCP without inference', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-selected-material-workflow-'));
  const setup = { kind: 'selected-material-follow-on' as const, version: 1 as const };
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    const seeded = await seedWorkflowState(setup, root);
    assert.match(seeded.sourceRunId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
    const store = openRunStore(root);
    try {
      const status = store.getStatus(seeded.sourceRunId);
      assert.equal(status.status, 'completed');
      assert.equal(status.usedCalls, 3);
      assert.equal(status.maxCalls, 3);
      assert.equal(store.attempts(seeded.sourceRunId).items.length, 3);
    } finally { store.close(); }

    client = new Client({ name: 'selected-material-workflow-fixture', version: '1.0.0' });
    const env = { ...process.env, SHEG_DATA_DIR: root, PLUGIN_DATA: root };
    transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/mcp.js')], cwd: process.cwd(), env });
    await client.connect(transport);

    const query = await client.callTool({ name: 'run_query', arguments: { sourceRunId: seeded.sourceRunId, criteria: { questionId: 'q-transit-claim' } } });
    assert.equal(query.isError ?? false, false, JSON.stringify(query.structuredContent));
    const evidence = query.structuredContent as { sourceComplete: boolean; items: Array<{ respondentId: string; result?: { choice: string }; selectedMaterial?: { materialId: string; text: string; sourceId: string; sourceSha256: string } }> };
    assert.equal(evidence.sourceComplete, true);
    assert.deepEqual(evidence.items.map(({ respondentId, result, selectedMaterial }) => [respondentId, result?.choice, selectedMaterial?.materialId]), [
      ['reader-renter', 'p2', 'p2'], ['reader-parent', 'p5', 'p5'], ['reader-resident', 'no-fit', undefined],
    ]);
    assert.equal(evidence.items[0]?.selectedMaterial?.text, 'Passage two makes the transit claim with a concrete trip.');
    assert.equal(evidence.items[0]?.selectedMaterial?.sourceId, 'article-paragraph-2');
    assert.match(evidence.items[0]?.selectedMaterial?.sourceSha256 ?? '', /^[a-f0-9]{64}$/);

    const tokenizerPath = path.resolve('test/fixtures/laya-tokenizer.json');
    const tokenizerSha256 = createHash('sha256').update(await readFile(tokenizerPath)).digest('hex');
    const inspected = await client.callTool({ name: 'run_inspect', arguments: { request: {
      kind: 'follow-on', sourceRunId: seeded.sourceRunId, selection: { criteria: { questionId: 'q-transit-claim' } },
      context: { mode: 'fresh-material', includeSelectedMaterial: true },
      material: [{ id: 'shared-claim', text: 'A reliable bus makes every part of a city closer.', sourceId: 'transit-claim', sourceSha256: 'a'.repeat(64) }],
      questions: [{ type: 'noul', id: 'claim-fit', instructions: 'Does this passage support the claim?', criteria: { true: 'Supports the claim.', false: 'Does not support the claim.' } }],
      provider: { kind: 'laya', baseUrl: 'http://127.0.0.1:8000', checkpoint: 'workflow-fit-only', contextLimit: 4096, headLimit: 1024, tokenizerJsonPath: tokenizerPath, tokenizerSha256, timeoutMs: 5000 },
      maxCalls: 2,
    } } });
    assert.equal(inspected.isError ?? false, false, JSON.stringify(inspected.structuredContent));
    const inspection = inspected.structuredContent as { valid: boolean; selectionCoverage?: { matched: number; eligible: number; excluded: { unmappedChoice: number } } };
    assert.equal(inspection.valid, true, JSON.stringify(inspection));
    assert.deepEqual(inspection.selectionCoverage, { matched: 3, eligible: 2, excluded: { pending: 0, failed: 0, unreached: 0, nonChoice: 0, unmappedChoice: 1 } });
    const after = openRunStore(root);
    try {
      assert.equal(after.getStatus(seeded.sourceRunId).usedCalls, 3);
      assert.equal(after.list({}).items.length, 1);
    } finally { after.close(); }
  } finally {
    await client?.close();
    await transport?.close();
    await rm(root, { recursive: true, force: true });
  }
});
