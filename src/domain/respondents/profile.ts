import { z } from 'zod';

const idSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const proseSchema = z.string().trim().min(1).max(500);

export const respondentProfileSchema = z.object({
  id: idSchema,
  archetypeId: idSchema.optional(),
  variation: z.record(idSchema, idSchema).optional(),
  intent: proseSchema,
  context: proseSchema,
  desired_outcome: proseSchema,
  engagement_cues: proseSchema,
  friction_cues: proseSchema,
}).strict();

export type RespondentProfile = z.infer<typeof respondentProfileSchema>;
export type RespondentPerspective = Pick<RespondentProfile, 'intent' | 'context' | 'desired_outcome' | 'engagement_cues' | 'friction_cues'>;
