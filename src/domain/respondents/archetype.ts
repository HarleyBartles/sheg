import { z } from 'zod';

const idSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const proseSchema = z.string().trim().min(1).max(500);

export const respondentArchetypeSchema = z.object({
  id: idSchema,
  name: proseSchema,
  intent: proseSchema,
  context: proseSchema,
  desired_outcome: proseSchema,
  engagement_cues: proseSchema,
  friction_cues: proseSchema,
  invariants: z.array(proseSchema).min(2).max(6),
  variation_axes: z.array(z.object({
    id: idSchema,
    description: proseSchema,
    values: z.array(z.object({ id: idSchema, description: proseSchema }).strict()).min(2).max(5),
  }).strict()).min(2).max(4),
}).strict().superRefine((archetype, context) => {
  const axisIds = archetype.variation_axes.map((axis) => axis.id);
  if (new Set(axisIds).size !== axisIds.length) {
    context.addIssue({ code: 'custom', path: ['variation_axes'], message: 'Variation axis IDs must be unique.' });
  }
  for (const [index, axis] of archetype.variation_axes.entries()) {
    const valueIds = axis.values.map((value) => value.id);
    if (new Set(valueIds).size !== valueIds.length) {
      context.addIssue({ code: 'custom', path: ['variation_axes', index, 'values'], message: 'Variation values must have unique IDs within their axis.' });
    }
  }
});

export const respondentArchetypeLibrarySchema = z.array(respondentArchetypeSchema).min(1).superRefine((archetypes, context) => {
  const ids = archetypes.map((archetype) => archetype.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', message: 'Archetype IDs must be unique in a library.' });
  }
});

export type RespondentArchetype = z.infer<typeof respondentArchetypeSchema>;
export type RespondentArchetypeLibrary = z.infer<typeof respondentArchetypeLibrarySchema>;
