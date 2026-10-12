import type { ImageMetadata } from '../domain/assets/image.js';

export type ImageScaling = { width: number; height: number; algorithm: 'lanczos3'; policyVersion: 1 };
export type PreparedImageAssets = { source: ImageMetadata; candidate: ImageMetadata; scaling: ImageScaling };
export type ImageAssetRepository = {
  metadata(assetId: string): ImageMetadata;
  bytes(assetId: string): Uint8Array;
  saveSource(bytes: Uint8Array, metadata: ImageMetadata): ImageMetadata;
  savePrepared(sourceBytes: Uint8Array, source: ImageMetadata, candidateBytes: Uint8Array, candidate: ImageMetadata, scaling: ImageScaling): PreparedImageAssets;
  close(): void;
};
