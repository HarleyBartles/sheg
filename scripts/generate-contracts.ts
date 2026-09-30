import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { respondentArchetypeLibrarySchema, respondentArchetypeSchema } from '../src/domain/respondents/archetype.js';
import { respondentCohortSchema } from '../src/domain/respondents/cohort.js';
import { respondentProfileSchema } from '../src/domain/respondents/profile.js';
import { studyManifestSchema } from '../src/domain/study/study.js';

const contractDirectory = resolve('skills/stimulus-response-polling/assets');
const schemaBaseUri = 'urn:sheg:schema:';
const contracts: Array<{ filename: string; title: string; schema: z.ZodType; validationRules?: string[] }> = [
  { filename: 'respondent-archetype.schema.json', title: 'Respondent archetype', schema: respondentArchetypeSchema },
  { filename: 'respondent-archetype-library.schema.json', title: 'Respondent archetype library', schema: respondentArchetypeLibrarySchema },
  { filename: 'respondent-profile.schema.json', title: 'Respondent profile', schema: respondentProfileSchema, validationRules: [
    'Combined profile prose must not exceed 1,500 characters across intent, context, desired_outcome, engagement_cues, and friction_cues.',
  ] },
  { filename: 'respondent-cohort.schema.json', title: 'Frozen respondent cohort', schema: respondentCohortSchema, validationRules: [
    'Respondent IDs are unique within the cohort.', 'Every archetypeId refers to an archetype included in the cohort snapshot.',
    'Archetype-derived respondents select exactly one declared value for every variation axis.',
  ] },
  { filename: 'study-manifest.schema.json', title: 'Study manifest', schema: studyManifestSchema, validationRules: [
    'Each study contains one or more arms, each with its own stimulus, typed tasks, and presentation.',
    'Choice option IDs are stable response values; answer keys are never sent to providers. Score uses an ordered rubric. Noul reports P(true).',
    'Graph transitions cover every Choice option or typed response domain exactly once; all nodes are reachable.',
    'Per-task responseHistory controls prior answer context independently from graph routing and respondent eligibility.',
    'Typed comparisons require matching task meanings; simulated responses are not evidence of human outcomes.',
  ] },
];
await rm(contractDirectory, { recursive: true, force: true });
await mkdir(contractDirectory, { recursive: true });
for (const contract of contracts) {
  // Emit the accepted JSON input contract. Runtime schemas may normalize legacy
  // input with Zod transforms, which are intentionally not part of JSON Schema.
  const schema = z.toJSONSchema(contract.schema, { io: 'input' }) as Record<string, unknown>;
  if (contract.filename === 'study-manifest.schema.json') {
    const arms = (schema.properties as Record<string, { items: { properties: Record<string, { items: unknown }> } }>).arms!;
    const taskVariants = arms.items.properties.tasks!.items;
    annotateChoiceOptions(taskVariants);
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
  if (contract.filename === 'respondent-profile.schema.json') {
    schema.description = 'JSON Schema validators do not enforce the aggregate 1,500-character prose limit in x-validation-rules. Validate the profile with Sheg runtime validation (for example poll_check) before running a study.';
  }
  await writeFile(resolve(contractDirectory, contract.filename), `${JSON.stringify(schema, null, 2)}\n`);
}

function annotateChoiceOptions(value: unknown): void {
  if (Array.isArray(value)) { for (const entry of value) annotateChoiceOptions(entry); return; }
  if (typeof value !== 'object' || value === null) return;
  const object = value as Record<string, unknown>;
  const properties = object.properties;
  if (typeof properties === 'object' && properties !== null) {
    const options = (properties as Record<string, unknown>).options;
    if (typeof options === 'object' && options !== null) (options as Record<string, unknown>).minProperties = 1;
  }
  for (const child of Object.values(object)) annotateChoiceOptions(child);
}
