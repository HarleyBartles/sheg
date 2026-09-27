import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { cohortSchema, readerArchetypeSchema, readerProfileSchema } from '../src/domain/readers/profile.js';
import { manifestSchema } from '../src/domain/study/manifest.js';

const contractDirectory = resolve('contracts');

const contracts: Array<{ filename: string; title: string; schema: z.ZodType; validationRules?: string[] }> = [
  {
    filename: 'reader-archetype.schema.json',
    title: 'Reader archetype',
    schema: readerArchetypeSchema,
    validationRules: [
      'Variation axis IDs are unique within an archetype.',
      'Variation value IDs are unique within each axis.',
      'Text fields must contain non-whitespace content; surrounding whitespace is trimmed by runtime validation.',
    ],
  },
  {
    filename: 'reader-profile.schema.json',
    title: 'Concrete reader profile',
    schema: readerProfileSchema,
    validationRules: [
      'Text fields must contain non-whitespace content; surrounding whitespace is trimmed by runtime validation.',
    ],
  },
  {
    filename: 'frozen-cohort.schema.json',
    title: 'Frozen reader cohort',
    schema: cohortSchema,
    validationRules: [
      'Text fields must contain non-whitespace content; surrounding whitespace is trimmed by runtime validation.',
      'Reader IDs are unique within the cohort.',
      'Every archetypeId refers to an archetype included in the cohort snapshot.',
      'Profiles without archetypeId cannot include variation selections.',
      'Archetype-derived profiles select exactly one declared value for every variation axis.',
    ],
  },
  {
    filename: 'study-manifest.schema.json',
    title: 'Study manifest',
    schema: manifestSchema,
    validationRules: [
      'Text fields must contain non-whitespace content; surrounding whitespace is trimmed by runtime validation.',
      'Item, decision, and node IDs are unique across the manifest.',
      'The entry node and every node reference resolve.',
      'Terminal nodes have no outgoing transitions.',
      'Exposure nodes have exactly one unconditional transition.',
      'Decision nodes have exactly one transition for every offered choice and no others.',
      'Every node is reachable from the entry node.',
      'Total exposed stimulus text is at most 80 KB.',
    ],
  },
];

await mkdir(contractDirectory, { recursive: true });
for (const contract of contracts) {
  const schema = z.toJSONSchema(contract.schema) as Record<string, unknown>;
  schema.$id = `https://schemas.system-one-polling.dev/${contract.filename}`;
  schema.title = contract.title;
  if (contract.validationRules) schema['x-validation-rules'] = contract.validationRules;
  await writeFile(resolve(contractDirectory, contract.filename), `${JSON.stringify(schema, null, 2)}\n`);
}
