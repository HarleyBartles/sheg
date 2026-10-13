import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import test from 'node:test';
import type { DecisionProvider } from '../../src/domain/decision/provider.js';
import { prepareFollowOnRun } from '../../src/application/run-inspection.js';
import { followOnRunRequestSchema } from '../../src/domain/run/request.js';
import type { PromptState } from '../../src/domain/decision/prompt.js';
import { openRunStore } from '../../src/infrastructure/run-store.js';
import { seedWorkflowState } from '../../scripts/skill-testing/workflow-seeds.js';

test('visual follow-on workflow inspects typed image evidence, binds only selected pixels, and excludes sibling answers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-visual-follow-on-workflow-'));
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    const seeded = await seedWorkflowState({ kind: 'visual-follow-on-context-projection', version: 1 }, root);
    const store = openRunStore(root);
    try {
      const source = store.queryEvidence({ sourceRunId: seeded.sourceRunId, criteria: { questionId: 'character-fit' } });
      const visual = source.items[0];
      assert.ok(visual);
      assert.equal(visual.selectedMaterial, undefined);
      assert.deepEqual(visual.selectedVisualMaterial && { materialId: visual.selectedVisualMaterial.materialId, altText: visual.selectedVisualMaterial.altText, caption: visual.selectedVisualMaterial.caption }, {
        materialId: 'writ-portrait', altText: 'Approved portrait of Writ, an observant teal-clad specialist with a compact crossbody bag.', caption: 'Writ, the crew archivist.',
      });
      assert.equal(JSON.stringify(source).includes(Buffer.from(await readFile('test/fixtures/images/four-corners-transparent.png')).toString('base64')), false);

      const base = {
        kind: 'follow-on' as const, sourceRunId: seeded.sourceRunId,
        selection: { references: [{ evaluationId: visual.evaluationId, contextId: visual.contextId }] },
        context: { mode: 'continue' as const, retainedMaterialIds: [] as string[], includeSelectedAnswer: true, materialIds: ['writ-portrait'] },
        questions: [{ type: 'choice' as const, id: 'follow-up-fit', instructions: 'Does this portrait still fit the character brief?', options: { fit: 'Fits the brief', noFit: 'Does not fit' }, materialOptions: { fit: 'writ-portrait' }, visual: { mode: 'pixels' as const, materialIds: ['writ-portrait'] } }],
        provider: { kind: 'clef' as const, accountId: '0123456789abcdef0123456789abcdef', model: 'clef' as const, timeoutMs: 1000 }, maxCalls: 1,
      };
      const invalidUnbound = followOnRunRequestSchema.parse({ ...base, questions: [{ ...base.questions[0], visual: undefined }] });
      await assert.rejects(prepareFollowOnRun(invalidUnbound, store.resolveFollowOnSources(invalidUnbound), clefFitProvider), /must be bound/i);

      const incorrectlyTextMapped = followOnRunRequestSchema.parse({ ...base, context: { mode: 'continue', retainedMaterialIds: [], includeSelectedAnswer: true }, questions: [{ ...base.questions[0], visual: undefined }] });
      await assert.rejects(prepareFollowOnRun(incorrectlyTextMapped, store.resolveFollowOnSources(incorrectlyTextMapped), clefFitProvider), /must be bound/i);

      const prepared = await prepareFollowOnRun(followOnRunRequestSchema.parse(base), store.resolveFollowOnSources(followOnRunRequestSchema.parse(base)), clefFitProvider);
      assert.equal(prepared.inspection.valid, true, JSON.stringify(prepared.inspection));
      const packet = prepared.prepared.evaluations[0]?.packet;
      assert.ok(packet);
      assert.deepEqual(packet.state.encounteredItems, []);
      const state = packet.state as PromptState;
      assert.deepEqual(state.trajectory.responses.map(({ taskId }) => taskId), ['character-fit']);
      assert.deepEqual(packet.visualMaterials?.map(({ id }) => id), ['writ-portrait']);

      client = new Client({ name: 'visual-follow-on-workflow', version: '1.0.0' });
      transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/mcp.js')], cwd: process.cwd(), env: { ...process.env, SHEG_DATA_DIR: root } });
      await client.connect(transport);
      const queried = await client.callTool({ name: 'run_query', arguments: { sourceRunId: seeded.sourceRunId, criteria: { questionId: 'character-fit' } } });
      assert.equal(queried.isError ?? false, false, JSON.stringify(queried.structuredContent));
      assert.equal((queried.structuredContent as { items: Array<{ selectedMaterial?: unknown; selectedVisualMaterial?: { materialId: string } }> }).items[0]?.selectedMaterial, undefined);
      assert.equal((queried.structuredContent as { items: Array<{ selectedVisualMaterial?: { materialId: string } }> }).items[0]?.selectedVisualMaterial?.materialId, 'writ-portrait');
      const invalidMcp = await client.callTool({ name: 'run_inspect', arguments: { request: invalidUnbound } });
      assert.equal(invalidMcp.isError ?? false, false);
      assert.equal((invalidMcp.structuredContent as { valid: boolean }).valid, false);
    } finally { store.close(); }

    const fixture = JSON.parse(await readFile('skills/stimulus-response-polling/tests/behavior/workflows/visual-follow-on-context-projection.json', 'utf8')) as { turns: Array<{ criteria: string[] }> };
    assert.ok(fixture.turns.flatMap(({ criteria }) => criteria).some((criterion) => /incomplete pair as missing evidence/i.test(criterion)));
  } finally {
    await client?.close();
    await transport?.close();
    await rm(root, { recursive: true, force: true });
  }
});

const clefFitProvider: DecisionProvider = {
  measure() { return { provider: 'clef', status: 'fits', method: 'visual-follow-on-test', modelIdentity: 'clef', tokenCount: 'estimated', tokens: 1, contextLimit: 65_536, headroomTokens: 14_336, effectiveLimit: 51_200, details: {} }; },
  async decide() { throw new Error('Inspection must not call inference.'); },
};
