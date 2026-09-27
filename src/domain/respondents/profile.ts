import { z } from 'zod';
import { StudyInputError } from '../errors.js';
import { archetypeLibrarySchema, type ReaderArchetype } from '../readers/archetype.js';

const idSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const proseSchema = z.string().trim().min(1).max(500);

export const respondentProfileSchema = z.object({
  id: idSchema,
  archetypeId: idSchema.optional(),
  variation: z.record(idSchema, idSchema).optional(),
  arrival_intent: proseSchema,
  background: proseSchema,
  desired_payoff: proseSchema,
  drawn_in_by: proseSchema,
  put_off_by: proseSchema,
}).strict();

export const respondentCohortSchema = z.object({
  version: z.literal('3.0'),
  archetypes: archetypeLibrarySchema.optional(),
  respondents: z.array(respondentProfileSchema).min(1),
  admission: z.object({
    rationale: z.string().trim().min(1),
    frozenAt: z.string().datetime({ offset: true }),
  }).strict().optional(),
}).strict().superRefine((cohort, context) => {
  const respondentIds = cohort.respondents.map((respondent) => respondent.id);
  if (new Set(respondentIds).size !== respondentIds.length) {
    context.addIssue({ code: 'custom', path: ['respondents'], message: 'Frozen cohort contains a duplicate respondent ID.' });
  }

  const archetypes = new Map((cohort.archetypes ?? []).map((archetype) => [archetype.id, archetype]));
  for (const [respondentIndex, respondent] of cohort.respondents.entries()) {
    if (!respondent.archetypeId) {
      if (respondent.variation) {
        context.addIssue({ code: 'custom', path: ['respondents', respondentIndex, 'variation'], message: 'Variation values require an archetype reference.' });
      }
      continue;
    }
    const archetype = archetypes.get(respondent.archetypeId);
    if (!archetype) {
      context.addIssue({ code: 'custom', path: ['respondents', respondentIndex, 'archetypeId'], message: `Unknown archetype: ${respondent.archetypeId}.` });
      continue;
    }
    if (!respondent.variation) {
      context.addIssue({ code: 'custom', path: ['respondents', respondentIndex, 'variation'], message: 'Archetype-derived profiles must select a value for every variation axis.' });
      continue;
    }
    const expectedAxes = archetype.variation_axes.map((axis) => axis.id).sort();
    const selectedAxes = Object.keys(respondent.variation).sort();
    if (JSON.stringify(expectedAxes) !== JSON.stringify(selectedAxes)) {
      context.addIssue({ code: 'custom', path: ['respondents', respondentIndex, 'variation'], message: 'Variation selections must cover exactly the archetype variation axes.' });
      continue;
    }
    for (const axis of archetype.variation_axes) {
      const selection = respondent.variation[axis.id];
      if (!axis.values.some((value) => value.id === selection)) {
        context.addIssue({ code: 'custom', path: ['respondents', respondentIndex, 'variation', axis.id], message: `Unknown variation value for axis ${axis.id}.` });
      }
    }
  }
});

export type RespondentProfile = z.infer<typeof respondentProfileSchema>;
export type RespondentPerspective = Pick<RespondentProfile, 'arrival_intent' | 'background' | 'desired_payoff' | 'drawn_in_by' | 'put_off_by'>;
export type RespondentCohort = { archetypes: readonly ReaderArchetype[]; respondents: readonly RespondentProfile[] };
export type FrozenCohort = RespondentCohort;

export function loadCohort(input: unknown): RespondentCohort {
  const result = respondentCohortSchema.safeParse(input);
  if (!result.success) {
    throw new StudyInputError(`Frozen respondent cohort is invalid: ${result.error.issues.map((issue) => issue.message).join(' ')}`, { cause: result.error });
  }
  return { archetypes: result.data.archetypes ?? [], respondents: result.data.respondents };
}

export function loadRespondents(input: unknown): readonly RespondentProfile[] {
  return loadCohort(input).respondents;
}
