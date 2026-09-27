import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { archetypeLibrarySchema } from '../src/domain/readers/archetype.js';
import { loadCohort } from '../src/domain/respondents/profile.js';

const libraryUrl = new URL('../src/domain/readers/reader-archetypes.json', import.meta.url);
const schemaAssets = new URL('../skills/stimulus-response-polling/assets/', import.meta.url);

function reader(id: string, archetypeId?: string, variation?: Record<string, string>) {
  return {
    id,
    ...(archetypeId === undefined ? {} : { archetypeId }),
    ...(variation === undefined ? {} : { variation }),
    arrival_intent: 'Understand the practical consequence of the subject.',
    background: 'Has adjacent experience but not this specialist context.',
    desired_payoff: 'Leave with a concrete, transferable understanding.',
    drawn_in_by: 'Specific examples and visible cause and effect.',
    put_off_by: 'Claims that skip evidence or conceal necessary context.',
  };
}

function admission() {
  return { rationale: 'The perspectives offer distinct starting points.', frozenAt: '2026-09-27T10:00:00Z' };
}

test('the shipped archetype library follows the authoring contract', async () => {
  const input: unknown = JSON.parse(await readFile(libraryUrl, 'utf8'));
  const parsed = archetypeLibrarySchema.safeParse(input);
  assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
  if (parsed.success) assert.ok(parsed.data.length >= 8);
});

test('published schemas carry constraints that consumers can validate directly', async () => {
  const manifest = JSON.parse(await readFile(new URL('study-manifest.schema.json', schemaAssets), 'utf8')) as {
    properties: { arms: { items: { properties: { tasks: { items: { properties: { options: { minProperties?: number } } } } } } } };
    'x-validation-rules': string[];
  };
  const cohort = JSON.parse(await readFile(new URL('respondent-cohort.schema.json', schemaAssets), 'utf8')) as {
    'x-validation-rules': string[];
  };

  assert.equal(manifest.properties.arms.items.properties.tasks.items.properties.options.minProperties, 1);
  assert.ok(manifest['x-validation-rules'].some((rule) => rule.includes('Task option IDs')));
  assert.ok(cohort['x-validation-rules'].some((rule) => rule.includes('Respondent IDs are unique')));
});

test('cohort can mix shipped and custom archetypes with concrete varied profiles', async () => {
  const library = archetypeLibrarySchema.parse(JSON.parse(await readFile(libraryUrl, 'utf8')) as unknown);
  const shipped = library.find((item) => item.id === 'curious-outsider');
  assert.ok(shipped);
  const custom = {
    id: 'domain-practitioner',
    name: 'Domain practitioner',
    arrival_intent: 'Check whether the account holds up in applied work.',
    background: 'Works directly with the kinds of systems being discussed.',
    desired_payoff: 'Find a credible insight that changes a practical decision.',
    drawn_in_by: 'Operational detail and trade-offs made explicit.',
    put_off_by: 'Anecdotes presented as universal evidence.',
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
      reader('newcomer', shipped.id, { subject_familiarity: 'newcomer', explanation_tolerance: 'concrete_first' }),
      reader('practitioner', custom.id, { practice_depth: 'direct', decision_focus: 'mechanism' }),
    ],
    admission: admission(),
  });

  assert.deepEqual(cohort.archetypes.map((item) => item.id), ['curious-outsider', 'domain-practitioner']);
  assert.deepEqual(cohort.respondents.map((item) => item.id), ['newcomer', 'practitioner']);
});

test('direct profiles work without archetypes or archetype lineage', () => {
  const cohort = loadCohort({ version: '3.0', respondents: [reader('direct-reader')], admission: admission() });
  assert.equal(cohort.archetypes.length, 0);
  assert.equal(cohort.respondents[0]?.archetypeId, undefined);
});

test('archetype-derived profiles must select every declared variation axis value', async () => {
  const library = archetypeLibrarySchema.parse(JSON.parse(await readFile(libraryUrl, 'utf8')) as unknown);
  const shipped = library.find((item) => item.id === 'curious-outsider');
  assert.ok(shipped);
  const input = { version: '3.0', archetypes: [shipped], respondents: [reader('reader-one', shipped.id, { subject_familiarity: 'newcomer' })], admission: admission() };

  assert.throws(() => loadCohort(input), /variation/i);
  input.respondents[0] = reader('reader-one', shipped.id, { subject_familiarity: 'unknown', explanation_tolerance: 'concrete_first' });
  assert.throws(() => loadCohort(input), /variation/i);
  input.respondents[0] = reader('reader-one', 'missing-archetype', {});
  assert.throws(() => loadCohort(input), /unknown archetype/i);
});
