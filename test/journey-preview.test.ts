import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { studyManifestSchema } from '../src/domain/study/study.js';
import type { StudyArm } from '../src/domain/study/arm.js';
import { previewStudyJourney } from '../src/domain/journey/preview.js';

const manifestUrl = new URL('./fixtures/article.json', import.meta.url);
const manifest = studyManifestSchema.parse(JSON.parse(readFileSync(fileURLToPath(manifestUrl), 'utf8')));
const arm = manifest.arms[0]!;

test('previews sequence stimuli before the authored questions and routes every choice to the next task', () => {
  const sequenceArm: StudyArm = { ...arm, presentation: { kind: 'sequence' } };
  const preview = previewStudyJourney([sequenceArm]);
  const journey = preview.arms[0]!;
  const stimulusNodes = journey.nodes.filter((node) => node.kind === 'stimulus');
  const questionNodes = journey.nodes.filter((node) => node.kind === 'question');

  assert.deepEqual(stimulusNodes.map((node) => node.kind === 'stimulus' ? node.stimulusId : ''), arm.items.map((item) => item.id));
  assert.deepEqual(questionNodes.map((node) => node.kind === 'question' ? node.taskId : ''), arm.tasks.map((task) => task.id));
  assert.equal(journey.nodes.slice(0, arm.items.length).every((node) => node.kind === 'stimulus'), true);
  assert.equal(journey.nodes.slice(arm.items.length, arm.items.length + arm.tasks.length).every((node) => node.kind === 'question'), true);
  assert.equal(journey.nodes.at(-1)?.kind, 'terminal');
  const task = arm.tasks[0]!;
  const firstQuestion = questionNodes[0]!;
  assert.equal(firstQuestion.kind, 'question');
  if (firstQuestion.kind === 'question') {
    assert.equal(firstQuestion.instructions, task.instructions);
    assert.deepEqual(firstQuestion.options.map(({ optionId, description }) => [optionId, description]), Object.entries(task.options));
    assert.ok(firstQuestion.options.every((option) => option.nextNodeId === journey.nodes[arm.items.length + 1]?.id));
    assert.deepEqual(firstQuestion.routeContexts, [{
      path: [
        ...arm.items.map((item) => ({ nodeId: `sequence-expose-${item.id}` })),
        { nodeId: firstQuestion.id },
      ],
      exposedStimulusIds: arm.items.map(({ id }) => id),
      priorChoices: [],
    }]);
    const secondQuestion = questionNodes[1]!;
    assert.equal(secondQuestion.kind, 'question');
    if (secondQuestion.kind === 'question') {
      assert.deepEqual(secondQuestion.routeContexts.map((context) => context.priorChoices.map(({ taskId, optionId, meaning }) => ({ taskId, optionId, meaning }))),
        Object.entries(task.options).map(([optionId, meaning]) => [{ taskId: task.id, optionId, meaning }]));
      assert.ok(secondQuestion.routeContexts.every((context) => context.exposedStimulusIds.join(',') === arm.items.map(({ id }) => id).join(',')));
    }
  }
});

test('previews every graph branch and represents a shared continuation node once', () => {
  const sharedArm: StudyArm = {
    ...arm,
    presentation: {
      kind: 'graph',
      entryNodeId: 'start',
      maxDecisions: 2,
      nodes: [
        { id: 'start', kind: 'ask', taskId: 'entry-response' },
        { id: 'show-symptom', kind: 'expose', itemId: 'symptom' },
        { id: 'show-investigation', kind: 'expose', itemId: 'investigation' },
        { id: 'shared-question', kind: 'ask', taskId: 'investigation-response' },
        { id: 'finished', kind: 'terminal', outcome: 'finished' },
      ],
      transitions: [
        { fromNodeId: 'start', optionId: 'continue', toNodeId: 'show-symptom' },
        { fromNodeId: 'start', optionId: 'leave', toNodeId: 'show-investigation' },
        { fromNodeId: 'show-symptom', toNodeId: 'shared-question' },
        { fromNodeId: 'show-investigation', toNodeId: 'shared-question' },
        { fromNodeId: 'shared-question', optionId: 'continue', toNodeId: 'finished' },
        { fromNodeId: 'shared-question', optionId: 'open-notes', toNodeId: 'finished' },
        { fromNodeId: 'shared-question', optionId: 'leave', toNodeId: 'finished' },
      ],
    },
  };
  const journey = previewStudyJourney([sharedArm]).arms[0]!;
  const ids = journey.nodes.map(({ id }) => id);
  const start = journey.nodes.find((node) => node.id === 'start');
  const shared = journey.nodes.find((node) => node.id === 'shared-question');
  const symptoms = journey.nodes.find((node) => node.id === 'show-symptom');
  const investigation = journey.nodes.find((node) => node.id === 'show-investigation');

  assert.equal(ids.filter((id) => id === 'shared-question').length, 1);
  assert.equal(journey.entryNodeId, 'start');
  assert.equal(start?.kind, 'question');
  if (start?.kind === 'question') assert.deepEqual(start.options.map(({ optionId, nextNodeId }) => [optionId, nextNodeId]), [['continue', 'show-symptom'], ['leave', 'show-investigation']]);
  assert.equal(symptoms?.kind, 'stimulus');
  if (symptoms?.kind === 'stimulus') assert.equal(symptoms.text, arm.items.find((item) => item.id === 'symptom')?.text);
  assert.equal(investigation?.kind, 'stimulus');
  if (investigation?.kind === 'stimulus') assert.equal(investigation.text, arm.items.find((item) => item.id === 'investigation')?.text);
  assert.equal(shared?.kind, 'question');
  if (shared?.kind === 'question') {
    assert.equal(shared.instructions, arm.tasks[1]?.instructions);
    assert.deepEqual(shared.routeContexts.map((context) => ({
      path: context.path,
      exposedStimulusIds: context.exposedStimulusIds,
      priorChoices: context.priorChoices.map(({ taskId, optionId, meaning, exposedItemIds }) => ({ taskId, optionId, meaning, exposedItemIds })),
    })), [
      {
        path: [{ nodeId: 'start', optionId: 'continue' }, { nodeId: 'show-symptom' }, { nodeId: 'shared-question' }],
        exposedStimulusIds: ['symptom'],
        priorChoices: [{ taskId: 'entry-response', optionId: 'continue', meaning: arm.tasks[0]!.options.continue!, exposedItemIds: [] }],
      },
      {
        path: [{ nodeId: 'start', optionId: 'leave' }, { nodeId: 'show-investigation' }, { nodeId: 'shared-question' }],
        exposedStimulusIds: ['investigation'],
        priorChoices: [{ taskId: 'entry-response', optionId: 'leave', meaning: arm.tasks[0]!.options.leave!, exposedItemIds: [] }],
      },
    ]);
  }
});

test('rejects invalid graph destinations instead of returning a partial preview', () => {
  const invalidArm = structuredClone(arm);
  assert.equal(invalidArm.presentation.kind, 'graph');
  if (invalidArm.presentation.kind === 'graph') invalidArm.presentation.transitions[0]!.toNodeId = 'missing-node';

  assert.throws(() => previewStudyJourney([invalidArm]), /unknown target node missing-node/i);
});

test('rejects a journey whose route-context count exceeds the preview bound', () => {
  const manyChoiceTasks: StudyArm = {
    ...arm,
    tasks: Array.from({ length: 14 }, (_, index) => ({
      id: `question-${index + 1}`,
      instructions: `Choose for question ${index + 1}.`,
      options: { first: 'Choose first.', second: 'Choose second.' },
    })),
    presentation: { kind: 'sequence' },
  };

  assert.throws(() => previewStudyJourney([manyChoiceTasks]), /10,?000-context limit.*no partial preview/i);
});
