import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { archetypeLibrarySchema, cohortSchema, readerArchetypeSchema, readerProfileSchema } from '../src/domain/readers/profile.js';
import { manifestSchema } from '../src/domain/study/manifest.js';

const contractDirectory = resolve('skills/simulated-reader-polling/assets');

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
    filename: 'reader-archetype-library.schema.json',
    title: 'Reader archetype library',
    schema: archetypeLibrarySchema,
    validationRules: [
      'Archetype IDs are unique within a library.',
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
      'Archetype IDs are unique within the cohort snapshot.',
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
      'Every decision criteria object contains at least one choice.',
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
  if (contract.filename === 'study-manifest.schema.json') {
    const properties = schema.properties as Record<string, unknown>;
    const decisions = properties.decisions as { items: { properties: Record<string, Record<string, unknown>> } };
    const criteria = decisions.items.properties.criteria;
    if (!criteria) throw new Error('Study manifest schema is missing decision criteria.');
    criteria.minProperties = 1;
  }
  schema.$id = `https://schemas.system-one-polling.dev/${contract.filename}`;
  schema.title = contract.title;
  if (contract.validationRules) schema['x-validation-rules'] = contract.validationRules;
  await writeFile(resolve(contractDirectory, contract.filename), `${JSON.stringify(schema, null, 2)}\n`);
}
