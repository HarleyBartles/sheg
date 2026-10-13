import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JourneyExecutionError, runJourney } from '../src/domain/journey/run.js';
import { walkStudyPackets } from '../src/domain/journey/packet-walker.js';
import { journeyControlSuccessors, journeyTopology } from '../src/domain/journey/topology.js';
import type { PromptState } from '../src/domain/decision/prompt.js';
import { studyManifestSchema } from '../src/domain/study/study.js';
import { loadRespondents } from '../src/domain/respondents/cohort.js';
import type { DecisionRequest } from '../src/domain/decision/decision.js';
import { studyArmSchema, type StudyArm } from '../src/domain/study/arm.js';

const fixtures = new URL('./fixtures/', import.meta.url);
const article = studyManifestSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL('article.json', fixtures)), 'utf8'))).arms[0]!;
const chapter = studyManifestSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL('chapter.json', fixtures)), 'utf8'))).arms[0]!;
const profile = loadRespondents(JSON.parse(readFileSync(fileURLToPath(new URL('cohort.json', fixtures)), 'utf8')))[0]!;

function matchedForkArm(): StudyArm {
  const answerItems = [
    { id: 'continue-a', text: 'Read the next passage.', sourceId: 'source-a', sourceSha256: 'a'.repeat(64) },
    { id: 'stop-a', text: 'Stop here.', sourceId: 'source-a', sourceSha256: 'a'.repeat(64) },
    { id: 'continue-b', text: 'Read the next passage.', sourceId: 'source-b', sourceSha256: 'b'.repeat(64) },
    { id: 'stop-b', text: 'Stop here.', sourceId: 'source-b', sourceSha256: 'b'.repeat(64) },
  ];
  return {
    ...chapter,
    items: [...chapter.items, ...answerItems],
    tasks: [
      { id: 'image-condition-question', type: 'choice', instructions: 'Would you continue reading?', comparisonKey: 'image-effect', options: { continue: 'Read the next passage.', stop: 'Stop here.' }, materialOptions: { continue: 'continue-a', stop: 'stop-a' } },
      { id: 'text-condition-question', type: 'choice', instructions: 'Would you continue reading?', comparisonKey: 'image-effect', options: { continue: 'Read the next passage.', stop: 'Stop here.' }, materialOptions: { continue: 'continue-b', stop: 'stop-b' } },
    ],
    presentation: {
      kind: 'graph', entryNodeId: 'treatment-fork', maxDecisions: 2,
      nodes: [
        { id: 'treatment-fork', kind: 'fork', conditions: [
          { id: 'image-present', label: 'With the image', entryNodeId: 'ask-with-image' },
          { id: 'image-absent', label: 'Without the image', entryNodeId: 'ask-without-image' },
        ] },
        { id: 'ask-with-image', kind: 'ask', taskId: 'image-condition-question' },
        { id: 'ask-without-image', kind: 'ask', taskId: 'text-condition-question' },
        { id: 'fork-end', kind: 'terminal', outcome: 'complete' },
      ],
      transitions: [
        { fromNodeId: 'ask-with-image', optionId: 'continue', toNodeId: 'fork-end' },
        { fromNodeId: 'ask-with-image', optionId: 'stop', toNodeId: 'fork-end' },
        { fromNodeId: 'ask-without-image', optionId: 'continue', toNodeId: 'fork-end' },
        { fromNodeId: 'ask-without-image', optionId: 'stop', toNodeId: 'fork-end' },
      ],
    },
  } as unknown as StudyArm;
}

function matchedForkArmWithTasks(tasks: StudyArm['tasks'], type: 'choice' | 'score' | 'noul'): StudyArm {
  const arm = matchedForkArm();
  const presentation = arm.presentation as Extract<StudyArm['presentation'], { kind: 'graph' }>;
  const transitions = type === 'choice' ? presentation.transitions : [
    ...presentation.transitions.filter(({ fromNodeId }) => fromNodeId !== 'ask-with-image' && fromNodeId !== 'ask-without-image'),
    ...['ask-with-image', 'ask-without-image'].map((fromNodeId) => ({ fromNodeId, toNodeId: 'fork-end', when: {
      type, minimum: 0, maximum: 1, minimumInclusive: true, maximumInclusive: true,
    } })),
  ];
  return { ...arm, tasks, presentation: { ...presentation, transitions } };
}

test('matched fork graph contract accepts distinct equivalent condition questions and material bindings', () => {
  const arm = matchedForkArm();
  const parsed = studyArmSchema.safeParse(arm);
  assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
  if (!parsed.success || parsed.data.presentation.kind !== 'graph') return;
  const fork = parsed.data.presentation.nodes.find((node) => node.id === 'treatment-fork');
  assert.equal(fork?.kind, 'fork');
  const [firstTask, secondTask] = parsed.data.tasks;
  assert.equal(firstTask?.type, 'choice');
  assert.equal(secondTask?.type, 'choice');
  if (firstTask?.type === 'choice' && secondTask?.type === 'choice') assert.notDeepEqual(firstTask.materialOptions, secondTask.materialOptions);
});

test('fork topology exposes condition successors separately from ordinary response transitions', () => {
  const graph = journeyTopology(matchedForkArm());
  assert.deepEqual(journeyControlSuccessors(graph, 'treatment-fork'), [
    { kind: 'condition', conditionId: 'image-present', label: 'With the image', toNodeId: 'ask-with-image' },
    { kind: 'condition', conditionId: 'image-absent', label: 'Without the image', toNodeId: 'ask-without-image' },
  ]);
  assert.deepEqual(journeyControlSuccessors(graph, 'ask-with-image').map(({ kind, toNodeId }) => ({ kind, toNodeId })), [
    { kind: 'transition', toNodeId: 'fork-end' }, { kind: 'transition', toNodeId: 'fork-end' },
  ]);
});

test('matched fork graph contract rejects malformed conditions, targets, and ordinary outgoing transitions', () => {
  const arm = matchedForkArm();
  const presentation = arm.presentation as Extract<StudyArm['presentation'], { kind: 'graph' }>;
  const fork = presentation.nodes[0]!;
  assert.equal(studyArmSchema.safeParse({ ...arm, presentation: { ...presentation, nodes: [{ ...fork, conditions: [] }, ...presentation.nodes.slice(1)] } }).success, false);
  assert.equal(studyArmSchema.safeParse({ ...arm, presentation: { ...presentation, nodes: [{ ...fork, conditions: [fork.kind === 'fork' ? fork.conditions[0] : null] }, ...presentation.nodes.slice(1)] } }).success, false);
  assert.equal(studyArmSchema.safeParse({ ...arm, presentation: { ...presentation, nodes: [{ ...fork, conditions: fork.kind === 'fork' ? [fork.conditions[0], { ...fork.conditions[1]!, id: fork.conditions[0]!.id }] : [] }, ...presentation.nodes.slice(1)] } }).success, false);
  assert.equal(studyArmSchema.safeParse({ ...arm, presentation: { ...presentation, nodes: [{ ...fork, conditions: fork.kind === 'fork' ? [fork.conditions[0], { ...fork.conditions[1]!, entryNodeId: 'missing-node' }] : [] }, ...presentation.nodes.slice(1)] } }).success, false);
  assert.equal(studyArmSchema.safeParse({ ...arm, presentation: { ...presentation, transitions: [...presentation.transitions, { fromNodeId: 'treatment-fork', optionId: 'continue', toNodeId: 'fork-end' }] } }).success, false);
});

test('comparisonKey across fork rejects different question instructions, history policy, and typed interpretation', () => {
  const arm = matchedForkArm();
  const assertSemanticMismatch = (input: StudyArm): void => {
    const parsed = studyArmSchema.safeParse(input);
    assert.equal(parsed.success, false);
    if (!parsed.success) assert.equal(parsed.error.issues.some(({ path, message }) => path[0] === 'tasks' && /comparisonKey/.test(message)), true, parsed.error.message);
  };
  assertSemanticMismatch({ ...arm, tasks: [arm.tasks[0]!, { ...arm.tasks[1]!, instructions: 'Would you keep reading?' }] });
  assertSemanticMismatch({ ...arm, tasks: [arm.tasks[0]!, { ...arm.tasks[1]!, responseHistory: 'omit' }] });

  const choiceFirst = arm.tasks[0]!;
  const choiceSecond = arm.tasks[1]!;
  if (choiceFirst.type !== 'choice' || choiceSecond.type !== 'choice') throw new Error('Fork fixture requires Choice questions.');
  assertSemanticMismatch({ ...arm, tasks: [choiceFirst, { ...choiceSecond, options: { continue: 'Read the next chapter.', stop: 'Stop here.' }, materialOptions: undefined }] });
  assertSemanticMismatch({ ...arm, tasks: [choiceFirst, { ...choiceSecond, options: { stop: 'Stop here.', continue: 'Read the next passage.' }, materialOptions: undefined }] });
  assertSemanticMismatch({ ...arm, tasks: [choiceFirst, { ...choiceSecond, answerKeyOptionId: 'continue', materialOptions: undefined }] });

  const scoreFirst = { id: 'score-with-image', type: 'score' as const, instructions: 'How compelling is the next section?', comparisonKey: 'image-effect', rubric: ['Not compelling', 'Compelling'] };
  const scoreSecond = { ...scoreFirst, id: 'score-without-image', rubric: ['Weak', 'Strong'] };
  assertSemanticMismatch(matchedForkArmWithTasks([scoreFirst, scoreSecond], 'score'));
  const noulFirst = { id: 'noul-with-image', type: 'noul' as const, instructions: 'Would you continue?', comparisonKey: 'image-effect', criteria: { true: 'Would continue reading.', false: 'Would not continue reading.' } };
  const noulSecond = { ...noulFirst, id: 'noul-without-image', criteria: { true: 'Wants the next section.', false: 'Does not want the next section.' } };
  assertSemanticMismatch(matchedForkArmWithTasks([noulFirst, noulSecond], 'noul'));
  const mixedTypedSecond = { id: 'typed-condition-question', type: 'noul' as const, comparisonKey: 'image-effect', instructions: 'Would you continue reading?' };
  const mixed = matchedForkArmWithTasks([choiceFirst, mixedTypedSecond], 'choice');
  assertSemanticMismatch({ ...mixed, presentation: { ...(mixed.presentation as Extract<StudyArm['presentation'], { kind: 'graph' }>), transitions: [
    ...(mixed.presentation as Extract<StudyArm['presentation'], { kind: 'graph' }>).transitions.filter(({ fromNodeId }) => fromNodeId !== 'ask-without-image'),
    { fromNodeId: 'ask-without-image', toNodeId: 'fork-end', when: { type: 'noul', minimum: 0, maximum: 1, minimumInclusive: true, maximumInclusive: true } },
  ] } });

  const duplicateArm = matchedForkArm();
  const duplicateGraph = duplicateArm.presentation as Extract<StudyArm['presentation'], { kind: 'graph' }>;
  const duplicate = studyArmSchema.safeParse({
    ...duplicateArm,
    tasks: [...duplicateArm.tasks, { ...duplicateArm.tasks[0]!, id: 'repeat-image-question' }],
    presentation: {
      ...duplicateGraph,
      maxDecisions: 2,
      nodes: [...duplicateGraph.nodes, { id: 'ask-repeat-image', kind: 'ask', taskId: 'repeat-image-question' }],
      transitions: [
        ...duplicateGraph.transitions.map((edge) => edge.fromNodeId === 'ask-with-image' ? { ...edge, toNodeId: 'ask-repeat-image' } : edge),
        { fromNodeId: 'ask-repeat-image', optionId: 'continue', toNodeId: 'fork-end' },
        { fromNodeId: 'ask-repeat-image', optionId: 'stop', toNodeId: 'fork-end' },
      ],
    },
  });
  assert.equal(duplicate.success, false);
  if (!duplicate.success) assert.equal(duplicate.error.issues.some(({ message }) => /comparisonKey image-effect occurs more than once in fork condition image-present/.test(message)), true, duplicate.error.message);
});

test('runJourney and packet walking fail closed at matched forks before asking either sibling', async () => {
  const arm = matchedForkArm();
  let calls = 0;
  await assert.rejects(runJourney({ arm, profile, ask: async () => { calls += 1; return { choice: 'continue' }; } }), (error: unknown) => error instanceof JourneyExecutionError && /matched fork/i.test(error.message));
  assert.equal(calls, 0);
  const packets: unknown[] = [];
  const walk = walkStudyPackets([arm], [profile], (packet) => packets.push(packet));
  assert.equal(walk.status, 'incomplete');
  assert.equal(walk.incompleteReason, 'Matched forks require durable runtime execution.');
  assert.equal(walk.packetCount, 0);
  assert.deepEqual(packets, []);
});

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
