import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { respondentArchetypeLibrarySchema as archetypeLibrarySchema } from '../src/domain/respondents/archetype.js';
import { respondentArchetypeGroups } from '../src/domain/respondents/archetype-catalogue.js';
import { loadCohort } from '../src/domain/respondents/cohort.js';
import { respondentPerspectiveSchema, respondentProfileSchema } from '../src/domain/respondents/profile.js';

const groupUrls = respondentArchetypeGroups.map((group) => new URL(`../src/domain/respondents/archetype-groups/${group.filename}`, import.meta.url));
const schemaAssets = new URL('../skills/stimulus-response-polling/assets/', import.meta.url);

async function archetypeLibrary() {
  const groups = await Promise.all(groupUrls.map(async (url) => archetypeLibrarySchema.parse(JSON.parse(await readFile(url, 'utf8')) as unknown)));
  return groups.flat();
}

function respondent(id: string, archetypeId?: string, variation?: Record<string, string>) {
  return {
    id,
    ...(archetypeId === undefined ? {} : { archetypeId }),
    ...(variation === undefined ? {} : { variation }),
    intent: 'Understand the practical consequence of the subject.',
    context: 'Has adjacent experience but not this specialist context.',
    desired_outcome: 'Leave with a concrete, transferable understanding.',
    engagement_cues: 'Specific examples and visible cause and effect.',
    friction_cues: 'Claims that skip evidence or conceal necessary context.',
  };
}

function admission() {
  return { rationale: 'The perspectives offer distinct starting points.', frozenAt: '2026-09-27T10:00:00Z' };
}

test('the shipped respondent archetype groups follow the contract and have unique IDs', async () => {
  const groups = await Promise.all(groupUrls.map(async (url) => archetypeLibrarySchema.parse(JSON.parse(await readFile(url, 'utf8')) as unknown)));
  const library = groups.flat();
  assert.ok(library.length > 0);
  assert.equal(new Set(library.map((archetype) => archetype.id)).size, library.length);
});

test('published schemas carry constraints that consumers can validate directly', async () => {
  type SchemaNode = { anyOf?: SchemaNode[]; items?: SchemaNode; properties?: Record<string, SchemaNode>; minProperties?: number };
  const runRequest = JSON.parse(await readFile(new URL('run-request.schema.json', schemaAssets), 'utf8')) as SchemaNode;
  const manifest = JSON.parse(await readFile(new URL('study-manifest.schema.json', schemaAssets), 'utf8')) as {
    properties: { arms: { items: { properties: { tasks: { items: { anyOf: Array<{ properties?: { options?: { minProperties?: number } } }> } } } } } };
    'x-validation-rules': string[];
  };
  const cohort = JSON.parse(await readFile(new URL('respondent-cohort.schema.json', schemaAssets), 'utf8')) as {
    'x-validation-rules': string[];
  };
  const profile = JSON.parse(await readFile(new URL('respondent-profile.schema.json', schemaAssets), 'utf8')) as {
    'x-validation-rules': string[];
  };

  const choiceBranches = manifest.properties.arms.items.properties.tasks.items.anyOf.flatMap((branch) => branch.properties?.options ? [branch.properties.options] : []);
  const requestChoiceBranches = runRequest.anyOf?.flatMap((variant) => variant.properties?.questions?.items?.anyOf?.flatMap((branch) => branch.properties?.options ? [branch.properties.options] : []) ?? []) ?? [];
  assert.equal(choiceBranches.length, 1);
  assert.equal(choiceBranches[0]?.minProperties, 1);
  assert.ok(requestChoiceBranches.length > 0);
  assert.ok(requestChoiceBranches.every((options) => options.minProperties === 1));
  assert.ok(manifest['x-validation-rules'].some((rule) => rule.includes('Choice option IDs')));
  assert.ok(cohort['x-validation-rules'].some((rule) => rule.includes('Respondent IDs are unique')));
  assert.ok(profile['x-validation-rules'].some((rule) => rule.includes('1,500 characters')));
});

test('cohort can mix shipped and custom archetypes with concrete varied profiles', async () => {
  const library = await archetypeLibrary();
  const shipped = library.find((item) => item.id === 'curious-outsider');
  assert.ok(shipped);
  const custom = {
    id: 'domain-practitioner',
    name: 'Domain practitioner',
    intent: 'Check whether the account holds up in applied work.',
    context: 'Works directly with the kinds of systems being discussed.',
    desired_outcome: 'Find a credible insight that changes a practical decision.',
    engagement_cues: 'Operational detail and trade-offs made explicit.',
    friction_cues: 'Anecdotes presented as universal evidence.',
    invariants: ['Tests claims against practical experience.', 'Wants constraints and consequences made explicit.'],
    variation_axes: [{
      id: 'practice_depth',
      description: 'How directly the reader works with the subject.',
      values: [
        { id: 'adjacent', description: 'Works alongside this practice.' },
        { id: 'direct', description: 'Performs this practice regularly.' },
      ],
    }, {
      id: 'decision_focus',
      description: 'Which evidence most matters to the reader.',
      values: [
        { id: 'outcomes', description: 'Wants to see observed consequences.' },
        { id: 'mechanism', description: 'Wants to understand the causal mechanism.' },
      ],
    }],
  };
  const cohort = loadCohort({
    version: '3.0',
    archetypes: [shipped, custom],
    respondents: [
      respondent('newcomer', shipped.id, { subject_familiarity: 'newcomer', explanation_tolerance: 'concrete_first' }),
      respondent('practitioner', custom.id, { practice_depth: 'direct', decision_focus: 'mechanism' }),
    ],
    admission: admission(),
  });

  assert.deepEqual(cohort.archetypes.map((item) => item.id), ['curious-outsider', 'domain-practitioner']);
  assert.deepEqual(cohort.respondents.map((item) => item.id), ['newcomer', 'practitioner']);
});

test('direct profiles work without archetypes or archetype lineage', () => {
  const cohort = loadCohort({ version: '3.0', respondents: [respondent('direct-reader')], admission: admission() });
  assert.equal(cohort.archetypes.length, 0);
  assert.equal(cohort.respondents[0]?.archetypeId, undefined);
});

test('enforces an aggregate 1,500-character ceiling across profile prose fields', () => {
  const fieldNames = ['intent', 'context', 'desired_outcome', 'engagement_cues', 'friction_cues'] as const;
  const exactLimit = {
    id: 'bounded-reader',
    ...Object.fromEntries(fieldNames.map((field) => [field, 'x'.repeat(300)])),
  };
  assert.equal(respondentProfileSchema.safeParse(exactLimit).success, true);

  const overLimit = { ...exactLimit, friction_cues: 'x'.repeat(301) };
  assert.equal(respondentProfileSchema.safeParse(overLimit).success, false);
  const perspective = Object.fromEntries(fieldNames.map((field) => [field, 'x'.repeat(300)]));
  assert.equal(respondentPerspectiveSchema.safeParse(perspective).success, true);
  assert.equal(respondentPerspectiveSchema.safeParse({ ...perspective, friction_cues: 'x'.repeat(301) }).success, false);
  assert.equal(respondentPerspectiveSchema.safeParse({ ...perspective, intent: 'x'.repeat(501) }).success, false);
});

test('archetype-derived profiles must select every declared variation axis value', async () => {
  const library = await archetypeLibrary();
  const shipped = library.find((item) => item.id === 'curious-outsider');
  assert.ok(shipped);
  const input = { version: '3.0', archetypes: [shipped], respondents: [respondent('reader-one', shipped.id, { subject_familiarity: 'newcomer' })], admission: admission() };

  assert.throws(() => loadCohort(input), /variation/i);
  input.respondents[0] = respondent('reader-one', shipped.id, { subject_familiarity: 'unknown', explanation_tolerance: 'concrete_first' });
  assert.throws(() => loadCohort(input), /variation/i);
  input.respondents[0] = respondent('reader-one', 'missing-archetype', {});
  assert.throws(() => loadCohort(input), /unknown archetype/i);
});
