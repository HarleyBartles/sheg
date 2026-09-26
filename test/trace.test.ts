import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { traceStudy } from '../src/domain/journey/trace.js';
import { manifestSchema } from '../src/domain/study/manifest.js';
import { loadProfiles } from '../src/domain/readers/profile.js';

const fixtures = new URL('./fixtures/', import.meta.url);
const study = manifestSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL('article.json', fixtures)), 'utf8')));
const profiles = loadProfiles(JSON.parse(readFileSync(fileURLToPath(new URL('cohort.json', fixtures)), 'utf8')));

test('traces scripted choices through the production graph runner without provider calls', async () => {
  const result = await traceStudy(study, profiles[0]!, ['continue', 'open-notes', 'continue']);

  assert.equal(result.status, 'completed');
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.events.filter((event) => event.type === 'exposure').map((event) => event.itemId), [
    'symptom', 'investigation', 'test-notes', 'repair',
  ]);
});

test('rejects scripts with choices left after a terminal outcome', async () => {
  await assert.rejects(traceStudy(study, profiles[0]!, ['leave', 'continue']), /unused scripted choice/i);
});
