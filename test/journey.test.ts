import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runJourney } from '../src/domain/journey/run.js';
import { manifestSchema } from '../src/domain/study/manifest.js';
import { loadProfiles } from '../src/domain/readers/profile.js';
import type { DecisionRequest } from '../src/domain/decision/contract.js';

const fixtures = new URL('./fixtures/', import.meta.url);
const article = manifestSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL('article.json', fixtures)), 'utf8')));
const chapter = manifestSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL('chapter.json', fixtures)), 'utf8')));
const cohort = loadProfiles(JSON.parse(readFileSync(fileURLToPath(new URL('cohort.json', fixtures)), 'utf8')));
const reader = cohort[0]!;

function withRoute(manifest: typeof article, choices: string[], maxDecisions = manifest.maxDecisions) {
  let index = 0;
  const requests: DecisionRequest[] = [];
  return {
    requests,
    journey: runJourney({
      study: { ...manifest, maxDecisions },
      profile: reader,
      ask: async (request) => {
        requests.push(request);
        return { choice: choices[index++] ?? '' };
      },
    }),
  };
}

test('runs a sequential chapter journey through the shared graph runner', async () => {
  const run = withRoute(chapter, ['continue', 'continue']);
  const result = await run.journey;

  assert.equal(result.status, 'completed');
  assert.equal(result.outcome, 'chapter-ended');
  assert.equal(result.decisionCount, 2);
  assert.deepEqual(result.events.filter((event) => event.type === 'exposure').map((event) => event.itemId), [
    'arrival', 'letter', 'revelation',
  ]);
  assert.equal(result.events[0]?.sequence, 0);
  assert.deepEqual(run.requests[1]?.state.encounteredItems, [
    { id: 'arrival', text: 'Mara arrived at the station after the last train.' },
    { id: 'letter', text: "The unopened letter carried her brother's seal." },
  ]);
});

test('early terminal choices stop before later stimulus is exposed', async () => {
  const { journey } = withRoute(article, ['leave']);
  const result = await journey;

  assert.equal(result.outcome, 'left-early');
  assert.deepEqual(result.events.filter((event) => event.type === 'exposure').map((event) => event.itemId), ['symptom']);
  assert.equal(result.decisionCount, 1);
});

test('supports decision-first entry with no prior item exposure', async () => {
  const scanEntry = {
    ...article,
    entryNodeId: 'choose-entry',
  };
  const { journey, requests } = withRoute(scanEntry, ['continue', 'continue']);
  const result = await journey;

  assert.deepEqual(requests[0]?.state.encounteredItems, []);
  assert.deepEqual(result.events.filter((event) => event.type === 'exposure').map((event) => event.itemId), [
    'investigation', 'repair',
  ]);
});

test('exposes optional content only along the selected branch', async () => {
  const { journey } = withRoute(article, ['continue', 'continue']);
  const result = await journey;

  assert.equal(result.outcome, 'completed');
  assert.equal(result.events.some((event) => event.type === 'exposure' && event.itemId === 'test-notes'), false);
});

test('can defer optional content and expose it when a later decision re-offers it', async () => {
  const reoffer = structuredClone(article);
  const investigation = reoffer.decisions.find((decision) => decision.id === 'investigation-response')!;
  investigation.criteria = {
    'defer-notes': 'Do not read the notes yet.',
    continue: 'Continue without the notes.',
    leave: 'Stop reading now.',
  };
  const laterOfferId = 'offer-notes-later';
  reoffer.decisions.push({
    id: 'later-notes-offer',
    instructions: 'Would you like to read the test notes now?',
    criteria: { 'open-notes': 'Read the notes.', continue: 'Continue without them.' },
  });
  reoffer.nodes.push({ id: laterOfferId, kind: 'decide', decisionId: 'later-notes-offer' });
  reoffer.transitions = reoffer.transitions.filter((edge) => edge.fromNodeId !== 'choose-investigation');
  reoffer.transitions.push(
    { fromNodeId: 'choose-investigation', choice: 'defer-notes', toNodeId: laterOfferId },
    { fromNodeId: 'choose-investigation', choice: 'continue', toNodeId: 'show-repair' },
    { fromNodeId: 'choose-investigation', choice: 'leave', toNodeId: 'left' },
    { fromNodeId: laterOfferId, choice: 'open-notes', toNodeId: 'show-notes' },
    { fromNodeId: laterOfferId, choice: 'continue', toNodeId: 'show-repair' },
  );
  manifestSchema.parse(reoffer);

  const { journey } = withRoute(reoffer, ['continue', 'defer-notes', 'open-notes', 'continue']);
  const result = await journey;

  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.events.filter((event) => event.type === 'choice').map((event) => event.choice), [
    'continue', 'defer-notes', 'open-notes', 'continue',
  ]);
  assert.deepEqual(result.events.filter((event) => event.type === 'exposure').map((event) => event.itemId), [
    'symptom', 'investigation', 'test-notes', 'repair',
  ]);
});

test('stops a cyclic graph at its decision ceiling before asking again', async () => {
  const cycle = structuredClone(article);
  cycle.transitions.find((edge) => edge.fromNodeId === 'choose-investigation' && edge.choice === 'continue')!.toNodeId = 'show-symptom';
  const { journey, requests } = withRoute(cycle, ['continue', 'continue'], 2);
  const result = await journey;

  assert.equal(result.status, 'decision-limit');
  assert.equal(result.outcome, null);
  assert.equal(result.decisionCount, 2);
  assert.equal(requests.length, 2);
});

test('rejects a choice outside the current decision before recording it', async () => {
  const { journey } = withRoute(article, ['not-offered']);
  await assert.rejects(journey, /not an offered choice/i);
});
