import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { ImageAssetError, ImageMetadataSchema, ImageSourceSchema, ScaleRequestSchema, type ImageMetadata, type ImageSource, type ScaleRequest } from '../domain/assets/image.js';
import type { ImageAssetRepository, PreparedImageAssets } from './image-assets.js';
import { exportImageAsset } from '../infrastructure/images/asset-export.js';
import type { DecodedImage, StaticImageCodec } from '../infrastructure/images/codecs.js';

export type ImagePreparationResult = PreparedImageAssets & { changed: boolean };
export type ImagePreparationService = {
  import(source: ImageSource): Promise<ImageMetadata>;
  scale(request: ScaleRequest): Promise<ImagePreparationResult>;
  get(assetId: string): ImageMetadata;
  export(assetId: string): Promise<{ asset: ImageMetadata; path: string }>;
};

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function metadata(bytes: Uint8Array, decoded: DecodedImage): ImageMetadata {
  const sha256 = digest(bytes);
  return ImageMetadataSchema.parse({ assetId: `sha256:${sha256}`, sha256, format: decoded.format, width: decoded.width, height: decoded.height, bytes: bytes.byteLength });
}
function readTarget(source: ImageSource): Promise<Uint8Array> {
  if ('assetId' in source) return Promise.reject(new Error('saved source must be read from repository'));
  return (async () => {
    const handle = await open(source.path, 'r');
    try {
      const limit = 16 * 1024 * 1024;
      const buffer = Buffer.allocUnsafe(limit + 1);
      let offset = 0;
      while (offset < buffer.byteLength) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > limit) throw new ImageAssetError('image_source_limit', 'The image exceeds the 16 MiB encoded image limit.');
      return new Uint8Array(buffer.subarray(0, offset));
    } finally { await handle.close(); }
  })();
}
function scaledDimensions(image: DecodedImage, request: ScaleRequest, factor = 1): { width: number; height: number } {
  const fit = Math.min(1, request.maxWidth === undefined ? 1 : request.maxWidth / image.width,
    request.maxHeight === undefined ? 1 : request.maxHeight / image.height, factor);
  let width = Math.max(1, Math.floor(image.width * fit));
  let height = Math.max(1, Math.floor(image.height * fit));
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const proportional = Math.min(width / image.width, height / image.height);
    const nextWidth = Math.max(1, Math.floor(image.width * proportional));
    const nextHeight = Math.max(1, Math.floor(image.height * proportional));
    if (nextWidth === width && nextHeight === height) break;
    width = nextWidth;
    height = nextHeight;
  }
  return { width, height };
}

export function createImagePreparationService(repository: ImageAssetRepository, codec: StaticImageCodec, exportRoot: string): ImagePreparationService {
  async function verifiedBytes(source: ImageSource): Promise<{ bytes: Uint8Array; expected?: string }> {
    const parsed = ImageSourceSchema.parse(source);
    if ('assetId' in parsed) return { bytes: repository.bytes(parsed.assetId) };
    return { bytes: await readTarget(parsed), expected: parsed.sha256 };
  }
  async function decodeSource(source: ImageSource): Promise<{ bytes: Uint8Array; decoded: DecodedImage; metadata: ImageMetadata }> {
    const result = await verifiedBytes(source);
    const actual = digest(result.bytes);
    if (result.expected !== undefined && actual !== result.expected) throw new ImageAssetError('image_digest_mismatch', 'Image bytes do not match the expected SHA-256 digest.');
    const decoded = await codec.decode(result.bytes);
    if (digest(result.bytes) !== actual) throw new ImageAssetError('image_digest_mismatch', 'Image bytes changed while being prepared.');
    return { ...result, decoded, metadata: metadata(result.bytes, decoded) };
  }
  return {
    async import(source) {
      const parsed = ImageSourceSchema.parse(source);
      if ('assetId' in parsed) return repository.metadata(parsed.assetId);
      const prepared = await decodeSource(parsed);
      return repository.saveSource(prepared.bytes, prepared.metadata);
    },
    async scale(request) {
      const parsed = ScaleRequestSchema.parse(request);
      const source = await decodeSource(parsed.source);
      let dimensions = scaledDimensions(source.decoded, parsed);
      const needsScale = dimensions.width !== source.decoded.width || dimensions.height !== source.decoded.height;
      if (!needsScale && parsed.maxBytes === undefined) {
        const saved = repository.saveSource(source.bytes, source.metadata);
        return { source: saved, candidate: saved, scaling: { width: saved.width, height: saved.height, algorithm: 'lanczos3', policyVersion: 1 }, changed: false };
      }
      if (parsed.maxBytes !== undefined && source.bytes.byteLength <= parsed.maxBytes && !needsScale) {
        const saved = repository.saveSource(source.bytes, source.metadata);
        return { source: saved, candidate: saved, scaling: { width: saved.width, height: saved.height, algorithm: 'lanczos3', policyVersion: 1 }, changed: false };
      }
      let factor = 1;
      let candidateBytes: Uint8Array | undefined;
      let candidateImage: DecodedImage | undefined;
      let attempts = 0;
      const maxAttempts = Math.max(1, Math.ceil(Math.log(Math.max(source.decoded.width, source.decoded.height)) / Math.log(1 / 0.8)) + 2);
      while (attempts < maxAttempts) {
        dimensions = scaledDimensions(source.decoded, parsed, factor);
        const candidate = await codec.scale(source.decoded, dimensions.width, dimensions.height);
        const encoded = await codec.encode(candidate);
        attempts += 1;
        if (parsed.maxBytes === undefined || encoded.byteLength <= parsed.maxBytes) {
          candidateBytes = encoded;
          candidateImage = await codec.decode(encoded);
          break;
        }
        const nextFactor = factor * 0.8;
        const nextDimensions = scaledDimensions(source.decoded, parsed, nextFactor);
        if (nextDimensions.width === dimensions.width && nextDimensions.height === dimensions.height) break;
        factor = nextFactor;
      }
      if (!candidateBytes || !candidateImage || (parsed.maxBytes !== undefined && candidateBytes.byteLength > parsed.maxBytes)) {
        throw new ImageAssetError('image_scale_target_unreachable', 'The requested image byte target cannot be reached without changing format, quality, or content.');
      }
      if (candidateBytes.byteLength === source.bytes.byteLength && digest(candidateBytes) === digest(source.bytes)) {
        const saved = repository.saveSource(source.bytes, source.metadata);
        return { source: saved, candidate: saved, scaling: { width: saved.width, height: saved.height, algorithm: 'lanczos3', policyVersion: 1 }, changed: false };
      }
      if (parsed.maxWidth !== undefined && candidateImage.width > parsed.maxWidth || parsed.maxHeight !== undefined && candidateImage.height > parsed.maxHeight) {
        throw new ImageAssetError('image_scale_target_unreachable', 'The encoded image did not satisfy the requested dimension bounds.');
      }
      const candidateMetadata = metadata(candidateBytes, candidateImage);
      if (candidateMetadata.assetId === source.metadata.assetId) throw new ImageAssetError('image_scale_target_unreachable', 'The requested target did not produce a distinct image candidate.');
      const scaling = { width: candidateImage.width, height: candidateImage.height, algorithm: 'lanczos3' as const, policyVersion: 1 as const };
      const saved = repository.savePrepared(source.bytes, source.metadata, candidateBytes, candidateMetadata, scaling);
      return { ...saved, changed: true };
    },
    get(assetId) { return repository.metadata(assetId); },
    async export(assetId) {
      const asset = repository.metadata(assetId);
      return exportImageAsset(exportRoot, asset, repository.bytes(assetId));
    },
  };
}
