import assert from 'node:assert/strict';
import test from 'node:test';
import { loadStudy } from '../src/domain/study/load-study.js';
import { promptContractHash, renderQuestion, type ChoiceHistoryEvent } from '../src/domain/decision/prompt.js';
import type { ReaderProfile } from '../src/domain/readers/profile.js';
import { fileURLToPath } from 'node:url';

const manifestPath = fileURLToPath(new URL('./fixtures/article.json', import.meta.url));
const cohortPath = fileURLToPath(new URL('./fixtures/cohort.json', import.meta.url));

test('decision state contains encountered stimuli in order and excludes future content and study metadata', async () => {
  const loaded = await loadStudy(manifestPath, cohortPath);
  const profile = loaded.profiles[0] as ReaderProfile;
  const history: ChoiceHistoryEvent[] = [
    { nodeId: 'choose-entry', choice: 'continue' },
    { nodeId: 'choose-investigation', choice: 'open-notes' },
  ];
  const request = renderQuestion(
    loaded.manifest,
    profile,
    'investigation-response',
    ['symptom', 'investigation'],
    history,
  );

  assert.deepEqual(request.state.encounteredItems.map((item) => item.id), ['symptom', 'investigation']);
  assert.deepEqual(request.state.choiceHistory, history);
  assert.equal(request.state.reader.profile.arrival_intent, 'Understand how software design choices affect the people who use a system.');
  assert.equal('archetypeId' in request.state.reader.profile, false);
  assert.equal('variation' in request.state.reader.profile, false);
  assert.equal(JSON.stringify(request.state).includes('The team replaced the hidden coupling'), false);
  assert.equal(JSON.stringify(request.state).includes(loaded.manifest.study.purpose), false);
  assert.deepEqual(request.labels, ['continue', 'open-notes', 'leave']);
});

test('prompt renderer rejects unknown decision and unencountered item references', async () => {
  const loaded = await loadStudy(manifestPath, cohortPath);
  const profile = loaded.profiles[0] as ReaderProfile;

  assert.throws(() => renderQuestion(loaded.manifest, profile, 'missing-decision', []), /unknown decision/i);
  assert.throws(() => renderQuestion(loaded.manifest, profile, 'entry-response', ['missing-item']), /unknown encountered item/i);
});

test('prompt contract fingerprint is a stable SHA-256 value', () => {
  assert.match(promptContractHash(), /^[a-f0-9]{64}$/);
});
