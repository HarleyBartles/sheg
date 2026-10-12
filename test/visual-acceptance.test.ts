import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { materializeJourneyRun, prepareRun } from '../src/application/run-inspection.js';
import { ClefProvider } from '../src/providers/clef.js';
import { openImageAssetRepository } from '../src/infrastructure/sqlite/image-assets.js';
import { openRunStore } from '../src/infrastructure/run-store.js';

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
