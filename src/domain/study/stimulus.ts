import { z } from 'zod';

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

export type SourceReference = z.infer<typeof sourceReferenceSchema>;
export type StimulusItem = z.infer<typeof stimulusItemSchema>;
