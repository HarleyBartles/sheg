import { z } from 'zod';
import { StudyInputError } from '../errors.js';

const profileSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  archetypeId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  profileText: z.string().trim().min(1).max(500),
}).strict();

const cohortSchema = z.object({
  version: z.literal('1.0'),
  readers: z.array(profileSchema).min(1),
  admission: z.object({
    rationale: z.string().trim().min(1),
    frozenAt: z.string().datetime({ offset: true }),
  }).strict(),
}).strict();

export type ReaderProfile = z.infer<typeof profileSchema>;

export function loadProfiles(input: unknown): readonly ReaderProfile[] {
  const result = cohortSchema.safeParse(input);
  if (!result.success) {
    throw new StudyInputError(`Frozen cohort is invalid: ${result.error.issues.map((issue) => issue.message).join(' ')}`, { cause: result.error });
  }
  const readers = result.data.readers;
  const ids = new Set(readers.map((reader) => reader.id));
  if (ids.size !== readers.length) {
    throw new StudyInputError('Frozen cohort contains a duplicate reader ID.');
  }
  return readers;
}

export function validateCohort(readers: readonly ReaderProfile[], archetypeIds: ReadonlySet<string>): void {
  for (const reader of readers) {
    if (!archetypeIds.has(reader.archetypeId)) {
      throw new StudyInputError(`Reader ${reader.id} uses an unknown archetype: ${reader.archetypeId}.`);
    }
  }
}
