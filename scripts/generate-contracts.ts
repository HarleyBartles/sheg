import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { respondentArchetypeLibrarySchema, respondentArchetypeSchema } from '../src/domain/respondents/archetype.js';
import { respondentCohortSchema } from '../src/domain/respondents/cohort.js';
import { respondentProfileSchema } from '../src/domain/respondents/profile.js';
import { studyManifestSchema } from '../src/domain/study/study.js';

const contractDirectory = resolve('skills/stimulus-response-polling/assets');
const schemaBaseUri = 'https://schemas.system-one-polling.dev/';
const contracts: Array<{ filename: string; title: string; schema: z.ZodType; validationRules?: string[] }> = [
  { filename: 'respondent-archetype.schema.json', title: 'Respondent archetype', schema: respondentArchetypeSchema },
  { filename: 'respondent-archetype-library.schema.json', title: 'Respondent archetype library', schema: respondentArchetypeLibrarySchema },
  { filename: 'respondent-profile.schema.json', title: 'Respondent profile', schema: respondentProfileSchema },
  { filename: 'respondent-cohort.schema.json', title: 'Frozen respondent cohort', schema: respondentCohortSchema, validationRules: [
    'Respondent IDs are unique within the cohort.', 'Every archetypeId refers to an archetype included in the cohort snapshot.',
    'Archetype-derived respondents select exactly one declared value for every variation axis.',
  ] },
  { filename: 'study-manifest.schema.json', title: 'Study manifest', schema: studyManifestSchema, validationRules: [
    'Each study contains one or more arms, each with its own stimulus, tasks, and presentation.',
    'Task option IDs are stable response values; answer keys are never sent to providers.',
    'Graph transitions cover every offered option exactly once; all nodes are reachable.',
    'A/B comparisons are restricted to arms within one run and align on comparisonKey and occurrence.',
  ] },
];
await rm(contractDirectory, { recursive: true, force: true });
await mkdir(contractDirectory, { recursive: true });
for (const contract of contracts) {
  const schema = z.toJSONSchema(contract.schema) as Record<string, unknown>;
  if (contract.filename === 'study-manifest.schema.json') {
    const properties = schema.properties as Record<string, unknown>;
    const arms = properties.arms as { items: { properties: Record<string, unknown> } };
    const tasks = arms.items.properties.tasks as { items: { properties: Record<string, unknown> } };
    const options = tasks.items.properties.options as Record<string, unknown>;
    options.minProperties = 1;
  }
  schema.$id = `${schemaBaseUri}${contract.filename}`;
  if (contract.filename === 'respondent-archetype-library.schema.json') {
    schema.items = { $ref: `${schemaBaseUri}respondent-archetype.schema.json` };
  }
  if (contract.filename === 'respondent-cohort.schema.json') {
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    properties.archetypes = { $ref: `${schemaBaseUri}respondent-archetype-library.schema.json` };
    (properties.respondents as { items: Record<string, unknown> }).items = { $ref: `${schemaBaseUri}respondent-profile.schema.json` };
  }
  schema.title = contract.title;
  if (contract.validationRules) schema['x-validation-rules'] = contract.validationRules;
  await writeFile(resolve(contractDirectory, contract.filename), `${JSON.stringify(schema, null, 2)}\n`);
}
