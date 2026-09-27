import { z } from 'zod';
import { StudyInputError } from '../errors.js';

const idSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const proseSchema = z.string().trim().min(1).max(500);

export const readerArchetypeSchema = z.object({
  id: idSchema,
  name: proseSchema,
  arrival_intent: proseSchema,
  background: proseSchema,
  desired_payoff: proseSchema,
  drawn_in_by: proseSchema,
  put_off_by: proseSchema,
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

export const archetypeLibrarySchema = z.array(readerArchetypeSchema).min(1).superRefine((archetypes, context) => {
  const ids = archetypes.map((archetype) => archetype.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', message: 'Archetype IDs must be unique in a library.' });
  }
});

export const readerProfileSchema = z.object({
  id: idSchema,
  archetypeId: idSchema.optional(),
  variation: z.record(idSchema, idSchema).optional(),
  arrival_intent: proseSchema,
  background: proseSchema,
  desired_payoff: proseSchema,
  drawn_in_by: proseSchema,
  put_off_by: proseSchema,
}).strict();

export const cohortSchema = z.object({
  version: z.literal('2.0'),
  archetypes: archetypeLibrarySchema.optional(),
  readers: z.array(readerProfileSchema).min(1),
  admission: z.object({
    rationale: z.string().trim().min(1),
    frozenAt: z.string().datetime({ offset: true }),
  }).strict(),
}).strict().superRefine((cohort, context) => {
  const readerIds = cohort.readers.map((reader) => reader.id);
  if (new Set(readerIds).size !== readerIds.length) {
    context.addIssue({ code: 'custom', path: ['readers'], message: 'Frozen cohort contains a duplicate reader ID.' });
  }

  const archetypes = new Map((cohort.archetypes ?? []).map((archetype) => [archetype.id, archetype]));
  for (const [readerIndex, reader] of cohort.readers.entries()) {
    if (!reader.archetypeId) {
      if (reader.variation) {
        context.addIssue({ code: 'custom', path: ['readers', readerIndex, 'variation'], message: 'Variation values require an archetype reference.' });
      }
      continue;
    }
    const archetype = archetypes.get(reader.archetypeId);
    if (!archetype) {
      context.addIssue({ code: 'custom', path: ['readers', readerIndex, 'archetypeId'], message: `Unknown archetype: ${reader.archetypeId}.` });
      continue;
    }
    if (!reader.variation) {
      context.addIssue({ code: 'custom', path: ['readers', readerIndex, 'variation'], message: 'Archetype-derived profiles must select a value for every variation axis.' });
      continue;
    }
    const expectedAxes = archetype.variation_axes.map((axis) => axis.id).sort();
    const selectedAxes = Object.keys(reader.variation).sort();
    if (JSON.stringify(expectedAxes) !== JSON.stringify(selectedAxes)) {
      context.addIssue({ code: 'custom', path: ['readers', readerIndex, 'variation'], message: 'Variation selections must cover exactly the archetype variation axes.' });
      continue;
    }
    for (const axis of archetype.variation_axes) {
      const selection = reader.variation[axis.id];
      if (!axis.values.some((value) => value.id === selection)) {
        context.addIssue({ code: 'custom', path: ['readers', readerIndex, 'variation', axis.id], message: `Unknown variation value for axis ${axis.id}.` });
      }
    }
  }
});

export type ReaderArchetype = z.infer<typeof readerArchetypeSchema>;
export type ReaderProfile = z.infer<typeof readerProfileSchema>;
export type ReaderPerspective = Pick<ReaderProfile, 'arrival_intent' | 'background' | 'desired_payoff' | 'drawn_in_by' | 'put_off_by'>;
export type FrozenCohort = { archetypes: readonly ReaderArchetype[]; readers: readonly ReaderProfile[] };

export function loadCohort(input: unknown): FrozenCohort {
  const result = cohortSchema.safeParse(input);
  if (!result.success) {
    throw new StudyInputError(`Frozen cohort is invalid: ${result.error.issues.map((issue) => issue.message).join(' ')}`, { cause: result.error });
  }
  return { archetypes: result.data.archetypes ?? [], readers: result.data.readers };
}

export function loadProfiles(input: unknown): readonly ReaderProfile[] {
  return loadCohort(input).readers;
}
