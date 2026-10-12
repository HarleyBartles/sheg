import { z } from 'zod';
import { ImageMetadataSchema } from '../assets/image.js';

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const exactText = z.string().min(1).refine((value) => value.trim().length > 0, 'Material text must not be blank.');

export const materialOriginSchema = z.object({
  sourceId: identifier,
  sourceSha256: z.string().regex(/^[a-f\d]{64}$/i),
}).strict();

export const sourceReferenceSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f\d]{64}$/i),
}).strict();

export const stimulusItemSchema = z.object({
  id: identifier,
  text: exactText,
  sourceId: materialOriginSchema.shape.sourceId.optional(),
  sourceSha256: materialOriginSchema.shape.sourceSha256.optional(),
}).strict().superRefine((item, context) => {
  if ((item.sourceId === undefined) !== (item.sourceSha256 === undefined)) {
    context.addIssue({ code: 'custom', path: ['sourceSha256'], message: 'Source identity and digest must be provided together.' });
  }
});

export const imageMaterialSchema = z.object({
  id: identifier,
  type: z.literal('image'),
  text: z.literal('').default(''),
  sourceId: materialOriginSchema.shape.sourceId.optional(),
  sourceSha256: materialOriginSchema.shape.sourceSha256.optional(),
  altText: exactText,
  caption: exactText.optional(),
  asset: ImageMetadataSchema,
}).strict().superRefine((item, context) => {
  if (item.asset.assetId !== `sha256:${item.asset.sha256}`) context.addIssue({ code: 'custom', path: ['asset', 'assetId'], message: 'Image asset ID must match its SHA-256 digest.' });
  if ((item.sourceId === undefined) !== (item.sourceSha256 === undefined)) context.addIssue({ code: 'custom', path: ['sourceSha256'], message: 'Source identity and digest must be provided together.' });
});

export const materialItemSchema = z.union([stimulusItemSchema, imageMaterialSchema]);

export type SourceReference = z.infer<typeof sourceReferenceSchema>;
export type StimulusItem = z.infer<typeof stimulusItemSchema>;
export type MaterialItem = z.infer<typeof materialItemSchema>;
export type ImageMaterial = Extract<MaterialItem, { type: 'image' }>;

export function isImageMaterial(item: MaterialItem): item is ImageMaterial {
  return 'type' in item && item.type === 'image';
}
