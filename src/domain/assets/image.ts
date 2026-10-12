import { z } from 'zod';

export const IMAGE_FORMATS = ['png', 'jpeg', 'webp'] as const;
export const ImageFormatSchema = z.enum(IMAGE_FORMATS);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const assetId = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const ImageSourceSchema = z.union([
  z.object({ path: z.string().min(1), sha256: digest }).strict(),
  z.object({ assetId }).strict(),
]);
export const ImageImportRequestSchema = z.object({ source: ImageSourceSchema }).strict();
export const ImageGetRequestSchema = z.object({ assetId, export: z.boolean().optional() }).strict();

export const ImageMetadataSchema = z.object({
  assetId,
  sha256: digest,
  format: ImageFormatSchema,
  width: z.number().int().positive().max(16_000_000),
  height: z.number().int().positive().max(16_000_000),
  bytes: z.number().int().positive().max(16 * 1024 * 1024),
}).strict().refine((metadata) => metadata.width * metadata.height <= 16_000_000, {
  message: 'Image dimensions exceed the 16 megapixel limit.',
});

export const ScaleRequestSchema = z.object({
  source: ImageSourceSchema,
  maxWidth: z.number().int().positive().optional(),
  maxHeight: z.number().int().positive().optional(),
  maxBytes: z.number().int().positive().optional(),
}).strict().refine((request) => request.maxWidth !== undefined || request.maxHeight !== undefined || request.maxBytes !== undefined, {
  message: 'At least one image target is required.',
});

export const IMAGE_ASSET_ERROR_CODES = [
  'image_digest_mismatch', 'image_format_unsupported', 'image_animation_unsupported', 'image_decode_failed',
  'image_source_limit', 'image_source_path_invalid', 'image_scale_target_unreachable', 'image_asset_not_found', 'image_codec_unavailable', 'image_export_failed',
] as const;
export type ImageAssetErrorCode = typeof IMAGE_ASSET_ERROR_CODES[number];

export class ImageAssetError extends Error {
  constructor(readonly code: ImageAssetErrorCode, message: string) {
    super(message);
    this.name = 'ImageAssetError';
  }
}

export type ImageFormat = z.infer<typeof ImageFormatSchema>;
export type ImageSource = z.infer<typeof ImageSourceSchema>;
export type ImageMetadata = z.infer<typeof ImageMetadataSchema>;
export type ScaleRequest = z.infer<typeof ScaleRequestSchema>;
