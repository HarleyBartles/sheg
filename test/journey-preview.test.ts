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
  assert.ok('options' in task);
  if (!('options' in task)) return;
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
      priorResponses: [],
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

test('sequence preview matches the equivalent all-items-first linear graph for typed routes', () => {
  const sequenceArm: StudyArm = {
    ...arm,
    tasks: [
      { id: 'tone', type: 'score', instructions: 'How professional?', rubric: ['casual', 'balanced', 'professional'] },
      { id: 'interest', type: 'noul', instructions: 'Does this hold interest?' },
      arm.tasks[0]!,
    ],
    presentation: { kind: 'sequence' },
  };
  const graphArm = linearGraphEquivalent(sequenceArm);
  const sequencePreview = previewStudyJourney([sequenceArm]).arms[0]!;
  const graphPreview = previewStudyJourney([graphArm]).arms[0]!;

  assert.deepEqual(sequencePreview.entryNodeId, graphPreview.entryNodeId);
  assert.deepEqual(sequencePreview.nodes, graphPreview.nodes);
});

test('preview route contexts retain unique material across repeated exposure events', () => {
  const firstChoice = arm.tasks[0]!;
  if (!('options' in firstChoice)) throw new Error('Expected a Choice fixture task.');
  const tasks = [arm.tasks[0]!, { ...arm.tasks[0]!, id: 'middle' }, { ...arm.tasks[0]!, id: 'last' }];
  const graphArm: StudyArm = {
    ...arm,
    tasks,
    presentation: {
      kind: 'graph', entryNodeId: 'show-symptom', maxDecisions: 3,
      nodes: [
        { id: 'show-symptom', kind: 'expose', itemId: 'symptom' },
        { id: 'first', kind: 'ask', taskId: tasks[0]!.id },
        { id: 'show-investigation', kind: 'expose', itemId: 'investigation' },
        { id: 'second', kind: 'ask', taskId: tasks[1]!.id },
        { id: 'show-symptom-again', kind: 'expose', itemId: 'symptom' },
        { id: 'third', kind: 'ask', taskId: tasks[2]!.id },
        { id: 'done', kind: 'terminal', outcome: 'done' },
      ],
      transitions: [
        { fromNodeId: 'show-symptom', toNodeId: 'first' },
        ...Object.keys(firstChoice.options).map((optionId) => ({ fromNodeId: 'first', optionId, toNodeId: 'show-investigation' })),
        { fromNodeId: 'show-investigation', toNodeId: 'second' },
        ...Object.keys(firstChoice.options).map((optionId) => ({ fromNodeId: 'second', optionId, toNodeId: 'show-symptom-again' })),
        { fromNodeId: 'show-symptom-again', toNodeId: 'third' },
        ...Object.keys(firstChoice.options).map((optionId) => ({ fromNodeId: 'third', optionId, toNodeId: 'done' })),
      ],
    },
  };
  const preview = previewStudyJourney([graphArm]).arms[0]!;
  const questions = preview.nodes.filter((node) => node.kind === 'question');

  assert.ok(questions[1]?.kind === 'question' && questions[1].routeContexts.every(({ exposedStimulusIds }) => exposedStimulusIds.join(',') === 'symptom,investigation'));
  assert.ok(questions[2]?.kind === 'question' && questions[2].routeContexts.every(({ exposedStimulusIds }) => exposedStimulusIds.join(',') === 'symptom,investigation'));
});

test('previews every graph branch and represents a shared continuation node once', () => {
  const entryTask = arm.tasks[0]!;
  assert.ok('options' in entryTask);
  if (!('options' in entryTask)) return;
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
      priorResponses: context.priorResponses,
    })), [
      {
        path: [{ nodeId: 'start', optionId: 'continue' }, { nodeId: 'show-symptom' }, { nodeId: 'shared-question' }],
        exposedStimulusIds: ['symptom'],
        priorChoices: [{ taskId: 'entry-response', optionId: 'continue', meaning: entryTask.options.continue!, exposedItemIds: [] }],
        priorResponses: [],
      },
      {
        path: [{ nodeId: 'start', optionId: 'leave' }, { nodeId: 'show-investigation' }, { nodeId: 'shared-question' }],
        exposedStimulusIds: ['investigation'],
        priorChoices: [{ taskId: 'entry-response', optionId: 'leave', meaning: entryTask.options.leave!, exposedItemIds: [] }],
        priorResponses: [],
      },
    ]);
  }
});

test('previews Score threshold branches as typed intervals, not Choice option IDs', () => {
  const scoreArm: StudyArm = {
    ...arm,
    tasks: [
      { id: 'tone', type: 'score', instructions: 'How professional?', rubric: ['casual', 'balanced', 'professional'] },
      arm.tasks[0]!,
    ],
    presentation: {
      kind: 'graph', entryNodeId: 'rate-tone', maxDecisions: 2,
      nodes: [
        { id: 'rate-tone', kind: 'ask', taskId: 'tone' },
        { id: 'next-question', kind: 'ask', taskId: arm.tasks[0]!.id },
        { id: 'done', kind: 'terminal', outcome: 'done' },
      ],
      transitions: [
        { fromNodeId: 'rate-tone', when: { type: 'score', minimum: 0, maximum: 1.5, minimumInclusive: true, maximumInclusive: false }, toNodeId: 'next-question' },
        { fromNodeId: 'rate-tone', when: { type: 'score', minimum: 1.5, maximum: 2, minimumInclusive: true, maximumInclusive: true }, toNodeId: 'next-question' },
        { fromNodeId: 'next-question', optionId: 'continue', toNodeId: 'done' },
        { fromNodeId: 'next-question', optionId: 'leave', toNodeId: 'done' },
      ],
    },
  };
  const journey = previewStudyJourney([scoreArm]).arms[0]!;
  const question = journey.nodes.find((node) => node.id === 'next-question');
  assert.equal(question?.kind, 'question');
  if (question?.kind !== 'question') return;
  assert.deepEqual(question.routeContexts.map((context) => context.path[0]), [
    { nodeId: 'rate-tone', response: { type: 'score', when: scoreArm.presentation.kind === 'graph' ? scoreArm.presentation.transitions[0]?.when : undefined, meaning: 'SCORE [0, 1.5)' } },
    { nodeId: 'rate-tone', response: { type: 'score', when: scoreArm.presentation.kind === 'graph' ? scoreArm.presentation.transitions[1]?.when : undefined, meaning: 'SCORE [1.5, 2]' } },
  ]);
  assert.equal(question.routeContexts[0]?.priorResponses[0]?.response.type, 'score');
  assert.deepEqual(question.routeContexts[0]?.priorChoices, []);
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

function linearGraphEquivalent(arm: StudyArm): StudyArm {
  const itemNodes = arm.items.map((item) => ({ id: `sequence-expose-${item.id}`, kind: 'expose' as const, itemId: item.id }));
  const askNodes = arm.tasks.map((task) => ({ id: `sequence-ask-${task.id}`, kind: 'ask' as const, taskId: task.id }));
  const terminal = { id: `sequence-terminal-${arm.id}`, kind: 'terminal' as const, outcome: 'complete' };
  const nodes = [...itemNodes, ...askNodes, terminal];
  const transitions: Extract<StudyArm['presentation'], { kind: 'graph' }>['transitions'] = [];
  const nextAfterItems = askNodes[0]!.id;

  for (const [index, node] of itemNodes.entries()) {
    transitions.push({ fromNodeId: node.id, toNodeId: itemNodes[index + 1]?.id ?? nextAfterItems });
  }
  for (const [index, task] of arm.tasks.entries()) {
    const nodeId = askNodes[index]!.id;
    const nextNodeId = askNodes[index + 1]?.id ?? terminal.id;
    if ('options' in task) {
      for (const optionId of Object.keys(task.options)) transitions.push({ fromNodeId: nodeId, optionId, toNodeId: nextNodeId });
    } else {
      transitions.push({ fromNodeId: nodeId, when: {
        type: 'rubric' in task ? 'score' : 'noul',
        minimum: 0,
        maximum: 'rubric' in task ? task.rubric.length - 1 : 1,
        minimumInclusive: true,
        maximumInclusive: true,
      }, toNodeId: nextNodeId });
    }
  }
  return { ...arm, presentation: {
    kind: 'graph', entryNodeId: itemNodes[0]!.id, maxDecisions: arm.tasks.length, nodes, transitions,
  } };
}
