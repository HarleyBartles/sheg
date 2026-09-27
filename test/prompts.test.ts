import assert from 'node:assert/strict';
import test from 'node:test';
import { loadStudy } from '../src/domain/study/load-study.js';
import { promptContractHash, renderQuestion } from '../src/domain/decision/prompt.js';
import { fileURLToPath } from 'node:url';

const manifestPath = fileURLToPath(new URL('./fixtures/article.json', import.meta.url));
const cohortPath = fileURLToPath(new URL('./fixtures/cohort.json', import.meta.url));
test('prompt contains only encountered stimulus and the selected arm task, never answer keys or study metadata', async () => {
  const study = await loadStudy(manifestPath, cohortPath);
  const arm = study.manifest.arms[0]!;
  const task = arm.tasks[1]!;
  const request = renderQuestion(arm, study.respondents[0]!, task.id, ['symptom', 'investigation'], [{ taskId: arm.tasks[0]!.id, choice: 'continue' }]);
  assert.deepEqual(request.state.encounteredItems.map((item) => item.id), ['symptom', 'investigation']);
  assert.equal(request.state.respondent.profile.intent, study.respondents[0]!.intent);
  assert.equal(JSON.stringify(request).includes('answerKeyOptionId'), false);
  assert.equal(JSON.stringify(request).includes(study.manifest.study.purpose), false);
  assert.deepEqual(request.optionIds, Object.keys(task.options));
});
test('rejects unknown task and unencountered stimulus item', async () => {
  const study = await loadStudy(manifestPath, cohortPath);
  const arm = study.manifest.arms[0]!;
  assert.throws(() => renderQuestion(arm, study.respondents[0]!, 'missing', []), /unknown task/i);
  assert.throws(() => renderQuestion(arm, study.respondents[0]!, arm.tasks[0]!.id, ['missing']), /unknown encountered item/i);
});
test('prompt contract fingerprint is a stable SHA-256 value', () => assert.match(promptContractHash(), /^[a-f0-9]{64}$/));
