import assert from 'node:assert/strict';
import test from 'node:test';
import { loadStudy } from '../src/infrastructure/study-loader.js';
import { appendTrajectoryResponse, compileDecisionPacket, compileDecisionRequest, emptyTrajectory, prepareFollowOnPacket } from '../src/domain/decision/prompt.js';
import type { DecisionValue } from '../src/domain/decision/decision.js';
import { fileURLToPath } from 'node:url';
import type { PromptHistoryEvent } from '../src/domain/decision/prompt.js';

const manifestPath = fileURLToPath(new URL('./fixtures/article.json', import.meta.url));
const cohortPath = fileURLToPath(new URL('./fixtures/cohort.json', import.meta.url));

test('continuation adds the selected typed answer and exact exposure IDs to the saved trajectory', () => {
  const question = { type: 'choice' as const, id: 'interest', instructions: 'Would you continue?', options: { continue: 'Continue', leave: 'Leave' } };
  const answer: DecisionValue = { type: 'choice', choice: 'leave', probabilities: { continue: 0.2, leave: 0.8 }, confidence: 0.77 };
  const continued = appendTrajectoryResponse(emptyTrajectory(), question, answer, ['section-three']);
  assert.equal(continued.eventCount, 1);
  assert.equal(continued.decisionCount, 1);
  assert.deepEqual(continued.choices, [{ taskId: 'interest', choiceId: 'leave', choiceMeaning: 'Leave', exposedItemIds: ['section-three'] }]);
  assert.deepEqual(continued.responses[0], { type: 'choice', taskId: 'interest', choiceId: 'leave', choiceMeaning: 'Leave', exposedItemIds: ['section-three'], probabilities: { continue: 0.2, leave: 0.8 }, confidence: 0.77 });
  assert.ok(continued.payloadUtf8Bytes > 0);
  assert.throws(() => appendTrajectoryResponse(emptyTrajectory(), question, { type: 'noul', noul: 0.5 }, []), /does not match/i);
});

test('follow-on context modes preserve or replace only the promised respondent state', () => {
  const originalQuestion = { type: 'choice' as const, id: 'left-interest', instructions: 'Continue?', options: { yes: 'Yes', no: 'No' } };
  const nextQuestion = { type: 'noul' as const, id: 'why-left', instructions: 'Did this section cause you to leave?' };
  const source = compileDecisionRequest({
    respondentProfile: { intent: 'Learn about this product.', context: 'Comparing options.', desired_outcome: 'Choose a tool.', engagement_cues: 'Specific benefits.', friction_cues: 'Confusing setup.' },
    encounteredItems: [{ id: 'section-three', text: 'Section three.' }],
    trajectory: appendTrajectoryResponse(emptyTrajectory(), originalQuestion, { type: 'choice', choice: 'no' }, ['section-one', 'section-two']),
    question: originalQuestion,
  });
  const answer: DecisionValue = { type: 'choice', choice: 'no', probabilities: { yes: 0.1, no: 0.9 } };
  const recorded = prepareFollowOnPacket({ source, mode: 'recorded', question: nextQuestion });
  assert.deepEqual(recorded.state, source.state);
  assert.deepEqual(recorded.question, nextQuestion);
  recorded.state.respondent.profile.intent = 'Mutated copy.';
  assert.equal(source.state.respondent.profile.intent, 'Learn about this product.');

  const selected = [{ id: 'section-three', text: 'Section three.' }];
  for (const mode of ['fresh-material', 'omit-history'] as const) {
    const packet = prepareFollowOnPacket({ source, mode, question: nextQuestion, material: selected });
    assert.deepEqual(packet.state.respondent, source.state.respondent);
    assert.deepEqual(packet.state.encounteredItems, selected);
    assert.deepEqual(packet.state.trajectory, emptyTrajectory());
  }

  const continued = prepareFollowOnPacket({ source, mode: 'continue', question: nextQuestion, result: answer, material: [{ id: 'appendix', text: 'An appendix.' }] });
  assert.deepEqual(continued.state.encounteredItems, [...source.state.encounteredItems, { id: 'appendix', text: 'An appendix.' }]);
  assert.equal(continued.state.trajectory.responses.at(-1)?.taskId, originalQuestion.id);
  assert.deepEqual(continued.state.trajectory.responses.at(-1)?.exposedItemIds, ['section-three']);
  assert.throws(() => prepareFollowOnPacket({ source, mode: 'continue', question: nextQuestion }), /completed answer/i);
});

test('graph packet retains compact prior choices and every encountered stimulus once', async () => {
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
  assert.deepEqual(request.state.encounteredItems.map((item) => item.id), ['symptom', 'investigation']);
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
  assert.equal(JSON.stringify(request).includes(arm.items[0]!.text), true);
  assert.ok(request.state.trajectory.payloadUtf8Bytes > 0);
});
test('sequence and graph packets share cumulative material and deduplicate explicit re-exposure', async () => {
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
  assert.deepEqual(graphRequest.state.encounteredItems.map((item) => item.id), ['symptom', 'investigation']);

  const sequenceArm = { ...graphArm, presentation: { kind: 'sequence' as const } };
  const sequenceRequest = compileDecisionPacket(sequenceArm, study.respondents[0]!, graphArm.tasks[1]!.id, history);
  assert.deepEqual(sequenceRequest.state.encounteredItems, graphRequest.state.encounteredItems);
});

test('cumulative material survives response omission and never includes an unexposed sibling', async () => {
  const study = await loadStudy(manifestPath, cohortPath);
  const arm = structuredClone(study.manifest.arms[0]!);
  const target = arm.tasks[2]!;
  target.responseHistory = 'omit';
  const history: PromptHistoryEvent[] = [
    { type: 'exposure', sequence: 0, nodeId: 'show-symptom', itemId: 'symptom' },
    { type: 'choice', sequence: 1, nodeId: 'choose-entry', taskId: arm.tasks[0]!.id, choice: 'continue' },
    { type: 'exposure', sequence: 2, nodeId: 'show-investigation', itemId: 'investigation' },
    { type: 'choice', sequence: 3, nodeId: 'choose-investigation', taskId: arm.tasks[1]!.id, choice: 'open-notes' },
    { type: 'exposure', sequence: 4, nodeId: 'show-symptom-again', itemId: 'symptom' },
  ];

  const request = compileDecisionPacket(arm, study.respondents[0]!, target.id, history);
  assert.deepEqual(request.state.encounteredItems.map(({ id }) => id), ['symptom', 'investigation']);
  assert.deepEqual(request.state.trajectory.responses, []);
  assert.deepEqual(request.state.trajectory.choices, []);
  assert.equal(request.state.trajectory.exposureCount, 3);
  assert.equal(request.state.trajectory.eventCount, 3);
  assert.deepEqual(request.state.encounteredItems.map(({ id }) => id).filter((id) => ['repair', 'test-notes'].includes(id)), []);
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
  assert.deepEqual(request.state.encounteredItems.map((item) => item.id), ['symptom', 'investigation']);
});

test('decision packet compilation rejects unknown task and stimulus references', async () => {
  const study = await loadStudy(manifestPath, cohortPath);
  const arm = study.manifest.arms[0]!;
  const history: PromptHistoryEvent[] = [{ type: 'exposure', sequence: 0, nodeId: 'show-symptom', itemId: 'symptom' }];
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
      { id: 'symptom', text: arm.items.find((item) => item.id === 'symptom')!.text },
      { id: 'investigation', text: arm.items.find((item) => item.id === 'investigation')!.text },
    ],
    trajectory: fromArm.state.trajectory,
    question: { type: 'choice', id: task.id, instructions: task.instructions, options: { ...task.options } },
  });

  assert.deepEqual(fromParts, fromArm);
  assert.deepEqual(fromParts.state.encounteredItems.map((item) => item.id), ['symptom', 'investigation']);
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
