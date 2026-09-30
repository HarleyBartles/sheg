import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { traceStudy } from '../src/domain/journey/trace.js';
import { studyManifestSchema } from '../src/domain/study/study.js';
import { loadRespondents } from '../src/domain/respondents/cohort.js';

const fixture = new URL('./fixtures/', import.meta.url);
const study = studyManifestSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL('article.json', fixture)), 'utf8')));
const chapter = studyManifestSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL('chapter.json', fixture)), 'utf8'))).arms[0]!;
const profile = loadRespondents(JSON.parse(readFileSync(fileURLToPath(new URL('cohort.json', fixture)), 'utf8')))[0]!;
test('traces option IDs through an arm without provider calls', async () => {
  const result = await traceStudy(study.arms[0]!, profile, ['continue', 'open-notes', 'continue']);
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.events.filter((event) => event.type === 'exposure').map((event) => event.itemId), ['symptom', 'investigation', 'test-notes', 'repair']);
});
test('rejects scripted options left after a terminal outcome', async () => {
  await assert.rejects(traceStudy(study.arms[0]!, profile, ['leave', 'continue']), /unused scripted choice/i);
});

test('traces typed Score and Noul outcomes through sequence tasks', async () => {
  const arm = {
    ...chapter,
    presentation: { kind: 'sequence' as const },
    tasks: [
      { id: 'professional-tone', type: 'score' as const, instructions: 'How professional?', rubric: ['casual', 'balanced', 'professional'] },
      { id: 'holds-attention', type: 'noul' as const, instructions: 'Does this hold attention?' },
    ],
  };
  const result = await traceStudy(arm, profile, [
    { type: 'score', score: 1.25, legend: { '0': 'casual', '1': 'balanced', '2': 'professional' }, probabilities: { '0': 0.2, '1': 0.3, '2': 0.5 } },
    { type: 'noul', noul: 0.74 },
  ]);
  assert.deepEqual(result.events.filter((event) => event.type === 'response').map((event) => event.result.type), ['score', 'noul']);
});
