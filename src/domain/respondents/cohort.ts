import { z } from 'zod';
import { StudyInputError } from '../errors.js';
import { respondentArchetypeLibrarySchema, type RespondentArchetype } from './archetype.js';
import { respondentProfileSchema, type RespondentProfile } from './profile.js';

export const respondentCohortSchema = z.object({
  version: z.literal('3.0'),
  archetypes: respondentArchetypeLibrarySchema.optional(),
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

export type RespondentCohort = { archetypes: readonly RespondentArchetype[]; respondents: readonly RespondentProfile[] };
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

