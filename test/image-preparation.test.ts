import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createImagePreparationService } from '../src/application/image-preparation.js';
import { createStaticImageCodec, type DecodedImage } from '../src/infrastructure/images/codecs.js';
import { openImageAssetRepository } from '../src/infrastructure/sqlite/image-assets.js';

const fixturePath = new URL('./fixtures/images/four-corners-transparent.png', import.meta.url);
const codec = createStaticImageCodec(path.resolve('dist/codec-assets'));

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-image-preparation-'));
  const sourcePath = path.join(root, 'source.png');
  await copyFile(fixturePath, sourcePath);
  const repository = openImageAssetRepository(path.join(root, 'data'));
  const service = createImagePreparationService(repository, codec, root);
  return { root, sourcePath, repository, service };
}

test('imports exact verified bytes, scales proportionally, and retains source after removal', async () => {
  const state = await setup();
  try {
    const bytes = await readFile(state.sourcePath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const result = await state.service.scale({ source: { path: state.sourcePath, sha256 }, maxWidth: 40 });
    assert.deepEqual([result.candidate.width, result.candidate.height], [40, 20]);
    assert.deepEqual([result.scaling.width, result.scaling.height], [40, 20]);
    await unlink(state.sourcePath);
    assert.deepEqual(Buffer.from(state.repository.bytes(result.source.assetId)), bytes);
    const candidate = await codec.decode(state.repository.bytes(result.candidate.assetId));
    assert.deepEqual([candidate.width, candidate.height], [40, 20]);
    for (const [x, y, expected] of [[5, 5, [255, 0, 0]], [34, 5, [0, 255, 0]], [5, 14, [0, 0, 255]], [34, 14, [255, 255, 0]]] as const) {
      const offset = (y * candidate.width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) assert.ok(Math.abs(candidate.data[offset + channel]! - expected[channel]!) < 20);
    }
    assert.equal(state.service.get(result.source.assetId).sha256, sha256);
  } finally { state.repository.close(); await rm(state.root, { recursive: true, force: true }); }
});

test('scales to the integer dimensions from one proportional fit factor', async () => {
  const state = await setup();
  try {
    const bytes = await readFile(state.sourcePath);
    const result = await state.service.scale({ source: { path: state.sourcePath, sha256: createHash('sha256').update(bytes).digest('hex') }, maxWidth: 37 });
    assert.deepEqual([result.candidate.width, result.candidate.height], [37, 18]);
    assert.ok(result.candidate.width <= 37 && result.candidate.height <= 40);
  } finally { state.repository.close(); await rm(state.root, { recursive: true, force: true }); }
});

test('scales a non-integer aspect ratio to the largest bounded candidate and retains the full frame', async () => {
  const state = await setup();
  try {
    const width = 41;
    const height = 29;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const color = x < width / 2 ? (y < height / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255])
        : (y < height / 2 ? [0, 255, 0, 255] : [255, 255, 0, 255]);
      data.set(color, (y * width + x) * 4);
    }
    const sourceBytes = await codec.encode({ data, width, height, format: 'png', orientation: 1 } satisfies DecodedImage);
    await writeFile(state.sourcePath, sourceBytes);
    const source = await state.service.import({ path: state.sourcePath, sha256: createHash('sha256').update(sourceBytes).digest('hex') });
    const result = await state.service.scale({ source: { assetId: source.assetId }, maxWidth: 20 });
    const candidateBytes = state.repository.bytes(result.candidate.assetId);
    const candidate = await codec.decode(candidateBytes);

    assert.deepEqual([candidate.width, candidate.height], [20, 14]);
    assert.ok(candidate.width <= 20 && candidate.height <= height);
    assert.notEqual(result.candidate.assetId, source.assetId);
    assert.deepEqual(Buffer.from(state.repository.bytes(source.assetId)), Buffer.from(sourceBytes));
    for (const [x, y, expected] of [[2, 2, [255, 0, 0]], [17, 2, [0, 255, 0]], [2, 11, [0, 0, 255]], [17, 11, [255, 255, 0]]] as const) {
      const offset = (y * candidate.width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) assert.ok(Math.abs(candidate.data[offset + channel]! - expected[channel]!) < 30);
    }
  } finally { state.repository.close(); await rm(state.root, { recursive: true, force: true }); }
});

test('wrong source digest and corrupt image leave no assets behind', async () => {
  const state = await setup();
  try {
    const bytes = await readFile(state.sourcePath);
    const good = createHash('sha256').update(bytes).digest('hex');
    await assert.rejects(state.service.import({ path: state.sourcePath, sha256: '0'.repeat(64) }), { code: 'image_digest_mismatch' });
    await writeFile(state.sourcePath, Buffer.from('not an image'));
    const corruptDigest = createHash('sha256').update('not an image').digest('hex');
    await assert.rejects(state.service.import({ path: state.sourcePath, sha256: corruptDigest }), { code: 'image_format_unsupported' });
    assert.throws(() => state.repository.metadata(`sha256:${good}`), { code: 'image_asset_not_found' });
  } finally { state.repository.close(); await rm(state.root, { recursive: true, force: true }); }
});

test('rejects oversized files before image decode or asset persistence', async () => {
  const state = await setup();
  try {
    const oversizedPath = path.join(state.root, 'oversized.png');
    await writeFile(oversizedPath, Buffer.alloc(16 * 1024 * 1024 + 1));
    await assert.rejects(state.service.import({ path: oversizedPath, sha256: '0'.repeat(64) }), { code: 'image_source_limit' });
    assert.throws(() => state.repository.metadata(`sha256:${'0'.repeat(64)}`), { code: 'image_asset_not_found' });
  } finally { state.repository.close(); await rm(state.root, { recursive: true, force: true }); }
});

test('reports a missing image source as a bounded input error', async () => {
  const state = await setup();
  try {
    await assert.rejects(state.service.import({ path: path.join(state.root, 'missing-private-name.jpeg'), sha256: '0'.repeat(64) }), {
      code: 'image_source_path_invalid',
      message: 'The image source file could not be read.',
    });
  } finally { state.repository.close(); await rm(state.root, { recursive: true, force: true }); }
});

test('does not upscale or re-encode an already fitting saved image', async () => {
  const state = await setup();
  try {
    const bytes = await readFile(state.sourcePath);
    const imported = await state.service.import({ path: state.sourcePath, sha256: createHash('sha256').update(bytes).digest('hex') });
    let encodeCalls = 0;
    const guardedCodec = { ...codec, encode: async () => { encodeCalls += 1; throw new Error('no-op unexpectedly encoded'); } };
    const guardedService = createImagePreparationService(state.repository, guardedCodec, state.root);
    const result = await guardedService.scale({ source: { assetId: imported.assetId }, maxWidth: 800, maxHeight: 400 });
    assert.equal(result.changed, false);
    assert.equal(result.candidate.assetId, imported.assetId);
    assert.equal(encodeCalls, 0);
    assert.deepEqual(Buffer.from(state.repository.bytes(imported.assetId)), bytes);
  } finally { state.repository.close(); await rm(state.root, { recursive: true, force: true }); }
});

test('saved references scale after provenance files disappear and use display orientation', async () => {
  const state = await setup();
  try {
    const orientedPath = path.join(state.root, 'oriented.jpeg');
    await writeFile(orientedPath, await readFile(new URL('./fixtures/images/orientation-6.jpeg', import.meta.url)));
    const original = await readFile(orientedPath);
    const imported = await state.service.import({ path: orientedPath, sha256: createHash('sha256').update(original).digest('hex') });
    await unlink(orientedPath);
    const result = await state.service.scale({ source: { assetId: imported.assetId }, maxWidth: 20 });
    assert.deepEqual([result.source.width, result.source.height], [40, 80]);
    assert.deepEqual([result.candidate.width, result.candidate.height], [20, 40]);
    assert.equal(result.candidate.format, 'jpeg');
  } finally { state.repository.close(); await rm(state.root, { recursive: true, force: true }); }
});

test('rejects an unreachable byte target without saving a preparation', async () => {
  const state = await setup();
  try {
    const bytes = await readFile(state.sourcePath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await assert.rejects(state.service.scale({ source: { path: state.sourcePath, sha256 }, maxBytes: 1 }), { code: 'image_scale_target_unreachable' });
    assert.throws(() => state.repository.metadata(`sha256:${sha256}`), { code: 'image_asset_not_found' });
  } finally { state.repository.close(); await rm(state.root, { recursive: true, force: true }); }
});

test('exports only stored assets to a deterministic guarded preview path', async () => {
  const state = await setup();
  try {
    const bytes = await readFile(state.sourcePath);
    const imported = await state.service.import({ path: state.sourcePath, sha256: createHash('sha256').update(bytes).digest('hex') });
    const first = await state.service.export(imported.assetId);
    const second = await state.service.export(imported.assetId);
    assert.equal(first.path, second.path);
    assert.equal(path.dirname(first.path), path.join(state.root, 'asset-previews'));
    assert.deepEqual(Buffer.from(await readFile(first.path)), bytes);
  } finally { state.repository.close(); await rm(state.root, { recursive: true, force: true }); }
});

test('refuses an existing preview symlink without modifying its destination', async (context) => {
  const state = await setup();
  try {
    const bytes = await readFile(state.sourcePath);
    const imported = await state.service.import({ path: state.sourcePath, sha256: createHash('sha256').update(bytes).digest('hex') });
    const previewDirectory = path.join(state.root, 'asset-previews');
    const outside = path.join(state.root, 'outside.png');
    const preview = path.join(previewDirectory, `${imported.sha256}.png`);
    await mkdir(previewDirectory);
    await writeFile(outside, Buffer.from('protected destination'));
    try { await symlink(outside, preview, 'file'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip('This Windows account cannot create filesystem symlinks.'); return; }
      throw error;
    }
    await assert.rejects(state.service.export(imported.assetId), { code: 'image_export_failed' });
    assert.deepEqual(await readFile(outside), Buffer.from('protected destination'));
  } finally { state.repository.close(); await rm(state.root, { recursive: true, force: true }); }
});
