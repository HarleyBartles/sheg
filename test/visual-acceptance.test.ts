import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { materializeJourneyRun, prepareFollowOnRun, prepareRun } from '../src/application/run-inspection.js';
import { ClefProvider } from '../src/providers/clef.js';
import { openImageAssetRepository } from '../src/infrastructure/sqlite/image-assets.js';
import { openRunStore, RunStoreError, splitRunStore } from '../src/infrastructure/run-store.js';
import { createRunRuntime } from '../src/infrastructure/run-runtime.js';
import { executeQuestionRun } from '../src/application/question-worker.js';
import type { DecisionProvider } from '../src/domain/decision/provider.js';
import { hashCanonical } from '../src/infrastructure/identity.js';
import { compileDecisionPacketForCompiler } from '../src/domain/decision/prompt.js';
import { followOnRunRequestSchema } from '../src/domain/run/request.js';

const bytesPromise = readFile(new URL('./fixtures/images/four-corners-transparent.png', import.meta.url));
const config = { kind: 'clef' as const, accountId: '3327878972ea82e6b454069bba62f3d9', model: 'clef' as const, timeoutMs: 1000 };
const credentials = { async readForAuthentication() { return 'test-secret'; } };

function asset(bytes: Uint8Array) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { assetId: `sha256:${sha256}`, sha256, format: 'png' as const, width: 80, height: 40, bytes: bytes.byteLength };
}

function request(image: ReturnType<typeof asset>) {
  return {
    kind: 'poll' as const,
    respondents: [{ id: 'reader-a', intent: 'Read the article', context: 'Curious', desired_outcome: 'Understand the point', engagement_cues: 'Examples', friction_cues: 'Distraction' }],
    material: [{ id: 'section-three', text: 'The article continues.' }, { id: 'portrait', type: 'image' as const, text: '', altText: 'Approved specialist portrait.', caption: 'Writ at the ledger desk.', asset: image }],
    questions: [{ type: 'choice' as const, id: 'image-fit', instructions: 'Does the image help this section?', options: { yes: 'Adds to the section', no: 'Takes away from the section' }, visual: { mode: 'pixels' as const, materialIds: ['portrait'] } }],
    provider: config,
    maxCalls: 1,
  };
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'sheg-visual-acceptance-'));
  const imageRepository = openImageAssetRepository(root);
  const bytes = await bytesPromise;
  const metadata = asset(bytes);
  imageRepository.saveSource(bytes, metadata);
  const store = openRunStore(root);
  const provider = new ClefProvider(config, fetch, { credentialStore: credentials, imageResolver: { resolve: (assetId) => ({ metadata: imageRepository.metadata(assetId), bytes: imageRepository.bytes(assetId) }) } });
  const prepared = await prepareRun(request(metadata), provider);
  assert.ok(prepared.prepared);
  return { root, bytes, metadata, imageRepository, store, prepared: prepared.prepared, close: async () => { store.close(); imageRepository.close(); await rm(root, { recursive: true, force: true }); } };
}

test('accepted visual polls freeze ordered packet metadata and retain the exact imported image bytes', async () => {
  const fixture = await setup();
  const sourcePath = path.join(fixture.root, 'source.png');
  try {
    await writeFile(sourcePath, fixture.bytes);
    const accepted = fixture.store.accept(randomUUID(), fixture.prepared);
    await writeFile(sourcePath, Buffer.from('source changed after acceptance'));
    const frozen = fixture.store.getRequest(accepted.run.runId);
    const evaluation = frozen.evaluations[0]!;
    assert.deepEqual(evaluation.packet.visualMaterials?.map(({ id, asset, altText, caption }) => ({ id, asset, altText, caption })), [
      { id: 'portrait', asset: fixture.metadata, altText: 'Approved specialist portrait.', caption: 'Writ at the ledger desk.' },
    ]);
    assert.deepEqual(evaluation.packet.state.materialOrder, ['section-three', 'portrait']);
    const database = new DatabaseSync(path.join(fixture.root, 'runs.sqlite'), { enableForeignKeyConstraints: true });
    try {
      assert.deepEqual(database.prepare('SELECT material_id, asset_id FROM run_visual_assets WHERE run_id = ?').all(accepted.run.runId).map((row) => ({ ...row })), [
        { material_id: 'portrait', asset_id: fixture.metadata.assetId },
      ]);
      assert.throws(() => database.prepare('DELETE FROM image_assets WHERE asset_id = ?').run(fixture.metadata.assetId));
    } finally { database.close(); }
    await rm(sourcePath);
    assert.deepEqual(Buffer.from(fixture.imageRepository.bytes(fixture.metadata.assetId)), fixture.bytes);
  } finally { await fixture.close(); }
});

test('worker sends the accepted frozen pixels through Clef and settles the answer in the shared attempt ledger', async () => {
  const fixture = await setup();
  let transportedImages: string[] = [];
  let suppliedResolver = false;
  try {
    const accepted = fixture.store.accept(randomUUID(), fixture.prepared);
    const fetchRequest = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { images: string[] };
      transportedImages = body.images;
      return Response.json({ success: true, result: { model: 'clef', answers: { 'image-fit': { type: 'choice', choice: 'yes', probabilities: { yes: 0.9, no: 0.1 } } }, usage: { input_tokens: 30, output_tokens: 0 } }, errors: [], messages: [] });
    }) as typeof fetch;
    await executeQuestionRun(splitRunStore(fixture.store), accepted.run.runId, (_config, options) => {
      suppliedResolver = options?.imageResolver !== undefined;
      return new ClefProvider(config, fetchRequest, { credentialStore: credentials, ...(options?.imageResolver ? { imageResolver: options.imageResolver } : {}) });
    }, { imageResolver: { resolve: (assetId: string) => ({ metadata: fixture.imageRepository.metadata(assetId), bytes: fixture.imageRepository.bytes(assetId) }) } });
    assert.equal(suppliedResolver, true);
    assert.deepEqual(transportedImages, [`data:image/png;base64,${Buffer.from(fixture.bytes).toString('base64')}`]);
    assert.equal(fixture.store.getStatus(accepted.run.runId).status, 'completed');
    assert.equal(fixture.store.answers(accepted.run.runId).items[0]?.result?.type, 'choice');
    const attempts = fixture.store.attempts(accepted.run.runId).items;
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.execution?.provider, 'clef');
    assert.equal(attempts[0]?.execution?.model, 'clef');
  } finally { await fixture.close(); }
});

test('pixel Choice image mappings identify options without creating text selected-material evidence', async () => {
  const fixture = await setup();
  try {
    const base = request(fixture.metadata);
    const sourceRequest = { ...base, questions: [{ ...base.questions[0]!, materialOptions: { yes: 'portrait' } }] };
    const imageResolver = { resolve: (assetId: string) => ({ metadata: fixture.imageRepository.metadata(assetId), bytes: fixture.imageRepository.bytes(assetId) }) };
    const admitted = await prepareRun(sourceRequest, new ClefProvider(config, fetch, { credentialStore: credentials, imageResolver }));
    assert.ok(admitted.prepared, JSON.stringify(admitted.inspection.problems));
    const accepted = fixture.store.accept(randomUUID(), admitted.prepared);
    const fetchRequest = (async () => Response.json({ success: true, result: { model: 'clef', answers: {
      'image-fit': { type: 'choice', choice: 'yes', probabilities: { yes: 0.9, no: 0.1 } },
    }, usage: { input_tokens: 30, output_tokens: 0 } }, errors: [], messages: [] })) as typeof fetch;
    await executeQuestionRun(splitRunStore(fixture.store), accepted.run.runId, (_providerConfig, options) => new ClefProvider(config, fetchRequest,
      { credentialStore: credentials, ...(options?.imageResolver ? { imageResolver: options.imageResolver } : {}) }), { imageResolver });
    const evidence = fixture.store.queryEvidence({ sourceRunId: accepted.run.runId,
      criteria: { questionId: 'image-fit', answer: { type: 'choice', choiceId: 'yes' } } });
    assert.equal(evidence.items[0]?.selectedMaterial, undefined);
    assert.deepEqual(evidence.items[0]?.selectedVisualMaterial, { materialId: 'portrait', altText: 'Approved specialist portrait.', caption: 'Writ at the ledger desk.', asset: fixture.metadata });
    assert.deepEqual(evidence.matchedCoverage.selectedVisualMaterials, { evaluations: 1, respondents: 1, distinctMaterials: 1 });

    const followOn = followOnRunRequestSchema.parse({ kind: 'follow-on', sourceRunId: accepted.run.runId,
      selection: { criteria: { questionId: 'image-fit' } }, context: { mode: 'fresh-material', includeSelectedMaterial: true },
      questions: [{ type: 'noul', id: 'image-follow-up', instructions: 'Does the image still fit the next section?' }], provider: config, maxCalls: 1 });
    const sources = fixture.store.resolveFollowOnSources(followOn);
    assert.equal(sources.turns[0]?.status, 'answered');
    assert.equal(sources.turns[0]?.selectedMaterial, undefined);
    assert.deepEqual(sources.turns[0]?.selectedVisualMaterial, evidence.items[0]?.selectedVisualMaterial);
    const database = new DatabaseSync(path.join(fixture.root, 'runs.sqlite'));
    try { database.prepare('DELETE FROM run_visual_assets WHERE run_id = ? AND material_id = ?').run(accepted.run.runId, 'portrait'); }
    finally { database.close(); }
    assert.throws(() => fixture.store.queryEvidence({ sourceRunId: accepted.run.runId, criteria: { questionId: 'image-fit' } }),
      (error: unknown) => error instanceof RunStoreError && error.code === 'data_integrity_error');
  } finally { await fixture.close(); }
});

test('mapped image Choice evidence remains visual and can seed an explicitly pixel-bound follow-on after source-file removal', async () => {
  const fixture = await setup();
  try {
    const imageResolver = { resolve: (assetId: string) => ({ metadata: fixture.imageRepository.metadata(assetId), bytes: fixture.imageRepository.bytes(assetId) }) };
    const sourceRequest = { ...request(fixture.metadata), questions: [{ ...request(fixture.metadata).questions[0]!, materialOptions: { yes: 'portrait' } }] };
    const admitted = await prepareRun(sourceRequest, new ClefProvider(config, fetch, { credentialStore: credentials, imageResolver }));
    assert.ok(admitted.prepared, JSON.stringify(admitted.inspection.problems));
    const accepted = fixture.store.accept(randomUUID(), admitted.prepared);
    const sourceFetch = (async () => Response.json({ success: true, result: { model: 'clef', answers: {
      'image-fit': { type: 'choice', choice: 'yes', probabilities: { yes: 0.9, no: 0.1 } },
    }, usage: { input_tokens: 30, output_tokens: 0 } }, errors: [], messages: [] })) as typeof fetch;
    await executeQuestionRun(splitRunStore(fixture.store), accepted.run.runId, (_providerConfig, options) => new ClefProvider(config, sourceFetch,
      { credentialStore: credentials, ...(options?.imageResolver ? { imageResolver: options.imageResolver } : {}) }), { imageResolver });

    const followOn = followOnRunRequestSchema.parse({ kind: 'follow-on', sourceRunId: accepted.run.runId,
      selection: { criteria: { questionId: 'image-fit' } }, context: { mode: 'fresh-material', includeSelectedMaterial: true, materialIds: ['portrait', 'section-three'] },
      material: [{ id: 'section-four', text: 'The article explains the recommendation.' }],
      questions: [{ type: 'noul', id: 'image-follow-up', instructions: 'How much does this image support the next section?',
        visual: { mode: 'pixels', materialIds: ['portrait'] } }], provider: config, maxCalls: 1 });
    const sources = fixture.store.resolveFollowOnSources(followOn);
    assert.deepEqual(sources.turns[0]?.selectedVisualMaterial, { materialId: 'portrait', altText: 'Approved specialist portrait.', caption: 'Writ at the ledger desk.', asset: fixture.metadata });
    const prepared = await prepareFollowOnRun(followOn, sources, new ClefProvider(config, fetch, { credentialStore: credentials, imageResolver }));
    assert.ok(prepared.prepared, JSON.stringify(prepared.inspection.problems));
    const altered = structuredClone(prepared.prepared);
    altered.lineage!.selections[0]!.selectedVisualMaterial!.asset.width += 1;
    assert.throws(() => fixture.store.accept(randomUUID(), altered), /frozen visual packet differs|Selected-material lineage does not match/);
    const packet = prepared.prepared.evaluations[0]!.packet;
    assert.deepEqual(packet.visualMaterials?.map(({ id, altText, asset }) => ({ id, altText, asset })), [
      { id: 'portrait', altText: 'Approved specialist portrait.', asset: fixture.metadata },
    ]);
    assert.deepEqual(((packet.state as { encounteredItems: Array<{ id: string }> }).encounteredItems).map(({ id }) => id), ['section-three', 'section-four']);
    const followOnAccepted = fixture.store.accept(randomUUID(), prepared.prepared);
    const frozenFollowOn = fixture.store.getRequest(followOnAccepted.run.runId);
    assert.deepEqual(frozenFollowOn.lineage?.selections[0]?.selectedVisualMaterial, sources.turns[0]?.selectedVisualMaterial);
    assert.deepEqual(frozenFollowOn.lineage?.materialSnapshots[0]?.materials.find(({ id }) => id === 'portrait'), request(fixture.metadata).material[1]);
    assert.equal(fixture.store.deleteRuns([accepted.run.runId]).deletedRunIds[0], accepted.run.runId);
    const followOnFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { images: string[]; state: { encounteredItems: Array<{ id: string }> } };
      assert.deepEqual(body.images, [`data:image/png;base64,${Buffer.from(fixture.bytes).toString('base64')}`]);
      assert.deepEqual(body.state.encounteredItems.map(({ id }) => id), ['section-three', 'section-four']);
      return Response.json({ success: true, result: { model: 'clef', answers: {
        'image-follow-up': { type: 'noul', noul: 0.8 },
      }, usage: { input_tokens: 30, output_tokens: 0 } }, errors: [], messages: [] });
    }) as typeof fetch;
    await executeQuestionRun(splitRunStore(fixture.store), followOnAccepted.run.runId, (_providerConfig, options) => new ClefProvider(config, followOnFetch,
      { credentialStore: credentials, ...(options?.imageResolver ? { imageResolver: options.imageResolver } : {}) }), { imageResolver });
    const evidence = fixture.store.queryEvidence({ sourceRunId: followOnAccepted.run.runId, criteria: { questionId: 'image-follow-up' } });
    assert.equal(evidence.items[0]?.selectedMaterial, undefined);
    const db = new DatabaseSync(path.join(fixture.root, 'runs.sqlite'));
    try {
      assert.deepEqual(db.prepare('SELECT material_id, asset_id FROM run_visual_assets WHERE run_id = ?').all(followOnAccepted.run.runId).map((row) => ({ ...row })), [
        { material_id: 'portrait', asset_id: fixture.metadata.assetId },
      ]);
    } finally { db.close(); }
  } finally { await fixture.close(); }
});

test('worker settles a valid Clef sibling while keeping one malformed visual answer locally retryable', async () => {
  const fixture = await setup();
  let dispatches = 0;
  try {
    const imageResolver = { resolve: (assetId: string) => ({ metadata: fixture.imageRepository.metadata(assetId), bytes: fixture.imageRepository.bytes(assetId) }) };
    const study = { ...request(fixture.metadata), questions: [
      request(fixture.metadata).questions[0]!,
      { type: 'noul' as const, id: 'image-confidence', instructions: 'Does this image communicate the intended section?', visual: { mode: 'pixels' as const, materialIds: ['portrait'] } },
    ] };
    const admitted = await prepareRun(study, new ClefProvider(config, fetch, { credentialStore: credentials, imageResolver }));
    assert.ok(admitted.prepared);
    const accepted = fixture.store.accept(randomUUID(), admitted.prepared);
    const fetchRequest = (async () => {
      dispatches += 1;
      return Response.json({ success: true, result: { model: 'clef', answers: {
        'image-fit': { type: 'choice', choice: 'yes', probabilities: { yes: 0.9, no: 0.1 } },
        'image-confidence': { type: 'noul', noul: 'not numeric' },
      }, usage: { input_tokens: 30, output_tokens: 0 } }, errors: [], messages: [] });
    }) as typeof fetch;
    await executeQuestionRun(splitRunStore(fixture.store), accepted.run.runId, (_config, options) => new ClefProvider(config, fetchRequest,
      { credentialStore: credentials, ...(options?.imageResolver ? { imageResolver: options.imageResolver } : {}) }), { imageResolver });
    const answers = fixture.store.answers(accepted.run.runId).items;
    assert.equal(dispatches, 1);
    assert.equal(answers.find(({ questionId }) => questionId === 'image-fit')?.status, 'answered');
    assert.equal(answers.find(({ questionId }) => questionId === 'image-confidence')?.status, 'failed');
    assert.equal(fixture.store.attempts(accepted.run.runId).items.length, 1);
  } finally { await fixture.close(); }
});

test('worker refuses a pixel batch on provider fit before reservation or transport', async () => {
  const fixture = await setup();
  let reserveCalls = 0;
  let transportCalls = 0;
  try {
    const accepted = fixture.store.accept(randomUUID(), fixture.prepared);
    const commands = fixture.store;
    const observedCommands = new Proxy(commands, { get(target, property, receiver) {
      if (property === 'reserveBatch') return (...args: Parameters<typeof commands.reserveBatch>) => { reserveCalls += 1; return commands.reserveBatch(...args); };
      return Reflect.get(target, property, receiver) as unknown;
    } });
    const provider: DecisionProvider = {
      measure: () => { throw new Error('Worker requires batch measurement.'); },
      measureBatch: () => ({ provider: 'clef', status: 'overflow', method: 'test', modelIdentity: 'clef', tokenCount: 'estimated', tokens: 51_201, contextLimit: 65_536, headroomTokens: 14_336, effectiveLimit: 51_200, details: {} }),
      async decide() { transportCalls += 1; throw new Error('Must not dispatch.'); },
      async decideBatch() { transportCalls += 1; throw new Error('Must not dispatch.'); },
    };
    await executeQuestionRun({ reads: splitRunStore(fixture.store).reads, commands: observedCommands, close() {} }, accepted.run.runId, () => provider);
    assert.equal(reserveCalls, 0);
    assert.equal(transportCalls, 0);
    assert.equal(fixture.store.attempts(accepted.run.runId).items.length, 0);
  } finally { await fixture.close(); }
});

test('default runtime resolves saved image bytes during Clef inspection without requiring provider credentials', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sheg-visual-runtime-'));
  const bytes = await bytesPromise;
  const metadata = asset(bytes);
  const repository = openImageAssetRepository(root);
  repository.saveSource(bytes, metadata);
  repository.close();
  const runtime = createRunRuntime(root);
  try {
    const inspection = await runtime.service.inspect(request(metadata));
    assert.equal(inspection.valid, true);
    assert.equal(inspection.fits[0]?.fit.provider, 'clef');
    assert.equal(inspection.fits[0]?.fit.status, 'fits');
    assert.equal(inspection.fits[0]?.fit.details.imageCount, 1);
  } finally { runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test('acceptance refuses bytes that changed after inspection without creating a partial run', async () => {
  const fixture = await setup();
  const database = new DatabaseSync(path.join(fixture.root, 'runs.sqlite'));
  try {
    const changed = Buffer.from(fixture.bytes);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 0xff;
    database.prepare('UPDATE image_assets SET content = ? WHERE asset_id = ?').run(changed, fixture.metadata.assetId);
    assert.throws(() => fixture.store.accept(randomUUID(), fixture.prepared), /image asset/i);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM runs').get() as { count: number }).count, 0);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM evaluations').get() as { count: number }).count, 0);
  } finally { database.close(); await fixture.close(); }
});

test('journey acceptance retains a later image while its initial text packet stays image-free', async () => {
  const fixture = await setup();
  try {
    const journey = {
      kind: 'journey' as const,
      respondents: [{ id: 'reader-a', intent: 'Read the article', context: 'Curious', desired_outcome: 'Understand the point', engagement_cues: 'Examples', friction_cues: 'Distraction' }],
      journey: {
        id: 'article', label: 'Article with a visual insertion',
        items: [fixture.prepared.request.kind === 'poll' ? fixture.prepared.request.material[0]! : { id: 'opening', text: 'Opening.' },
          fixture.prepared.request.kind === 'poll' ? fixture.prepared.request.material[1]! : { id: 'portrait', type: 'image' as const, text: '', altText: 'Approved specialist portrait.', caption: 'Writ at the ledger desk.', asset: fixture.metadata }],
        tasks: [
          { type: 'choice' as const, id: 'opening-interest', instructions: 'Would you continue?', options: { continue: 'Continue', leave: 'Leave' } },
          { type: 'choice' as const, id: 'portrait-fit', instructions: 'Does the image help this section?', options: { yes: 'Adds to the section', no: 'Takes away from the section' }, visual: { mode: 'pixels' as const, materialIds: ['portrait'] } },
        ],
        presentation: { kind: 'graph' as const, entryNodeId: 'show-opening', maxDecisions: 2,
          nodes: [
            { id: 'show-opening', kind: 'expose' as const, itemId: 'section-three' },
            { id: 'ask-opening', kind: 'ask' as const, taskId: 'opening-interest' },
            { id: 'show-portrait', kind: 'expose' as const, itemId: 'portrait' },
            { id: 'ask-portrait', kind: 'ask' as const, taskId: 'portrait-fit' },
            { id: 'complete', kind: 'terminal' as const, outcome: 'complete' },
          ],
          transitions: [
            { fromNodeId: 'show-opening', toNodeId: 'ask-opening' },
            { fromNodeId: 'ask-opening', optionId: 'continue', toNodeId: 'show-portrait' },
            { fromNodeId: 'ask-opening', optionId: 'leave', toNodeId: 'show-portrait' },
            { fromNodeId: 'show-portrait', toNodeId: 'ask-portrait' },
            { fromNodeId: 'ask-portrait', optionId: 'yes', toNodeId: 'complete' },
            { fromNodeId: 'ask-portrait', optionId: 'no', toNodeId: 'complete' },
          ],
        },
      },
      provider: config, maxCalls: 2,
    };
    const admission = await prepareRun(journey, new ClefProvider(config, fetch, { credentialStore: credentials }));
    assert.ok(admission.inspection.valid);
    assert.ok(admission.journey);
    const accepted = fixture.store.acceptJourney(randomUUID(), materializeJourneyRun(admission.journey));
    const frozen = fixture.store.getJourneyRun(accepted.run.runId);
    assert.equal(frozen.evaluations.length, 1);
    assert.equal(frozen.evaluations[0]!.packet.visualMaterials, undefined);
    assert.deepEqual(frozen.evaluations[0]!.packet.state.encounteredItems.map(({ id }) => id), ['section-three']);
    const database = new DatabaseSync(path.join(fixture.root, 'runs.sqlite'));
    try {
      assert.deepEqual(database.prepare('SELECT material_id, asset_id FROM run_visual_assets WHERE run_id = ?').all(accepted.run.runId).map((row) => ({ ...row })), [
        { material_id: 'portrait', asset_id: fixture.metadata.assetId },
      ]);
    } finally { database.close(); }
  } finally { await fixture.close(); }
});

test('a resumed visual journey carries its supplied image facts and typed Clef reaction forward without replaying pixels', async () => {
  const fixture = await setup();
  const bodies: Array<{ images: string[]; questions: Record<string, unknown>; state: Record<string, unknown> }> = [];
  try {
    const imageResolver = { resolve: (assetId: string) => ({ metadata: fixture.imageRepository.metadata(assetId), bytes: fixture.imageRepository.bytes(assetId) }) };
    const journey = {
      kind: 'journey' as const,
      respondents: [{ id: 'reader-a', intent: 'Read the article', context: 'Curious', desired_outcome: 'Understand the point', engagement_cues: 'Examples', friction_cues: 'Distraction' }],
      journey: {
        id: 'article', label: 'Article with a visual insertion',
        items: [
          { id: 'section-three', text: 'The section explains the evidence.' },
          { id: 'portrait', type: 'image' as const, text: '', altText: 'A determined specialist in a teal coat checks a ledger.', caption: 'Writ prepares the records.', asset: fixture.metadata },
          { id: 'section-four', text: 'The next section explains the recommendation.' },
        ],
        tasks: [
          { id: 'read-section-three', type: 'choice' as const, instructions: 'Would you continue?', options: { continue: 'Continue', leave: 'Leave' } },
          { id: 'image-fit', type: 'choice' as const, instructions: 'Does the image support the next section?', options: { yes: 'It supports the section', no: 'It distracts from the section' }, visual: { mode: 'pixels' as const, materialIds: ['portrait'] } },
          { id: 'image-confirmed', type: 'choice' as const, instructions: 'Does seeing the same image again still support the section?', options: { yes: 'It still supports the section', no: 'It now feels repetitive' }, visual: { mode: 'pixels' as const, materialIds: ['portrait'] } },
          { id: 'image-described', type: 'choice' as const, instructions: 'Does the supplied description communicate the image clearly?', options: { yes: 'The description is clear', no: 'The description is unclear' }, visual: { mode: 'described' as const, materialIds: ['portrait'] } },
          { id: 'read-section-four', type: 'choice' as const, instructions: 'Would you continue after this section?', options: { continue: 'Continue', leave: 'Leave' } },
        ],
        presentation: { kind: 'graph' as const, entryNodeId: 'expose-three', maxDecisions: 5, nodes: [
          { id: 'expose-three', kind: 'expose' as const, itemId: 'section-three' },
          { id: 'ask-three', kind: 'ask' as const, taskId: 'read-section-three' },
          { id: 'expose-portrait', kind: 'expose' as const, itemId: 'portrait' },
          { id: 'ask-portrait', kind: 'ask' as const, taskId: 'image-fit' },
          { id: 'ask-portrait-again', kind: 'ask' as const, taskId: 'image-confirmed' },
          { id: 'ask-described', kind: 'ask' as const, taskId: 'image-described' },
          { id: 'expose-four', kind: 'expose' as const, itemId: 'section-four' },
          { id: 'ask-four', kind: 'ask' as const, taskId: 'read-section-four' },
          { id: 'complete', kind: 'terminal' as const, outcome: 'completed' },
          { id: 'left', kind: 'terminal' as const, outcome: 'left' },
        ], transitions: [
          { fromNodeId: 'expose-three', toNodeId: 'ask-three' },
          { fromNodeId: 'ask-three', optionId: 'continue', toNodeId: 'expose-portrait' },
          { fromNodeId: 'ask-three', optionId: 'leave', toNodeId: 'left' },
          { fromNodeId: 'expose-portrait', toNodeId: 'ask-portrait' },
          { fromNodeId: 'ask-portrait', optionId: 'yes', toNodeId: 'ask-portrait-again' },
          { fromNodeId: 'ask-portrait', optionId: 'no', toNodeId: 'ask-portrait-again' },
          { fromNodeId: 'ask-portrait-again', optionId: 'yes', toNodeId: 'ask-described' },
          { fromNodeId: 'ask-portrait-again', optionId: 'no', toNodeId: 'ask-described' },
          { fromNodeId: 'ask-described', optionId: 'yes', toNodeId: 'expose-four' },
          { fromNodeId: 'ask-described', optionId: 'no', toNodeId: 'expose-four' },
          { fromNodeId: 'expose-four', toNodeId: 'ask-four' },
          { fromNodeId: 'ask-four', optionId: 'continue', toNodeId: 'complete' },
          { fromNodeId: 'ask-four', optionId: 'leave', toNodeId: 'left' },
        ] },
      },
      provider: config, maxCalls: 6,
    };
    const admission = await prepareRun(journey, new ClefProvider(config, fetch, { credentialStore: credentials, imageResolver }));
    assert.ok(admission.journey, JSON.stringify(admission.inspection.problems));
    const accepted = fixture.store.acceptJourney(randomUUID(), materializeJourneyRun(admission.journey));
    let call = 0;
    const fetchRequest = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as typeof bodies[number]);
      const current = call++;
      const id = ['read-section-three', 'image-fit', 'image-confirmed', 'image-described', 'read-section-four'][Math.min(current, 4)]!;
      if (current === 4) return Response.json({ success: false }, { status: 403 });
      const choice = id.startsWith('image-') ? 'yes' : 'continue';
      const options = id.startsWith('image-') ? ['yes', 'no'] : ['continue', 'leave'];
      return Response.json({ success: true, result: { model: 'clef', answers: { [id]: { type: 'choice', choice, probabilities: { [options[0]!]: 0.9, [options[1]!]: 0.1 } } }, usage: { input_tokens: 40, output_tokens: 0 } }, errors: [], messages: [] });
    }) as typeof fetch;
    const providerFactory = (_config: unknown, options?: { imageResolver?: typeof imageResolver }) => new ClefProvider(config, fetchRequest,
      { credentialStore: credentials, ...(options?.imageResolver ? { imageResolver: options.imageResolver } : {}) });
    await executeQuestionRun(splitRunStore(fixture.store), accepted.run.runId, providerFactory, { imageResolver });
    assert.equal(bodies.length, 5);
    assert.equal(fixture.store.answers(accepted.run.runId).items.find(({ questionId }) => questionId === 'image-fit')?.status, 'answered');
    assert.equal(fixture.store.getStatus(accepted.run.runId).status, 'failed');
    assert.equal(fixture.store.resume(accepted.run.runId, Date.now()).started, true);
    await executeQuestionRun(splitRunStore(fixture.store), accepted.run.runId, providerFactory, { imageResolver });
    assert.equal(bodies.length, 6);
    assert.deepEqual(bodies.map(({ images }) => images?.length ?? 0), [0, 1, 1, 0, 0, 0]);
    assert.deepEqual(bodies[0]?.state.visualMaterials, undefined);
    assert.equal(JSON.stringify(bodies[1]?.state).includes('A determined specialist'), false);
    const repeatedPixelState = bodies[2]?.state as { visualMaterials: Array<Record<string, unknown>>; trajectory: { responses: Array<Record<string, unknown>> } };
    assert.equal(repeatedPixelState.visualMaterials[0]?.altText, undefined);
    assert.equal((repeatedPixelState.trajectory.responses[1]?.visualEvidence as { materials: Array<{ altText: string }> }).materials[0]?.altText, 'A determined specialist in a teal coat checks a ledger.');
    assert.deepEqual(bodies[3]?.images, undefined);
    assert.equal((bodies[3]?.state as { visualMaterials: Array<Record<string, unknown>> }).visualMaterials[0]?.altText, 'A determined specialist in a teal coat checks a ledger.');
    assert.equal(bodies[4]?.state.visualMaterials, undefined);
    assert.equal(bodies[5]?.state.visualMaterials, undefined);
    const state = bodies[4]?.state as { materialOrder: string[]; encounteredItems: Array<{ id: string; text: string }>; trajectory: { responses: Array<Record<string, unknown>> } };
    assert.deepEqual(state.materialOrder, ['section-three', 'portrait', 'section-four']);
    assert.deepEqual(state.encounteredItems.map(({ id }) => id), ['section-three', 'section-four']);
    assert.deepEqual(state.trajectory.responses[1]?.visualEvidence, {
      mode: 'pixels', provider: 'clef', model: 'clef', materials: [{ materialId: 'portrait', assetId: fixture.metadata.assetId,
        sha256: fixture.metadata.sha256, altText: 'A determined specialist in a teal coat checks a ledger.', caption: 'Writ prepares the records.' }],
    });
    assert.equal(state.trajectory.responses[1]?.choiceId, 'yes');
    assert.equal(((state.trajectory.responses[2]?.visualEvidence as { materials: Array<{ materialId: string }> }).materials[0]?.materialId), 'portrait');
    assert.equal(state.trajectory.responses[2]?.choiceId, 'yes');
    assert.equal(((state.trajectory.responses[3]?.visualEvidence as { mode: string })?.mode), 'described');
    assert.equal(state.trajectory.responses[3]?.choiceId, 'yes');
    const resumedState = bodies[5]?.state as { trajectory: { responses: Array<Record<string, unknown>> } };
    assert.deepEqual(resumedState.trajectory.responses, state.trajectory.responses);
    const persistedEvents = fixture.store.getJourneyRun(accepted.run.runId).respondents[0]?.events ?? [];
    assert.deepEqual(persistedEvents.map(({ type }) => type), ['exposure', 'response', 'exposure', 'visual-response', 'visual-response', 'visual-response', 'exposure', 'response']);
    const visualEvents = persistedEvents.filter((event) => event.type === 'visual-response');
    assert.deepEqual(visualEvents, [{
      type: 'visual-response', sequence: 3, nodeId: 'ask-portrait', taskId: 'image-fit', result: { type: 'choice', choice: 'yes', probabilities: { yes: 0.9, no: 0.1 } },
      visualEvidence: { mode: 'pixels', provider: 'clef', model: 'clef', materials: [{ materialId: 'portrait', assetId: fixture.metadata.assetId,
        sha256: fixture.metadata.sha256, altText: 'A determined specialist in a teal coat checks a ledger.', caption: 'Writ prepares the records.' }] },
    }, {
      type: 'visual-response', sequence: 4, nodeId: 'ask-portrait-again', taskId: 'image-confirmed', result: { type: 'choice', choice: 'yes', probabilities: { yes: 0.9, no: 0.1 } },
      visualEvidence: { mode: 'pixels', provider: 'clef', model: 'clef', materials: [{ materialId: 'portrait', assetId: fixture.metadata.assetId,
        sha256: fixture.metadata.sha256, altText: 'A determined specialist in a teal coat checks a ledger.', caption: 'Writ prepares the records.' }] },
    }, {
      type: 'visual-response', sequence: 5, nodeId: 'ask-described', taskId: 'image-described', result: { type: 'choice', choice: 'yes', probabilities: { yes: 0.9, no: 0.1 } },
      visualEvidence: { mode: 'described', provider: 'clef', model: 'clef', materials: [{ materialId: 'portrait', assetId: fixture.metadata.assetId,
        sha256: fixture.metadata.sha256, altText: 'A determined specialist in a teal coat checks a ledger.', caption: 'Writ prepares the records.' }] },
    }]);

    const tamperAdmission = await prepareRun(journey, new ClefProvider(config, fetch, { credentialStore: credentials, imageResolver }));
    assert.ok(tamperAdmission.journey);
    const tamperRun = fixture.store.acceptJourney(randomUUID(), materializeJourneyRun(tamperAdmission.journey));
    let tamperDispatches = 0;
    const tamperFetch = (async () => {
      const current = tamperDispatches++;
      const id = current === 0 ? 'read-section-three' : 'image-fit';
      const choice = current === 0 ? 'continue' : 'yes';
      const options = current === 0 ? ['continue', 'leave'] : ['yes', 'no'];
      return Response.json({ success: true, result: { model: 'clef', answers: { [id]: { type: 'choice', choice, probabilities: { [options[0]!]: 0.9, [options[1]!]: 0.1 } } }, usage: { input_tokens: 40, output_tokens: 0 } }, errors: [], messages: [] });
    }) as typeof fetch;
    const persistence = splitRunStore(fixture.store);
    const commands = persistence.commands;
    let tamperedTransitions = 0;
    const checkedCommands = new Proxy(commands, { get(target, property, receiver) {
      if (property === 'settleJourney') return (...args: Parameters<typeof commands.settleJourney>) => {
        const [claim, attemptId, outcome, transition] = args;
        if (transition.state.events.some((event) => event.type === 'visual-response')) tamperedTransitions += 1;
        const alteredState = { ...transition.state, events: transition.state.events.map((event) => event.type === 'visual-response'
          ? { ...event, visualEvidence: { ...event.visualEvidence, materials: event.visualEvidence.materials.map((material) => ({ ...material, altText: 'Altered after dispatch.' })) } }
          : event) };
        const nextEvaluation = transition.nextEvaluation && alteredState.events.some((event) => event.type === 'visual-response') ? (() => {
          const request = tamperAdmission.journey!.request;
          const respondent = request.respondents.find(({ id }) => id === transition.state.respondentId)!;
          const packet = compileDecisionPacketForCompiler(request.journey, respondent, transition.nextEvaluation!.questionId,
            alteredState.events, tamperAdmission.journey!.compilerFingerprint);
          return { ...transition.nextEvaluation!, packet, packetFingerprint: hashCanonical({ packet, compilerFingerprint: tamperAdmission.journey!.compilerFingerprint }) };
        })() : transition.nextEvaluation;
        return commands.settleJourney(claim, attemptId, outcome, { ...transition, state: alteredState, ...(nextEvaluation ? { nextEvaluation } : {}) });
      };
      return Reflect.get(target, property, receiver) as unknown;
    } });
    await executeQuestionRun({ ...persistence, commands: checkedCommands }, tamperRun.run.runId, (_config, options) => new ClefProvider(config, tamperFetch,
      { credentialStore: credentials, ...(options?.imageResolver ? { imageResolver: options.imageResolver } : {}) }), { imageResolver });
    const rejectedEvidence = fixture.store.getJourneyRun(tamperRun.run.runId);
    assert.equal(tamperDispatches, 2);
    assert.equal(tamperedTransitions, 1);
    assert.equal(rejectedEvidence.respondents[0]?.events.some(({ type }) => type === 'visual-response'), false);
    assert.equal(rejectedEvidence.evaluations.find(({ questionId }) => questionId === 'image-fit')?.status, 'failed');
  } finally { await fixture.close(); }
});

test('an insertion failure after evaluation rows rolls back the run and visual asset links', async () => {
  const fixture = await setup();
  const database = new DatabaseSync(path.join(fixture.root, 'runs.sqlite'));
  try {
    database.exec("CREATE TRIGGER fail_visual_reference BEFORE INSERT ON run_visual_assets BEGIN SELECT RAISE(ABORT, 'forced visual reference failure'); END");
    assert.throws(() => fixture.store.accept(randomUUID(), fixture.prepared), (error: unknown) => {
      const cause = error instanceof Error && 'cause' in error ? error.cause : undefined;
      return cause instanceof Error && cause.message === 'forced visual reference failure';
    });
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM runs').get() as { count: number }).count, 0);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM evaluations').get() as { count: number }).count, 0);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM run_visual_assets').get() as { count: number }).count, 0);
    assert.deepEqual(Buffer.from(fixture.imageRepository.bytes(fixture.metadata.assetId)), fixture.bytes);
  } finally { database.close(); await fixture.close(); }
});
