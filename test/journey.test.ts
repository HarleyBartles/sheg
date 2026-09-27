import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runJourney } from '../src/domain/journey/run.js';
import { manifestSchema } from '../src/domain/study/manifest.js';
import { loadRespondents } from '../src/domain/respondents/cohort.js';
import type { DecisionRequest } from '../src/domain/decision/decision.js';

const fixtures = new URL('./fixtures/', import.meta.url);
const article = manifestSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL('article.json', fixtures)), 'utf8'))).arms[0]!;
const chapter = manifestSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL('chapter.json', fixtures)), 'utf8'))).arms[0]!;
const profile = loadRespondents(JSON.parse(readFileSync(fileURLToPath(new URL('cohort.json', fixtures)), 'utf8')))[0]!;

test('sequence mode exposes bounded stimulus then asks each typed task', async () => {
  const requests: DecisionRequest[] = [];
  const arm = { ...chapter, presentation: { kind: 'sequence' as const } };
  const result = await runJourney({ arm, profile, ask: async (request) => { requests.push(request); return { choice: 'continue' }; } });
  assert.deepEqual(result.events.filter((event) => event.type === 'exposure').map((event) => event.itemId), ['arrival', 'letter', 'revelation']);
  assert.equal(requests.length, chapter.tasks.length);
  assert.deepEqual(requests[0]?.optionIds, Object.keys(chapter.tasks[0]!.options));
});

test('graph mode follows selected stable option IDs and stops at terminal node', async () => {
  const choices = ['continue', 'open-notes', 'continue'];
  const result = await runJourney({ arm: article, profile, ask: async () => ({ choice: choices.shift()! }) });
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.events.filter((event) => event.type === 'exposure').map((event) => event.itemId), ['symptom', 'investigation', 'test-notes', 'repair']);
});

test('rejects provider choices absent from the current task options', async () => {
  await assert.rejects(runJourney({ arm: article, profile, ask: async () => ({ choice: 'invented' }) }), /option that was not offered/i);
});
