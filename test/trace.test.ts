import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { traceStudy } from '../src/domain/journey/trace.js';
import { manifestSchema } from '../src/domain/study/manifest.js';
import { loadRespondents } from '../src/domain/respondents/profile.js';

const fixture = new URL('./fixtures/', import.meta.url);
const study = manifestSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL('article.json', fixture)), 'utf8')));
const profile = loadRespondents(JSON.parse(readFileSync(fileURLToPath(new URL('cohort.json', fixture)), 'utf8')))[0]!;
test('traces option IDs through an arm without provider calls', async () => {
  const result = await traceStudy(study.arms[0]!, profile, ['continue', 'open-notes', 'continue']);
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.events.filter((event) => event.type === 'exposure').map((event) => event.itemId), ['symptom', 'investigation', 'test-notes', 'repair']);
});
test('rejects scripted options left after a terminal outcome', async () => {
  await assert.rejects(traceStudy(study.arms[0]!, profile, ['leave', 'continue']), /unused scripted choice/i);
});
