import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ImageAssetRepository } from '../../application/image-assets.js';
import { ImageAssetError, ImageMetadataSchema, type ImageMetadata } from '../../domain/assets/image.js';
import type { SqliteRepositoryContext } from './repository-context.js';
import { createSqliteRepositoryContext } from './repository-context.js';
import { openSqliteConnection } from './connection.js';
import type { SqliteConnection } from './connection.js';
import { RunStoreError } from '../../application/run-store.js';
import { asNumber, asText, type DatabaseRow } from './rows.js';

function imageDigest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

function verifyAsset(bytes: Uint8Array, supplied: ImageMetadata): ImageMetadata {
  const metadata = ImageMetadataSchema.parse(supplied);
  const sha256 = imageDigest(bytes);
  if (metadata.sha256 !== sha256 || metadata.assetId !== `sha256:${sha256}` || metadata.bytes !== bytes.byteLength) {
    throw new ImageAssetError('image_digest_mismatch', 'Image bytes do not match the supplied digest and metadata.');
  }
  return metadata;
}

function rowMetadata(row: DatabaseRow): ImageMetadata {
  const sha256 = asText(row.sha256, 'image SHA-256 digest');
  return ImageMetadataSchema.parse({
    assetId: asText(row.asset_id, 'image asset ID'), sha256,
    format: asText(row.format, 'image format'), width: asNumber(row.width, 'image width'),
    height: asNumber(row.height, 'image height'), bytes: asNumber(row.byte_length, 'image byte length'),
  });
}

function findRow(database: DatabaseSync, assetId: string): DatabaseRow | undefined {
  return database.prepare('SELECT asset_id, sha256, format, width, height, byte_length, content FROM image_assets WHERE asset_id = ?').get(assetId) as DatabaseRow | undefined;
}

function readMetadata(database: DatabaseSync, assetId: string): ImageMetadata {
  const row = findRow(database, assetId);
  if (!row) throw new ImageAssetError('image_asset_not_found', 'The requested image asset is not in Sheg storage.');
  return rowMetadata(row);
}

function saveSourceInside(database: DatabaseSync, bytes: Uint8Array, supplied: ImageMetadata): ImageMetadata {
  const metadata = verifyAsset(bytes, supplied);
  const existing = findRow(database, metadata.assetId);
  if (existing) {
    const saved = rowMetadata(existing);
    const savedBytes = Buffer.from(existing.content as Uint8Array);
    if (JSON.stringify(saved) !== JSON.stringify(metadata) || !savedBytes.equals(Buffer.from(bytes))) {
      throw new ImageAssetError('image_digest_mismatch', 'Image bytes or metadata conflict with an asset already stored for this digest.');
    }
    return saved;
  }
  database.prepare(`INSERT INTO image_assets (asset_id, sha256, format, width, height, byte_length, content)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(metadata.assetId, metadata.sha256, metadata.format, metadata.width, metadata.height, metadata.bytes, Buffer.from(bytes));
  return metadata;
}

export function createImageAssetRepository(context: SqliteRepositoryContext): ImageAssetRepository {
  const database = context.database;
  return {
    metadata(assetId) {
      context.ensureOpen();
      return context.readSnapshot(() => readMetadata(database, assetId));
    },
    bytes(assetId) {
      context.ensureOpen();
      return context.readSnapshot(() => {
        const row = findRow(database, assetId);
        if (!row) throw new ImageAssetError('image_asset_not_found', 'The requested image asset is not in Sheg storage.');
        return Uint8Array.from(Buffer.from(row.content as Uint8Array));
      });
    },
    saveSource(bytes, supplied) {
      context.ensureOpen();
      return context.transaction(() => saveSourceInside(database, bytes, supplied));
    },
    savePrepared(sourceBytes, sourceInput, candidateBytes, candidateInput, scaling) {
      context.ensureOpen();
      const source = verifyAsset(sourceBytes, sourceInput);
      const candidate = verifyAsset(candidateBytes, candidateInput);
      if (source.assetId === candidate.assetId) throw new ImageAssetError('image_scale_target_unreachable', 'An unchanged image does not create a separate derivation.');
      if (!Number.isSafeInteger(scaling.width) || scaling.width < 1 || !Number.isSafeInteger(scaling.height) || scaling.height < 1 || scaling.algorithm !== 'lanczos3' || scaling.policyVersion !== 1) {
        throw new ImageAssetError('image_scale_target_unreachable', 'The image scaling provenance is invalid.');
      }
      return context.transaction(() => {
        saveSourceInside(database, sourceBytes, source);
        saveSourceInside(database, candidateBytes, candidate);
        const existing = database.prepare(`SELECT source_asset_id, width, height, algorithm, policy_version
          FROM image_derivations WHERE candidate_asset_id = ?`).get(candidate.assetId) as DatabaseRow | undefined;
        if (existing) {
          const matches = existing.source_asset_id === source.assetId && asNumber(existing.width, 'image scale width') === scaling.width &&
            asNumber(existing.height, 'image scale height') === scaling.height && existing.algorithm === scaling.algorithm &&
            asNumber(existing.policy_version, 'image policy version') === scaling.policyVersion;
          if (!matches) throw new ImageAssetError('image_digest_mismatch', 'This candidate digest already has a different retained source or scaling history.');
          return { source, candidate, scaling };
        }
        const now = new Date(context.now()).toISOString();
        database.prepare(`INSERT INTO image_derivations (source_asset_id, candidate_asset_id, width, height, algorithm, policy_version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(source.assetId, candidate.assetId, scaling.width, scaling.height, scaling.algorithm, scaling.policyVersion, now);
        return { source, candidate, scaling };
      });
    },
    close() { context.close(); },
  };
}

export function openImageAssetRepository(dataRoot: string): ImageAssetRepository {
  if (!path.isAbsolute(dataRoot)) throw new RunStoreError('datastore_path_invalid', 'The Sheg data directory must be an absolute path.');
  mkdirSync(dataRoot, { recursive: true });
  const databasePath = path.join(dataRoot, 'runs.sqlite');
  const connection: SqliteConnection = openSqliteConnection(databasePath, dataRoot);
  const context = createSqliteRepositoryContext(connection, databasePath, Date.now);
  return createImageAssetRepository(context);
}
