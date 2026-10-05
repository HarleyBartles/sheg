import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runJourney } from '../src/domain/journey/run.js';
import type { PromptState } from '../src/domain/decision/prompt.js';
import { studyManifestSchema } from '../src/domain/study/study.js';
import { loadRespondents } from '../src/domain/respondents/cohort.js';
import type { DecisionRequest } from '../src/domain/decision/decision.js';
import type { StudyArm } from '../src/domain/study/arm.js';

const fixtures = new URL('./fixtures/', import.meta.url);
const article = studyManifestSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL('article.json', fixtures)), 'utf8'))).arms[0]!;
const chapter = studyManifestSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL('chapter.json', fixtures)), 'utf8'))).arms[0]!;
const profile = loadRespondents(JSON.parse(readFileSync(fileURLToPath(new URL('cohort.json', fixtures)), 'utf8')))[0]!;

test('sequence mode exposes bounded stimulus then asks each typed task', async () => {
  const requests: DecisionRequest[] = [];
  const arm = { ...chapter, presentation: { kind: 'sequence' as const } };
  const result = await runJourney({ arm, profile, ask: async (request) => { requests.push(request); return { choice: 'continue' }; } });
  assert.deepEqual(result.events.filter((event) => event.type === 'exposure').map((event) => event.itemId), ['arrival', 'letter', 'revelation']);
  assert.equal(requests.length, chapter.tasks.length);
  const firstRequest = requests[0];
  const firstTask = chapter.tasks[0]!;
  if (firstRequest?.question.type === 'choice' && 'options' in firstTask) assert.deepEqual(Object.keys(firstRequest.question.options), Object.keys(firstTask.options));
});

test('sequence and its all-items-first linear graph share ask order, typed routing, and terminal outcome', async () => {
  const sequenceArm: StudyArm = {
    ...chapter,
    tasks: [
      { id: 'tone', type: 'score', instructions: 'How professional?', rubric: ['casual', 'balanced', 'professional'] },
      { id: 'interest', type: 'noul', instructions: 'Does this hold interest?' },
      chapter.tasks[0]!,
    ],
    presentation: { kind: 'sequence' },
  };
  const graphArm = linearGraphEquivalent(sequenceArm);
  const run = async (arm: StudyArm) => {
    const asks: Array<{ taskId: string; nodeId: string }> = [];
    const result = await runJourney({ arm, profile, ask: async (request, nodeId) => {
      asks.push({ taskId: request.question.id, nodeId });
      if (request.question.type === 'score') return { type: 'score', score: 1, legend: { '0': 'casual', '1': 'balanced', '2': 'professional' }, probabilities: { '0': 0.1, '1': 0.8, '2': 0.1 } };
      if (request.question.type === 'noul') return { type: 'noul', noul: 0.75 };
      return { choice: 'continue' };
    } });
    return { asks, result };
  };

  const sequence = await run(sequenceArm);
  const graph = await run(graphArm);
  assert.deepEqual(sequence.asks, graph.asks);
  assert.deepEqual(sequence.result, graph.result);
});

test('graph mode follows selected stable option IDs and stops at terminal node', async () => {
  const choices = ['continue', 'open-notes', 'continue'];
  const requests: DecisionRequest[] = [];
  const result = await runJourney({ arm: article, profile, ask: async (request) => { requests.push(request); return { choice: choices.shift()! }; } });
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.events.filter((event) => event.type === 'exposure').map((event) => event.itemId), ['symptom', 'investigation', 'test-notes', 'repair']);
  const states = requests.map((request) => request.state as unknown as PromptState);
  assert.deepEqual(states.map((state) => state.encounteredItems.map((item) => item.id)), [['symptom'], ['symptom', 'investigation'], ['symptom', 'investigation', 'test-notes']]);
  assert.deepEqual(states[2]?.trajectory.choices.map((choice) => choice.choiceId), ['continue', 'open-notes']);
});

test('rejects provider choices absent from the current task options', async () => {
  await assert.rejects(runJourney({ arm: article, profile, ask: async () => ({ choice: 'invented' }) }), /option that was not offered/i);
});

test('retains typed Score and Noul values in each respondent journey', async () => {
  const arm = {
    ...chapter,
    presentation: { kind: 'sequence' as const },
    tasks: [
      { id: 'professional-tone', type: 'score' as const, instructions: 'How professional does this sound?', rubric: ['casual', 'balanced', 'professional'], responseHistory: 'include' as const },
      { id: 'holds-attention', type: 'noul' as const, instructions: 'Does this hold attention?', responseHistory: 'include' as const },
    ],
  } as unknown as StudyArm;
  const result = await runJourney({
    arm,
    profile,
    ask: async (request) => request.question.type === 'score'
      ? { type: 'score', score: 1.25, legend: { '0': 'casual', '1': 'balanced', '2': 'professional' }, probabilities: { '0': 0.2, '1': 0.3, '2': 0.5 } }
      : { type: 'noul', noul: 0.74 },
  });

  assert.deepEqual(result.events.filter((event) => event.type === 'response').map((event) => event.result.type), ['score', 'noul']);
  const scored = result.events.find((event) => event.type === 'response' && event.result.type === 'score');
  assert.equal(scored?.type === 'response' && scored.result.type === 'score' ? scored.result.score : undefined, 1.25);
  const nouled = result.events.find((event) => event.type === 'response' && event.result.type === 'noul');
  assert.equal(nouled?.type === 'response' && nouled.result.type === 'noul' ? nouled.result.noul : undefined, 0.74);
});

test('routes a fractional Score through the explicit interval that contains it', async () => {
  const arm = {
    ...chapter,
    tasks: [{ id: 'professional-tone', type: 'score', instructions: 'How professional does this sound?', rubric: ['casual', 'balanced', 'professional'] }],
    presentation: {
      kind: 'graph', entryNodeId: 'show', maxDecisions: 1,
      nodes: [
        { id: 'show', kind: 'expose', itemId: 'arrival' },
        { id: 'rate', kind: 'ask', taskId: 'professional-tone' },
        { id: 'casual', kind: 'terminal', outcome: 'casual' },
        { id: 'professional', kind: 'terminal', outcome: 'professional' },
      ],
      transitions: [
        { fromNodeId: 'show', toNodeId: 'rate' },
        { fromNodeId: 'rate', toNodeId: 'casual', when: { type: 'score', minimum: 0, maximum: 1, minimumInclusive: true, maximumInclusive: false } },
        { fromNodeId: 'rate', toNodeId: 'professional', when: { type: 'score', minimum: 1, maximum: 2, minimumInclusive: true, maximumInclusive: true } },
      ],
    },
  } as unknown as StudyArm;
  const result = await runJourney({
    arm, profile,
    ask: async () => ({ type: 'score', score: 1.25, legend: { '0': 'casual', '1': 'balanced', '2': 'professional' }, probabilities: { '0': 0.2, '1': 0.3, '2': 0.5 } }),
  });
  assert.equal(result.outcome, 'professional');
});

test('routes a Noul value exactly on a threshold to its inclusive branch', async () => {
  const arm = {
    ...chapter,
    tasks: [{ id: 'credibility', type: 'noul', instructions: 'Was this credible?' }],
    presentation: {
      kind: 'graph', entryNodeId: 'ask', maxDecisions: 1,
      nodes: [
        { id: 'ask', kind: 'ask', taskId: 'credibility' },
        { id: 'low', kind: 'terminal', outcome: 'low' },
        { id: 'high', kind: 'terminal', outcome: 'high' },
      ],
      transitions: [
        { fromNodeId: 'ask', toNodeId: 'low', when: { type: 'noul', minimum: 0, maximum: 0.5, minimumInclusive: true, maximumInclusive: false } },
        { fromNodeId: 'ask', toNodeId: 'high', when: { type: 'noul', minimum: 0.5, maximum: 1, minimumInclusive: true, maximumInclusive: true } },
      ],
    },
  } as unknown as StudyArm;
  const result = await runJourney({ arm, profile, ask: async () => ({ type: 'noul', noul: 0.5 }) });
  assert.equal(result.outcome, 'high');
});

function linearGraphEquivalent(arm: StudyArm): StudyArm {
  const itemNodes = arm.items.map((item) => ({ id: `sequence-expose-${item.id}`, kind: 'expose' as const, itemId: item.id }));
  const askNodes = arm.tasks.map((task) => ({ id: `sequence-ask-${task.id}`, kind: 'ask' as const, taskId: task.id }));
  const terminal = { id: `sequence-terminal-${arm.id}`, kind: 'terminal' as const, outcome: 'complete' };
  const nodes = [...itemNodes, ...askNodes, terminal];
  const transitions: Extract<StudyArm['presentation'], { kind: 'graph' }>['transitions'] = [];

  for (const [index, node] of itemNodes.entries()) {
    transitions.push({ fromNodeId: node.id, toNodeId: itemNodes[index + 1]?.id ?? askNodes[0]!.id });
  }
  for (const [index, task] of arm.tasks.entries()) {
    const nodeId = askNodes[index]!.id;
    const nextNodeId = askNodes[index + 1]?.id ?? terminal.id;
    if ('options' in task) {
      for (const optionId of Object.keys(task.options)) transitions.push({ fromNodeId: nodeId, optionId, toNodeId: nextNodeId });
    } else {
      transitions.push({ fromNodeId: nodeId, when: {
        type: 'rubric' in task ? 'score' : 'noul', minimum: 0,
        maximum: 'rubric' in task ? task.rubric.length - 1 : 1,
        minimumInclusive: true, maximumInclusive: true,
      }, toNodeId: nextNodeId });
    }
  }
  return { ...arm, presentation: {
    kind: 'graph', entryNodeId: itemNodes[0]!.id, maxDecisions: arm.tasks.length, nodes, transitions,
  } };
}
