import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { openImageAssetRepository } from '../src/infrastructure/sqlite/image-assets.js';

const fixture = () => readFile(new URL('./fixtures/images/four-corners-transparent.png', import.meta.url));
function metadata(bytes: Uint8Array, width = 80, height = 40) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { assetId: `sha256:${sha256}`, sha256, format: 'png' as const, width, height, bytes: bytes.byteLength };
}

test('image assets preserve exact bytes across close and reopen, with digest-idempotent storage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-image-assets-'));
  const bytes = await fixture();
  const asset = metadata(bytes);
  let repository: ReturnType<typeof openImageAssetRepository> | undefined;
  let reopened: ReturnType<typeof openImageAssetRepository> | undefined;
  try {
    repository = openImageAssetRepository(root);
    assert.deepEqual(repository.saveSource(bytes, asset), asset);
    assert.deepEqual(repository.saveSource(bytes, asset), asset);
    assert.deepEqual(Buffer.from(repository.bytes(asset.assetId)), bytes);
    repository.close();
    reopened = openImageAssetRepository(root);
    assert.deepEqual(reopened.metadata(asset.assetId), asset);
    assert.deepEqual(Buffer.from(reopened.bytes(asset.assetId)), bytes);
    reopened.close();
  } finally { reopened?.close(); repository?.close(); await rm(root, { recursive: true, force: true }); }
});

test('rejects conflicting metadata and missing immutable asset references', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-image-assets-'));
  const bytes = await fixture();
  const asset = metadata(bytes);
  let repository: ReturnType<typeof openImageAssetRepository> | undefined;
  try {
    const repo = openImageAssetRepository(root);
    repository = repo;
    repo.saveSource(bytes, asset);
    assert.throws(() => repo.saveSource(bytes, metadata(bytes, 79)));
    assert.throws(() => repo.metadata(`sha256:${'f'.repeat(64)}`), { code: 'image_asset_not_found' });
    repo.close();
  } finally { repository?.close(); await rm(root, { recursive: true, force: true }); }
});

test('stores a prepared candidate and source lineage as one immutable relation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-image-assets-'));
  const sourceBytes = await fixture();
  const candidateBytes = await readFile(new URL('./fixtures/images/prepared-four-corners.png', import.meta.url));
  const source = metadata(sourceBytes);
  const candidate = metadata(candidateBytes, 40, 20);
  let repository: ReturnType<typeof openImageAssetRepository> | undefined;
  try {
    const repo = openImageAssetRepository(root);
    repository = repo;
    const prepared = repo.savePrepared(sourceBytes, source, candidateBytes, candidate, { width: 40, height: 20, algorithm: 'lanczos3', policyVersion: 1 });
    assert.deepEqual(prepared, { source, candidate, scaling: { width: 40, height: 20, algorithm: 'lanczos3', policyVersion: 1 } });
    assert.deepEqual(repo.savePrepared(sourceBytes, source, candidateBytes, candidate, prepared.scaling), prepared);
    assert.deepEqual(Buffer.from(repo.bytes(source.assetId)), sourceBytes);
    assert.deepEqual(Buffer.from(repo.bytes(candidate.assetId)), candidateBytes);
    repo.close();
  } finally { repository?.close(); await rm(root, { recursive: true, force: true }); }
});

test('rolls back both image assets when derivation persistence fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-image-assets-'));
  const sourceBytes = await fixture();
  const candidateBytes = await readFile(new URL('./fixtures/images/prepared-four-corners.png', import.meta.url));
  const source = metadata(sourceBytes);
  const candidate = metadata(candidateBytes, 40, 20);
  let repository: ReturnType<typeof openImageAssetRepository> | undefined;
  try {
    const repo = openImageAssetRepository(root);
    repository = repo;
    const database = new DatabaseSync(path.join(root, 'runs.sqlite'));
    database.exec("CREATE TRIGGER fail_image_derivation BEFORE INSERT ON image_derivations BEGIN SELECT RAISE(ABORT, 'forced derivation failure'); END");
    database.close();
    assert.throws(() => repo.savePrepared(sourceBytes, source, candidateBytes, candidate, { width: 40, height: 20, algorithm: 'lanczos3', policyVersion: 1 }));
    for (const asset of [source, candidate]) assert.throws(() => repo.metadata(asset.assetId), { code: 'image_asset_not_found' });
    repo.close();
  } finally { repository?.close(); await rm(root, { recursive: true, force: true }); }
});
