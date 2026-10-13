import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { DecisionProvider, ProviderContextFit } from '../src/domain/decision/provider.js';
import type { DecisionRequest } from '../src/domain/decision/decision.js';
import { executeQuestionRun } from '../src/application/question-worker.js';
import { createRunService, type ProviderFactory } from '../src/application/run-service.js';
import { openImageAssetRepository } from '../src/infrastructure/sqlite/image-assets.js';
import { openRunStore, splitRunStore } from '../src/infrastructure/run-store.js';
import { providerCatalogueSchema } from '../src/providers/config.js';
import { followOnRunRequestSchema, inlineJourneyRequestSchema } from '../src/domain/run/request.js';

const local = { kind: 'laya' as const, baseUrl: 'http://127.0.0.1:7071', checkpoint: 'local-reader', contextLimit: 16000, headLimit: 4000,
  tokenizerJsonPath: 'C:/models/tokenizer.json', tokenizerSha256: 'a'.repeat(64), timeoutMs: 30000 };
const clef = { kind: 'clef' as const, accountId: '0123456789abcdef0123456789abcdef', model: 'clef' as const };
const catalogue = providerCatalogueSchema.parse({ revision: 0, entries: [
  { id: 'local', enabled: true, provider: local, execution: 'local', capabilities: ['text'], questionTypes: ['choice', 'score', 'noul'], pricing: { kind: 'no-provider-invoice' } },
  { id: 'vision', enabled: true, provider: clef, execution: 'hosted', capabilities: ['text', 'pixels'], questionTypes: ['choice', 'score', 'noul'], pricing: { kind: 'unknown' } },
] });

function fit(kind: 'laya' | 'clef', modelIdentity: string): ProviderContextFit {
  return { provider: kind, status: 'fits', method: 'automatic-routing-test', modelIdentity, tokenCount: 'measured', tokens: 160,
    contextLimit: 16000, headroomTokens: 1000, effectiveLimit: 15000, details: { inputTokens: 160 } };
}

function provider(kind: 'laya' | 'clef', requests: Array<{ kind: 'laya' | 'clef'; request: DecisionRequest }>, failOnce?: { questionId: string; used: boolean }, beforeDispatch?: (request: DecisionRequest) => void, overflowQuestion?: string): DecisionProvider {
  const model = kind === 'laya' ? 'local-reader' : 'clef';
  return {
    measure(request) { const measured = fit(kind, model); const context = (request.state as { respondent?: { profile?: { context?: string } } } | undefined)?.respondent?.profile?.context;
      return kind === 'clef' && request.question.id === overflowQuestion && context === 'Curious reader' ? { ...measured, status: 'overflow', reason: 'simulated-late-lock-overflow' } : measured; },
    async decide(request) {
      requests.push({ kind, request });
      beforeDispatch?.(request);
      if (failOnce && !failOnce.used && request.question.id === failOnce.questionId) { failOnce.used = true; throw new Error('simulated post-dispatch transport loss'); }
      const choice = request.question.id === 'continue' ? 'yes' : 'supports';
      const probabilities = request.question.id === 'continue' ? { yes: 1, no: 0 } : { supports: 1, distracts: 0 };
      return { type: 'choice', choice, probabilities, attempts: 1, provider: kind, model, latencyMs: 1, usage: {} };
    },
  };
}

test('automatic journey routes reached units, preserves matched-provider locks, and fails unsupported visual turns without attempts', async () => {
  for (const scenario of [{ visionEnabled: true, locked: false, lockedOverflow: false }, { visionEnabled: false, locked: false, lockedOverflow: false },
    { visionEnabled: true, locked: true, lockedOverflow: false }, { visionEnabled: true, locked: true, lockedOverflow: true }]) {
    const { visionEnabled, locked, lockedOverflow } = scenario;
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-automatic-provider-routing-'));
  const images = openImageAssetRepository(root);
    let store = openRunStore(root);
  const requests: Array<{ kind: 'laya' | 'clef'; request: DecisionRequest }> = [];
  try {
    const bytes = await readFile(new URL('./fixtures/images/four-corners-transparent.png', import.meta.url));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const image = images.saveSource(bytes, { assetId: `sha256:${sha256}`, sha256, format: 'png', width: 80, height: 40, bytes: bytes.byteLength });
    const entries = catalogue.entries.map((entry) => entry.id === 'vision' ? { ...entry, enabled: visionEnabled } : entry);
    store.setProviderSettings({ catalogue: { entries }, preferences: { preferredOrder: [] } }, 0);
    let service = createRunService({ reads: store, commands: store, close: store.close.bind(store) }, root,
      (config) => provider(config.kind === 'laya' ? 'laya' : 'clef', requests), { async launch() {} }, { async assertProviderReady() {} });
    const request = inlineJourneyRequestSchema.parse({
      kind: 'journey',
      respondents: [
        { id: 'reader-a', intent: 'Understand the section', context: 'Curious reader', desired_outcome: 'Decide whether the image supports the story', engagement_cues: 'Specific details', friction_cues: 'Distraction' },
        { id: 'reader-b', intent: 'Understand the section', context: 'A time-pressed reader', desired_outcome: 'Decide whether the image supports the story', engagement_cues: 'Specific details', friction_cues: 'Distraction' },
      ],
      journey: { id: 'article', label: 'Character article', items: [
        { id: 'section-one', text: 'The opening establishes why the specialist tests unsafe routes.' },
        { id: 'portrait', type: 'image', text: '', altText: 'A small character in a practical grey hoodie with a red thread reel.', caption: 'A specialist portrait.', asset: image },
      ], tasks: [
        { id: 'continue', type: 'choice', instructions: 'Would you continue to the next section?', options: { yes: 'Continue', no: 'Stop' } },
        { id: 'image-fit', type: 'choice', instructions: 'Does this portrait support the next section?', options: { supports: 'Supports it', distracts: 'Distracts from it' }, visual: { mode: 'pixels', materialIds: ['portrait'] } },
      ], presentation: { kind: 'graph', entryNodeId: 'opening', maxDecisions: 2, nodes: [
        { id: 'opening', kind: 'expose', itemId: 'section-one' }, { id: 'continue-node', kind: 'ask', taskId: 'continue' },
        { id: 'show-portrait', kind: 'expose', itemId: 'portrait' }, { id: 'image-node', kind: 'ask', taskId: 'image-fit' },
        { id: 'done', kind: 'terminal', outcome: 'complete' }, { id: 'stopped', kind: 'terminal', outcome: 'stopped' },
      ], transitions: [
        { fromNodeId: 'opening', toNodeId: 'continue-node' }, { fromNodeId: 'continue-node', optionId: 'yes', toNodeId: 'show-portrait' },
        { fromNodeId: 'continue-node', optionId: 'no', toNodeId: 'stopped' }, { fromNodeId: 'show-portrait', toNodeId: 'image-node' },
        { fromNodeId: 'image-node', optionId: 'supports', toNodeId: 'done' }, { fromNodeId: 'image-node', optionId: 'distracts', toNodeId: 'done' },
      ] } },
      providerSelection: locked ? { ...(lockedOverflow ? { unitOverrides: { 'reader-a/continue': 'vision' } } : {}), comparisonLocks: [{ id: 'same-reader-model', members: [
        { respondentId: 'reader-a', questionId: 'continue' }, { respondentId: 'reader-a', questionId: 'image-fit' },
      ] }] } : {},
      maxCalls: 6,
    });
    const inspected = await service.inspect(request);
    assert.equal(inspected.valid, true, JSON.stringify(inspected.problems));
    assert.deepEqual(inspected.unresolvedFutureJourneyUnits, [
      { respondentId: 'reader-a', nodeId: 'image-node', questionId: 'image-fit', unitId: 'reader-a/image-fit', reason: 'reached-context-not-yet-known' },
      { respondentId: 'reader-b', nodeId: 'image-node', questionId: 'image-fit', unitId: 'reader-b/image-fit', reason: 'reached-context-not-yet-known' },
    ]);
    assert.equal(inspected.initialChoices?.[0]?.providerId, lockedOverflow ? 'vision' : 'local');
    const accepted = await service.start(randomUUID(), { ...request, expectedSelectionFingerprint: inspected.selectionFingerprint });
    const failOnce = { questionId: 'image-fit', used: false };
    const factory: ProviderFactory = (config) => provider(config.kind === 'laya' ? 'laya' : 'clef', requests, visionEnabled && !locked ? failOnce : undefined, (packet) => {
      const expectedProvider = config.kind === 'laya' ? 'local' : 'vision';
      const persisted = store.getJourneyRun(accepted.runId).evaluations.some(({ questionId, providerSelection }) => questionId === packet.question.id && providerSelection?.providerId === expectedProvider);
      assert.equal(persisted, true, 'The selected provider must be durable before dispatch begins.');
    }, lockedOverflow ? 'image-fit' : undefined);
    await executeQuestionRun(splitRunStore(store), accepted.runId, factory);
    if (!visionEnabled || locked) {
      assert.equal(store.getStatus(accepted.runId).status, 'partial');
      assert.equal(store.getStatus(accepted.runId).usedCalls, locked && visionEnabled ? 3 : 2);
      assert.equal(requests.filter(({ request: packet }) => packet.question.id === 'continue').length, 2);
      assert.equal(store.answers(accepted.runId).items.find(({ respondentId, questionId }) => respondentId === 'reader-a' && questionId === 'image-fit')?.failure?.code, 'provider_selection_unavailable');
      assert.equal(store.getJourneyRun(accepted.runId).evaluations.find(({ respondentId, questionId }) => respondentId === 'reader-a' && questionId === 'image-fit')?.providerSelection, undefined);
      assert.equal(store.attempts(accepted.runId).items.length, locked && visionEnabled ? 3 : 2);
      if (locked && visionEnabled) assert.equal(requests.some(({ kind, request: packet }) => kind === 'clef' && packet.question.id === 'image-fit'), true,
        'The unrelated respondent must continue through Clef after the locked respondent fails.');
      continue;
    }
    assert.equal(store.getStatus(accepted.runId).status, 'partial');
    assert.equal(store.getStatus(accepted.runId).usedCalls, 4);
    assert.equal(store.getJourneyRun(accepted.runId).evaluations.find(({ respondentId, questionId }) => respondentId === 'reader-a' && questionId === 'image-fit')?.providerSelection?.providerId, 'vision');
    store.close();
    store = openRunStore(root);
    store.setProviderSettings({ catalogue: { entries: entries.map((entry) => entry.id === 'vision' ? { ...entry, enabled: false } : entry) }, preferences: { preferredOrder: ['local'] } }, 1);
    assert.equal(store.getProviderSettings().catalogue.entries.find(({ id }) => id === 'vision')?.enabled, false);
    service = createRunService({ reads: store, commands: store, close: store.close.bind(store) }, root,
      (config) => provider(config.kind === 'laya' ? 'laya' : 'clef', requests), { async launch() {} }, { async assertProviderReady() {} });
    await service.resume(accepted.runId);
    await executeQuestionRun(splitRunStore(store), accepted.runId, factory);
    assert.equal(store.getStatus(accepted.runId).status, 'completed', JSON.stringify({ status: store.getStatus(accepted.runId), answers: store.answers(accepted.runId).items }));
    const queried = store.queryEvidence({ sourceRunId: accepted.runId, criteria: { status: 'answered' } });
    assert.deepEqual(queried.items.map(({ questionId, provenance }) => [questionId, provenance.provider, provenance.model, provenance.endpoint]), [
      ['continue', 'laya', 'local-reader', 'http://127.0.0.1:7071'], ['continue', 'laya', 'local-reader', 'http://127.0.0.1:7071'],
      ['image-fit', 'clef', 'clef', 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/cloudflare/clef'],
      ['image-fit', 'clef', 'clef', 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/cloudflare/clef'],
    ]);
    assert.equal(requests.filter(({ request: packet }) => packet.question.id === 'continue').length, 2);
    assert.equal(requests.filter(({ kind, request: packet }) => kind === 'clef' && packet.question.id === 'image-fit').length, 3);
    assert.deepEqual(requests.find(({ kind, request: packet }) => kind === 'clef' && packet.question.id === 'image-fit')?.request.visualMaterials?.map(({ id }) => id), ['portrait']);
    const laterState = requests.find(({ kind, request: packet }) => kind === 'clef' && packet.question.id === 'image-fit')!.request.state as { trajectory?: { choices?: Array<{ choiceId: string }> } };
    assert.equal(laterState.trajectory?.choices?.length, 1);
    assert.equal(laterState.trajectory?.choices?.[0]?.choiceId, 'yes');
    const saved = store.getJourneyRun(accepted.runId).evaluations;
    assert.deepEqual(saved.map(({ respondentId, questionId, providerSelection }) => [respondentId, questionId, providerSelection?.providerId]), [
      ['reader-a', 'continue', 'local'], ['reader-b', 'continue', 'local'], ['reader-a', 'image-fit', 'vision'], ['reader-b', 'image-fit', 'vision'],
    ]);
    assert.equal(store.attempts(accepted.runId).items.length, 5);

    store.setProviderSettings({ catalogue: { entries: catalogue.entries.map((entry) => entry.id === 'vision' ? { ...entry, enabled: true } : entry) }, preferences: { preferredOrder: [] } }, 2);
    const imageEvaluation = saved.find(({ respondentId, questionId }) => respondentId === 'reader-a' && questionId === 'image-fit')!;
    const followOn = followOnRunRequestSchema.parse({ kind: 'follow-on', sourceRunId: accepted.runId,
      selection: { references: [{ evaluationId: imageEvaluation.evaluationId, contextId: imageEvaluation.contextId }] },
      context: { mode: 'continue', materialIds: ['portrait'] },
      questions: [{ type: 'choice', id: 'follow-image', instructions: 'Does this image still fit?', options: { supports: 'It fits', distracts: 'It distracts' }, visual: { mode: 'pixels', materialIds: ['portrait'] } }],
      providerSelection: {}, maxCalls: 1 });
    const followInspection = await service.inspect(followOn);
    assert.equal(followInspection.valid, true, JSON.stringify(followInspection.problems));
    assert.equal(followInspection.initialChoices?.[0]?.providerId, 'vision');
    const otherImageEvaluation = saved.find(({ respondentId, questionId }) => respondentId === 'reader-b' && questionId === 'image-fit')!;
    const lockedFollowOn = followOnRunRequestSchema.parse({ ...followOn,
      selection: { references: [
        { evaluationId: imageEvaluation.evaluationId, contextId: imageEvaluation.contextId },
        { evaluationId: otherImageEvaluation.evaluationId, contextId: otherImageEvaluation.contextId },
      ] },
      providerSelection: { comparisonLocks: [{ id: 'visual-match', members: [
        { respondentId: 'reader-a', questionId: 'follow-image' }, { respondentId: 'reader-b', questionId: 'follow-image' },
      ] }] } });
    const lockedInspection = await service.inspect(lockedFollowOn);
    assert.equal(lockedInspection.valid, false);
    assert.match(lockedInspection.problems[0]?.message ?? '', /exact source contexts/);
    const followAccepted = await service.start(randomUUID(), { ...followOn, expectedSelectionFingerprint: followInspection.selectionFingerprint });
    store.setProviderSettings({ catalogue: { entries: catalogue.entries.map((entry) => entry.id === 'vision' ? { ...entry, enabled: false } : entry) }, preferences: { preferredOrder: ['local'] } }, 3);
    await executeQuestionRun(splitRunStore(store), followAccepted.runId, (config) => provider(config.kind === 'laya' ? 'laya' : 'clef', requests));
    assert.equal(store.getStatus(followAccepted.runId).status, 'completed', JSON.stringify(store.answers(followAccepted.runId).items));
    const followEvaluations = store.getRequest(followAccepted.runId).evaluations;
    assert.equal(followEvaluations[0]?.providerSelection?.providerId, 'vision');
    assert.equal(store.queryEvidence({ sourceRunId: followAccepted.runId, criteria: { status: 'answered' } }).items[0]?.provenance.provider, 'clef');
  } finally { store.close(); images.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test('a shared fork comparison resolves every ready branch to Clef before dispatch, or fails without calls when none can serve all', async () => {
  for (const visionEnabled of [true, false]) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-fork-provider-lock-'));
    const images = openImageAssetRepository(root);
    const store = openRunStore(root);
    const requests: Array<{ kind: 'laya' | 'clef'; request: DecisionRequest }> = [];
    try {
      const bytes = await readFile(new URL('./fixtures/images/four-corners-transparent.png', import.meta.url));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const image = images.saveSource(bytes, { assetId: `sha256:${sha256}`, sha256, format: 'png', width: 80, height: 40, bytes: bytes.byteLength });
      store.setProviderSettings({ catalogue: { entries: catalogue.entries.map((entry) => entry.id === 'vision' ? { ...entry, enabled: visionEnabled } : entry) }, preferences: { preferredOrder: [] } }, 0);
      const service = createRunService({ reads: store, commands: store, close: store.close.bind(store) }, root,
        (config) => provider(config.kind === 'laya' ? 'laya' : 'clef', requests), { async launch() {} }, { async assertProviderReady() {} });
      const request = inlineJourneyRequestSchema.parse({
        kind: 'journey', respondents: [{ id: 'reader-a', intent: 'Assess the illustration', context: 'A visual reader', desired_outcome: 'Judge the image in context', engagement_cues: 'Relevant details', friction_cues: 'Distraction' }],
        journey: { id: 'article', label: 'Image comparison', items: [
          { id: 'opening', text: 'A short opening before the comparison.' },
          { id: 'image-treatment', type: 'image', text: '', altText: 'A small friendly character carrying a satchel.', caption: 'Character portrait.', asset: image },
          { id: 'text-treatment', text: 'The section continues without the portrait.' },
        ], tasks: [
          { id: 'prefix', type: 'choice', instructions: 'Would you continue into the next section?', options: { continue: 'Continue', stop: 'Stop' } },
          { id: 'with-image', type: 'choice', comparisonKey: 'image-contribution', instructions: 'Would you continue into the next section?', options: { continue: 'Continue', stop: 'Stop' }, visual: { mode: 'pixels', materialIds: ['image-treatment'] } },
          { id: 'without-image', type: 'choice', comparisonKey: 'image-contribution', instructions: 'Would you continue into the next section?', options: { continue: 'Continue', stop: 'Stop' } },
        ], presentation: { kind: 'graph', entryNodeId: 'opening-exposure', maxDecisions: 3, nodes: [
          { id: 'opening-exposure', kind: 'expose', itemId: 'opening' }, { id: 'prefix-ask', kind: 'ask', taskId: 'prefix' },
          { id: 'image-fork', kind: 'fork', conditions: [{ id: 'present', label: 'Image present', entryNodeId: 'image-exposure' }, { id: 'absent', label: 'Image absent', entryNodeId: 'text-exposure' }] },
          { id: 'image-exposure', kind: 'expose', itemId: 'image-treatment' }, { id: 'image-ask', kind: 'ask', taskId: 'with-image' },
          { id: 'text-exposure', kind: 'expose', itemId: 'text-treatment' }, { id: 'text-ask', kind: 'ask', taskId: 'without-image' },
          { id: 'done', kind: 'terminal', outcome: 'complete' },
        ], transitions: [
          { fromNodeId: 'opening-exposure', toNodeId: 'prefix-ask' }, { fromNodeId: 'prefix-ask', optionId: 'continue', toNodeId: 'image-fork' },
          { fromNodeId: 'prefix-ask', optionId: 'stop', toNodeId: 'done' }, { fromNodeId: 'image-exposure', toNodeId: 'image-ask' },
          { fromNodeId: 'text-exposure', toNodeId: 'text-ask' }, { fromNodeId: 'image-ask', optionId: 'continue', toNodeId: 'done' },
          { fromNodeId: 'image-ask', optionId: 'stop', toNodeId: 'done' }, { fromNodeId: 'text-ask', optionId: 'continue', toNodeId: 'done' },
          { fromNodeId: 'text-ask', optionId: 'stop', toNodeId: 'done' },
        ] },
        },
        providerSelection: {}, maxCalls: 3,
      });
      const inspected = await service.inspect(request);
      assert.equal(inspected.valid, true, JSON.stringify(inspected.problems));
      const accepted = await service.start(randomUUID(), { ...request, expectedSelectionFingerprint: inspected.selectionFingerprint });
      const model = (kind: 'laya' | 'clef') => ({ measure: () => fit(kind, kind === 'laya' ? local.checkpoint : 'clef'), async decide(packet: DecisionRequest) {
        requests.push({ kind, request: packet });
        const questionId = packet.question.id;
        if (questionId !== 'prefix') {
          const evaluations = store.getJourneyRun(accepted.runId).evaluations;
          const choices = evaluations.filter(({ questionId: id }) => id === 'with-image' || id === 'without-image');
          assert.equal(choices.length, 2);
          assert.ok(choices.every(({ providerSelection }) => providerSelection?.providerId === (visionEnabled ? 'vision' : undefined)), 'Both sibling provider decisions must be persisted before either dispatch.');
        }
        return { type: 'choice' as const, choice: 'continue', probabilities: { continue: 0.9, stop: 0.1 }, attempts: 1, provider: kind,
          model: kind === 'laya' ? 'local-reader' : 'clef', latencyMs: 1, usage: {} };
      } });
      await executeQuestionRun(splitRunStore(store), accepted.runId, (config) => model(config.kind === 'laya' ? 'laya' : 'clef'));
      const branches = store.getJourneyRun(accepted.runId).evaluations.filter(({ questionId }) => questionId === 'with-image' || questionId === 'without-image');
      if (visionEnabled) {
        assert.equal(requests.filter(({ request: packet }) => packet.question.id === 'with-image' || packet.question.id === 'without-image').length, 2,
          JSON.stringify({ status: store.getStatus(accepted.runId), branches }));
        assert.ok(branches.every(({ providerSelection }) => providerSelection?.providerId === 'vision'));
        assert.deepEqual(branches.map(({ branchId, providerSelection }) => providerSelection?.branchId === branchId), [true, true]);
        assert.equal(new Set(branches.map(({ providerSelection }) => providerSelection?.comparisonLockId)).size, 1);
        assert.equal(store.getJourneyRun(accepted.runId).evaluations.find(({ questionId }) => questionId === 'prefix')?.providerSelection?.providerId, 'local');
      } else {
        assert.equal(requests.filter(({ request: packet }) => packet.question.id === 'with-image' || packet.question.id === 'without-image').length, 0);
        assert.ok(branches.every(({ status, failure }) => status === 'failed' && failure?.code === 'comparison_provider_unavailable'));
        assert.ok(branches.every(({ providerSelection }) => providerSelection === undefined));
        assert.equal(store.attempts(accepted.runId).items.length, 1, 'Only the shared prefix may consume a physical call when no provider fits both conditions.');
        await assert.rejects(service.resume(accepted.runId), 'An unavailable matched provider must not let resume dispatch one condition independently.');
      }
    } finally { store.close(); images.close(); await rm(root, { recursive: true, force: true }); }
  }
});
