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
}).strict().superRefine((profile, context) => {
  const proseLength = profile.intent.length + profile.context.length + profile.desired_outcome.length +
    profile.engagement_cues.length + profile.friction_cues.length;
  if (proseLength > 1_500) {
    context.addIssue({
      code: 'custom',
      message: 'Combined profile prose must not exceed 1,500 characters across the five prose fields.',
    });
  }
});

export type RespondentProfile = z.infer<typeof respondentProfileSchema>;
export type RespondentPerspective = Pick<RespondentProfile, 'intent' | 'context' | 'desired_outcome' | 'engagement_cues' | 'friction_cues'>;
