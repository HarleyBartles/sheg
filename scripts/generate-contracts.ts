import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { respondentArchetypeLibrarySchema, respondentArchetypeSchema } from '../src/domain/respondents/archetype.js';
import { respondentCohortSchema } from '../src/domain/respondents/cohort.js';
import { respondentProfileSchema } from '../src/domain/respondents/profile.js';
import { runRequestSchema } from '../src/domain/run/request.js';
import { studyManifestSchema } from '../src/domain/study/study.js';
import { ImageGetRequestSchema, ImageImportRequestSchema, ScaleRequestSchema } from '../src/domain/assets/image.js';
import { providerCredentialRequestSchema } from '../src/application/provider-credentials.js';
import { providerSettingsOperationSchema } from '../src/application/provider-settings.js';

const contractDirectory = resolve('skills/stimulus-response-polling/assets');
const schemaBaseUri = 'urn:sheg:schema:';
const contracts: Array<{ filename: string; title: string; schema: z.ZodType; validationRules?: string[] }> = [
  { filename: 'run-request.schema.json', title: 'Sheg run request', schema: runRequestSchema, validationRules: [
    'Use kind poll or kind follow-on for one or more independent Choice, Score, or Noul questions over each shared respondent context. Use kind journey for a finite sequence or terminating graph of dependent typed asks.',
    'Respondent, material, item, task, and graph node IDs must be unique within their request scope.',
    'maxCalls must cover the minimum reachable journey path; a lower cap than the maximum can leave a run partial.',
    'Material text is preserved exactly as authored.',
    'A follow-on selects one source run by explicit evidence criteria or exact evaluation/context references.',
    'Fresh-material and omit-history follow-ons require explicit material; omit-history removes prior trajectory and exposure-order metadata.',
    'Continue requires a selected completed answer and retains it in the next respondent trajectory.',
    'Automatic routing requires providerSelection: {} and at least one enabled compatible entry in Sheg provider settings; otherwise use an explicit provider configuration. Preferences, unit overrides, comparison locks, and batching are per-study controls.',
    'A Choice option may map to an image only when that exact image is bound to the question for pixel input; image mappings guide visual option identity and do not produce text selectedMaterial evidence.',
  ] },
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
    'Typed comparisons require matching task meanings.',
  ] },
  { filename: 'image-import-request.schema.json', title: 'Sheg image import request', schema: ImageImportRequestSchema, validationRules: [
    'MCP file sources use absolute paths; CLI file sources resolve relative to the JSON request file.',
    'Import validates static image content and stores exact source bytes without calling a model.',
  ] },
  { filename: 'image-scale-request.schema.json', title: 'Sheg image scale request', schema: ScaleRequestSchema, validationRules: [
    'A file source includes its expected SHA-256 digest; saved asset references use Sheg custody.',
    'maxBytes constrains only the prepared image bytes and does not guarantee inference context fit.',
    'Scaling preserves format and image content with proportional dimensions; it does not crop or tune quality.',
  ] },
  { filename: 'image-get-request.schema.json', title: 'Sheg image inspection request', schema: ImageGetRequestSchema, validationRules: [
    'Metadata reads do not scale or export; set export true to explicitly request a local preview path.',
  ] },
  { filename: 'provider-credential-request.schema.json', title: 'Sheg provider credential operation', schema: providerCredentialRequestSchema, validationRules: [
    'Credential status, setup, and removal accept only a provider route and operation; secret values and endpoint overrides are not request fields.',
    'Clef credentials use Sheg/Clef/Cloudflare in Windows Credential Manager.',
  ] },
  { filename: 'provider-settings-operation.schema.json', title: 'Sheg provider settings operation', schema: providerSettingsOperationSchema, validationRules: [
    'Settings operations read or replace enabled provider configurations and preference order under optimistic revision control.',
    'Provider API keys are not accepted or returned; use provider-credential for secure credential operations.',
  ] },
];
await rm(contractDirectory, { recursive: true, force: true });
await mkdir(contractDirectory, { recursive: true });
for (const contract of contracts) {
  // Emit the accepted JSON input contract. Runtime schemas may normalize legacy
  // input with Zod transforms, which are intentionally not part of JSON Schema.
  const schema = z.toJSONSchema(contract.schema, { io: 'input' }) as Record<string, unknown>;
  if (contract.filename === 'run-request.schema.json' || contract.filename === 'study-manifest.schema.json') annotateChoiceOptions(schema);
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
    schema.description = 'JSON Schema validators do not enforce the aggregate 1,500-character prose limit in x-validation-rules. Include the profile in a direct request; optionally call run_inspect for a fit preview. run_start performs Sheg runtime validation.';
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
