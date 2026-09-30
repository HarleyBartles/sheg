import assert from 'node:assert/strict';
import test from 'node:test';
import { loadStudy } from '../src/infrastructure/study-loader.js';
import { compileDecisionPacket, compileDecisionRequest, promptContractHash } from '../src/domain/decision/prompt.js';
import { fileURLToPath } from 'node:url';
import type { PromptHistoryEvent } from '../src/domain/decision/prompt.js';

const manifestPath = fileURLToPath(new URL('./fixtures/article.json', import.meta.url));
const cohortPath = fileURLToPath(new URL('./fixtures/cohort.json', import.meta.url));
test('graph packet retains compact prior choices but only current stimulus text', async () => {
  const study = await loadStudy(manifestPath, cohortPath);
  const arm = study.manifest.arms[0]!;
  const task = arm.tasks[1]!;
  const firstTask = arm.tasks[0]!;
  if (!('options' in task) || !('options' in firstTask)) throw new Error('Expected Choice fixture tasks.');
  const history: PromptHistoryEvent[] = [
    { type: 'exposure', sequence: 0, nodeId: 'show-symptom', itemId: 'symptom' },
    { type: 'choice', sequence: 1, nodeId: 'choose-entry', taskId: arm.tasks[0]!.id, choice: 'continue' },
    { type: 'exposure', sequence: 2, nodeId: 'show-investigation', itemId: 'investigation' },
  ];
  const request = compileDecisionPacket(arm, study.respondents[0]!, task.id, history);
  assert.deepEqual(request.state.encounteredItems.map((item) => item.id), ['investigation']);
  assert.equal(request.state.respondent.profile.intent, study.respondents[0]!.intent);
  assert.equal(JSON.stringify(request).includes('answerKeyOptionId'), false);
  assert.equal(JSON.stringify(request).includes(study.manifest.study.purpose), false);
  if (request.question.type === 'choice') assert.deepEqual(Object.keys(request.question.options), Object.keys(task.options));
  assert.deepEqual(request.state.trajectory.choices, [{
    taskId: arm.tasks[0]!.id,
    choiceId: 'continue',
    choiceMeaning: firstTask.options.continue,
    exposedItemIds: ['symptom'],
  }]);
  assert.equal(request.state.trajectory.eventCount, 3);
  assert.equal(request.state.trajectory.exposureCount, 2);
  assert.equal(request.state.trajectory.decisionCount, 1);
  assert.equal(JSON.stringify(request).includes(arm.items[0]!.text), false);
  assert.ok(request.state.trajectory.payloadUtf8Bytes > 0);
});

test('sequence packets retain all stimuli and graph packets include explicit re-exposure', async () => {
  const study = await loadStudy(manifestPath, cohortPath);
  const graphArm = study.manifest.arms[0]!;
  const history: PromptHistoryEvent[] = [
    { type: 'exposure', sequence: 0, nodeId: 'show-symptom', itemId: 'symptom' },
    { type: 'choice', sequence: 1, nodeId: 'choose-entry', taskId: graphArm.tasks[0]!.id, choice: 'continue' },
    { type: 'exposure', sequence: 2, nodeId: 'show-investigation', itemId: 'investigation' },
    { type: 'choice', sequence: 3, nodeId: 'choose-investigation', taskId: graphArm.tasks[1]!.id, choice: 'open-notes' },
    { type: 'exposure', sequence: 4, nodeId: 'show-symptom-again', itemId: 'symptom' },
  ];
  const graphRequest = compileDecisionPacket(graphArm, study.respondents[0]!, graphArm.tasks[2]!.id, history);
  assert.deepEqual(graphRequest.state.encounteredItems.map((item) => item.id), ['symptom']);

  const sequenceArm = { ...graphArm, presentation: { kind: 'sequence' as const } };
  const sequenceRequest = compileDecisionPacket(sequenceArm, study.respondents[0]!, graphArm.tasks[1]!.id, history);
  assert.deepEqual(sequenceRequest.state.encounteredItems.map((item) => item.id), graphArm.items.map((item) => item.id));
});

test('a task can suppress prior response context without changing the same respondent journey', async () => {
  const study = await loadStudy(manifestPath, cohortPath);
  const arm = structuredClone(study.manifest.arms[0]!);
  const task = arm.tasks[1]!;
  const firstTask = arm.tasks[0]!;
  if (!('options' in task) || !('options' in firstTask)) throw new Error('Expected Choice fixture tasks.');
  task.responseHistory = 'omit';
  const history: PromptHistoryEvent[] = [
    { type: 'exposure', sequence: 0, nodeId: 'show-symptom', itemId: 'symptom' },
    { type: 'choice', sequence: 1, nodeId: 'choose-entry', taskId: arm.tasks[0]!.id, choice: 'continue' },
    { type: 'exposure', sequence: 2, nodeId: 'show-investigation', itemId: 'investigation' },
  ];

  const request = compileDecisionPacket(arm, study.respondents[0]!, task.id, history);
  assert.equal(request.state.trajectory.decisionCount, 0);
  assert.deepEqual(request.state.trajectory.choices, []);
  assert.deepEqual(request.state.encounteredItems.map((item) => item.id), ['investigation']);
});

test('decision packet compilation is deterministic and rejects unknown history references', async () => {
  const study = await loadStudy(manifestPath, cohortPath);
  const arm = study.manifest.arms[0]!;
  const history: PromptHistoryEvent[] = [{ type: 'exposure', sequence: 0, nodeId: 'show-symptom', itemId: 'symptom' }];
  const first = compileDecisionPacket(arm, study.respondents[0]!, arm.tasks[0]!.id, history);
  const second = compileDecisionPacket(arm, study.respondents[0]!, arm.tasks[0]!.id, structuredClone(history));
  assert.deepEqual(first, second);
  assert.throws(() => compileDecisionPacket(arm, study.respondents[0]!, 'missing-task', history), /unknown task/i);
  assert.throws(() => compileDecisionPacket(arm, study.respondents[0]!, arm.tasks[0]!.id, [
    { type: 'exposure', sequence: 0, nodeId: 'show-missing', itemId: 'missing' },
  ]), /unknown encountered item/i);
});

test('explicit packet parts compile to the same validated request as the study arm path', async () => {
  const study = await loadStudy(manifestPath, cohortPath);
  const arm = study.manifest.arms[0]!;
  const profile = study.respondents[0]!;
  const task = arm.tasks[1]!;
  const firstTask = arm.tasks[0]!;
  if (!('options' in task) || !('options' in firstTask)) throw new Error('Expected Choice fixture tasks.');
  const history: PromptHistoryEvent[] = [
    { type: 'exposure', sequence: 0, nodeId: 'show-symptom', itemId: 'symptom' },
    { type: 'choice', sequence: 1, nodeId: 'choose-entry', taskId: arm.tasks[0]!.id, choice: 'continue' },
    { type: 'exposure', sequence: 2, nodeId: 'show-investigation', itemId: 'investigation' },
  ];
  const fromArm = compileDecisionPacket(arm, profile, task.id, history);
  const fromParts = compileDecisionRequest({
    respondentProfile: {
      intent: profile.intent,
      context: profile.context,
      desired_outcome: profile.desired_outcome,
      engagement_cues: profile.engagement_cues,
      friction_cues: profile.friction_cues,
    },
    encounteredItems: [
      { id: 'investigation', text: arm.items.find((item) => item.id === 'investigation')!.text },
    ],
    trajectory: fromArm.state.trajectory,
    question: { type: 'choice', id: task.id, instructions: task.instructions, options: { ...task.options } },
  });

  assert.deepEqual(fromParts, fromArm);
  assert.deepEqual(fromParts.state.encounteredItems.map((item) => item.id), ['investigation']);
  assert.deepEqual(fromParts.state.respondent.profile, {
    intent: profile.intent,
    context: profile.context,
    desired_outcome: profile.desired_outcome,
    engagement_cues: profile.engagement_cues,
    friction_cues: profile.friction_cues,
  });
  assert.equal(fromParts.state.trajectory.choices[0]?.choiceMeaning, firstTask.options.continue);
  if (fromParts.question.type === 'choice') assert.deepEqual(Object.keys(fromParts.question.options), Object.keys(task.options));
});

test('prompt contract fingerprint remains unchanged when packet assembly is shared', () => {
  assert.equal(promptContractHash(), 'a39d72d1ba77b0560dac5b7ccedf07b72e80b9d7bc1330679acd9c209e831526');
});
