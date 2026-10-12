import assert from 'node:assert/strict';
import test from 'node:test';
import { ImageAssetError, ImageMetadataSchema, ImageSourceSchema, ScaleRequestSchema } from '../src/domain/assets/image.js';

test('accepts only immutable asset references or digest-verified local sources', () => {
  assert.deepEqual(ImageSourceSchema.parse({ path: 'C:/art/portrait.png', sha256: 'a'.repeat(64) }), { path: 'C:/art/portrait.png', sha256: 'a'.repeat(64) });
  assert.deepEqual(ImageSourceSchema.parse({ assetId: `sha256:${'b'.repeat(64)}` }), { assetId: `sha256:${'b'.repeat(64)}` });
  assert.equal(ImageSourceSchema.safeParse({ path: 'portrait.png' }).success, false);
  assert.equal(ImageSourceSchema.safeParse({ path: 'portrait.png', sha256: 'a'.repeat(64), assetId: `sha256:${'b'.repeat(64)}` }).success, false);
});

test('requires positive integer scaling targets and rejects edits outside the scaler contract', () => {
  assert.deepEqual(ScaleRequestSchema.parse({ source: { assetId: `sha256:${'c'.repeat(64)}` }, maxWidth: 512 }), { source: { assetId: `sha256:${'c'.repeat(64)}` }, maxWidth: 512 });
  assert.equal(ScaleRequestSchema.safeParse({ source: { assetId: `sha256:${'c'.repeat(64)}` }, maxWidth: 0 }).success, false);
  assert.equal(ScaleRequestSchema.safeParse({ source: { assetId: `sha256:${'c'.repeat(64)}` }, crop: true }).success, false);
  assert.equal(ImageMetadataSchema.safeParse({ assetId: `sha256:${'d'.repeat(64)}`, sha256: 'd'.repeat(64), format: 'gif', width: 1, height: 1, bytes: 1 }).success, false);
  assert.equal(ImageMetadataSchema.safeParse({ assetId: `sha256:${'d'.repeat(64)}`, sha256: 'd'.repeat(64), format: 'png', width: 5_000, height: 5_000, bytes: 1 }).success, false);
});

test('image errors expose bounded stable codes and messages', () => {
  const error = new ImageAssetError('image_decode_failed', 'Image content could not be decoded.');
  assert.equal(error.code, 'image_decode_failed');
  assert.equal(error.message.includes('secret-pixels'), false);
});
