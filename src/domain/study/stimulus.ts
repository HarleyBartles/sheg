import { z } from 'zod';

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const prose = z.string().trim().min(1);

export const sourceReferenceSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f\d]{64}$/i),
}).strict();

export const stimulusItemSchema = z.object({
  id: identifier,
  text: prose,
}).strict();

export type SourceReference = z.infer<typeof sourceReferenceSchema>;
export type StimulusItem = z.infer<typeof stimulusItemSchema>;
