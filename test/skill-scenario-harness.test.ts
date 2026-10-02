import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { runEvidencePageSchema } from '../src/domain/run/request.js';
import {
  actorTraceSchema,
  assertReferencePathContained,
  baselineTraceSchema,
  evaluatorResultSchema,
  loadEvaluatorCatalog,
  loadScenarioCatalog,
  renderActorPrompt,
  renderEvaluatorPrompt,
} from '../scripts/skill-scenario.js';

const expectedScenarioIds = [
  'changed-rubric-comparison',
  'independent-dependent-questions',
  'partial-run-selected-question',
  'selected-material-isolation-no-fit',
  'sequence-versus-linear-graph',
  'typed-answer-failure',
];

test('skill behavior catalog has the six versioned scenarios and a paired evaluator for each', () => {
  const scenarios = loadScenarioCatalog();
  const evaluators = loadEvaluatorCatalog();
  const ids = scenarios.map((scenario) => scenario.id).sort();

  assert.deepEqual(ids, expectedScenarioIds);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(evaluators.map((evaluator) => evaluator.scenarioId).sort(), expectedScenarioIds);
  for (const scenario of scenarios) {
    assert.equal(evaluators.find((evaluator) => evaluator.scenarioId === scenario.id)?.version, scenario.version);
  }
});

test('actor prompts include only the owner skill, declared references, user request and controlled evidence', () => {
  const scenario = loadScenarioCatalog().find((candidate) => candidate.id === 'selected-material-isolation-no-fit')!;
  const prompt = renderActorPrompt(scenario.id);
  const evaluator = loadEvaluatorCatalog().find((candidate) => candidate.scenarioId === scenario.id)!;

  assert.ok(prompt.includes('# Stimulus-response polling'));
  assert.ok(prompt.includes(scenario.userRequest));
  assert.ok(prompt.includes(JSON.stringify(scenario.controlledEvidence, null, 2)));
  for (const referencePath of scenario.referencePaths) {
    assert.ok(prompt.includes(referencePath));
  }
  assert.ok(!prompt.includes(JSON.stringify(evaluator.criteria, null, 2)));
  assert.ok(!prompt.includes(JSON.stringify(evaluator.prohibitedClaims, null, 2)));
});

test('evaluator prompts pair the private rubric with the observed actor trace and same controlled evidence', () => {
  const scenario = loadScenarioCatalog().find((candidate) => candidate.id === 'typed-answer-failure')!;
  const evaluator = loadEvaluatorCatalog().find((candidate) => candidate.scenarioId === scenario.id)!;
  const actorTrace = {
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    actions: [],
    finalResponse: 'The valid sibling remains available.',
    uncertainties: [],
  };
  const prompt = renderEvaluatorPrompt(scenario.id, actorTrace);

  assert.ok(prompt.includes(JSON.stringify(evaluator.criteria, null, 2)));
  assert.ok(prompt.includes(JSON.stringify(actorTrace, null, 2)));
  assert.ok(prompt.includes(JSON.stringify(scenario.controlledEvidence, null, 2)));
});

test('evaluator prompts exclude any prior evaluation stored beside the actor trace', () => {
  const prompt = renderEvaluatorPrompt('sequence-versus-linear-graph', {
    scenarioId: 'sequence-versus-linear-graph',
    guided: {
      actor: { scenarioId: 'sequence-versus-linear-graph', finalResponse: 'Observed answer.' },
      evaluator: { criterionResults: [{ criterionId: 'old-judgment', result: 'pass' }], notes: 'Prior evaluator output.' },
    },
  });

  assert.match(prompt, /Observed answer\./);
  assert.doesNotMatch(prompt, /old-judgment|Prior evaluator output/);
});

test('evaluator prompts can select a stored no-guidance control without including the guided actor or prior judgment', () => {
  const prompt = renderEvaluatorPrompt('typed-answer-failure', {
    scenarioId: 'typed-answer-failure',
    guided: { actor: { scenarioId: 'typed-answer-failure', finalResponse: 'Guided actor.' } },
    controls: [{
      actor: { answer: 'Control actor without a scenario ID.' },
      evaluator: { notes: 'Prior control judgment.' },
    }],
  }, { controlIndex: 1 });

  assert.match(prompt, /trace selection: no-guidance control 1/);
  assert.match(prompt, /Control actor without a scenario ID/);
  assert.doesNotMatch(prompt, /Guided actor|Prior control judgment/);
});

test('evaluator prompts accept a raw control output without an embedded scenario ID', () => {
  const prompt = renderEvaluatorPrompt('typed-answer-failure', {
    answer: 'The response failed with invalid_answer.',
  });

  assert.match(prompt, /scenarioId: typed-answer-failure/);
  assert.match(prompt, /trace selection: raw actor output/);
  assert.match(prompt, /The response failed with invalid_answer/);
});

test('scenario CLI replays a stored no-guidance control by one-based index', () => {
  const tracePath = path.join(process.cwd(), 'skills/stimulus-response-polling/tests/behavior/traces/baseline/typed-answer-failure.json');
  const prompt = execFileSync(process.execPath, [
    '--import', 'tsx',
    path.join(process.cwd(), 'scripts/skill-scenario.ts'),
    '--evaluator-prompt', 'typed-answer-failure', tracePath, '--control', '1',
  ], { encoding: 'utf8' });

  assert.match(prompt, /trace selection: no-guidance control 1/);
  assert.match(prompt, /The run is partial: one of two respondents answered/);
  assert.doesNotMatch(prompt, /proposedFollowOns/);
});

test('evaluator refuses to replay a control whose observed scenario ID conflicts with the requested scenario', () => {
  const tracePath = path.join(process.cwd(), 'skills/stimulus-response-polling/tests/behavior/traces/baseline/selected-material-isolation-no-fit.json');
  const trace = JSON.parse(readFileSync(tracePath, 'utf8')) as unknown;

  assert.throws(() => renderEvaluatorPrompt('selected-material-isolation-no-fit', trace, { controlIndex: 1 }), /does not match scenario/);
});

test('evaluator prompt control selector validates the stored one-based index', () => {
  assert.throws(() => renderEvaluatorPrompt('typed-answer-failure', { controls: [] }, { controlIndex: 1 }), /no control at index 1/);
  assert.throws(() => renderEvaluatorPrompt('typed-answer-failure', {}, { controlIndex: 0 }), /positive one-based integer/);
  assert.throws(() => renderEvaluatorPrompt('typed-answer-failure', { scenarioId: 'another-scenario', finalResponse: 'Mismatch.' }), /does not match scenario/);
});

test('evaluator can inspect a JSON trace that violates the actor output schema', () => {
  const prompt = renderEvaluatorPrompt('typed-answer-failure', {
    scenarioId: 'typed-answer-failure',
    scenarioVersion: '1',
    actions: [],
    finalResponse: 'The failure was described.',
  });

  assert.ok(prompt.includes('"scenarioVersion": "1"'));
  assert.ok(prompt.includes('including any contract violations'));
});

test('scenario reference paths cannot escape their owning skill directory', () => {
  assert.throws(() => assertReferencePathContained('study-design', '../../package.json'), /outside.*references/i);
  assert.throws(() => assertReferencePathContained('study-design', 'tests/behavior/evaluators.json'), /references/i);
});

test('actor and evaluator outputs require evidence-bearing structured fields', () => {
  assert.equal(actorTraceSchema.safeParse({
    scenarioId: 'changed-rubric-comparison',
    scenarioVersion: 1,
    actions: [{ tool: 'run_query', input: { runId: 'run-1' } }],
    finalResponse: 'These runs used different rubrics.',
    uncertainties: [],
  }).success, true);
  assert.equal(actorTraceSchema.safeParse({ finalResponse: 'done' }).success, false);

  assert.equal(evaluatorResultSchema.safeParse({
    scenarioId: 'changed-rubric-comparison',
    criterionResults: [{ criterionId: 'rubric-change-is-visible', result: 'pass', evidence: 'The tasks differ.' }],
    notes: '',
  }).success, true);
  assert.equal(evaluatorResultSchema.safeParse({
    scenarioId: 'changed-rubric-comparison',
    criterionResults: [{ criterionId: 'rubric-change-is-visible', result: 'pass', evidence: '' }],
    notes: '',
  }).success, false);
});

test('baseline trace files carry valid trial metadata and explicitly mark simulation-only evidence', () => {
  for (const skill of ['study-design', 'stimulus-response-polling']) {
    const directory = path.join(process.cwd(), 'skills', skill, 'tests', 'behavior', 'traces', 'baseline');
    for (const name of readdirSync(directory).filter((file) => file.endsWith('.json'))) {
      const trace = baselineTraceSchema.parse(JSON.parse(readFileSync(path.join(directory, name), 'utf8')));
      assert.equal(trace.guided.actor.scenarioId, trace.scenarioId);
      assert.equal(trace.guided.evaluator.scenarioId, trace.scenarioId);
      assert.equal(trace.guided.actor.scenarioVersion, trace.scenarioVersion);
      assert.equal(trace.simulationOnly, true);
      assert.equal(trace.toolUseAudit, 'not-captured');
      const scenario = loadScenarioCatalog().find((item) => item.id === trace.scenarioId)!;
      assert.equal(trace.scenarioVersion, scenario.version);
      const suppliedFiles = [`skills/${skill}/SKILL.md`, ...scenario.referencePaths.map((reference) => `skills/${skill}/${reference}`)];
      const currentHashes = Object.fromEntries(suppliedFiles.map((file) => [
        file,
        createHash('sha256').update(readFileSync(path.join(process.cwd(), file))).digest('hex'),
      ]));
      assert.deepEqual(trace.skillReferenceHashes, currentHashes);
    }
  }
});

test('partial selected-question fixture matches the current run query contract', () => {
  const scenario = loadScenarioCatalog().find((item) => item.id === 'partial-run-selected-question')!;
  const evidence = scenario.controlledEvidence as { queryResult: unknown };
  const queryResult = runEvidencePageSchema.parse(evidence.queryResult);

  assert.equal(queryResult.sourceStatus, 'cancelled');
  assert.equal(queryResult.sourceComplete, false);
  assert.deepEqual(queryResult.items.map((item) => item.status), ['answered', 'unreached']);
});

test('selected-material fixture matches the current run query contract and omits material for no-fit', () => {
  const scenario = loadScenarioCatalog().find((item) => item.id === 'selected-material-isolation-no-fit')!;
  const evidence = scenario.controlledEvidence as { queryResult: unknown };
  const queryResult = runEvidencePageSchema.parse(evidence.queryResult);

  assert.deepEqual(queryResult.items.map((item) => item.status), ['answered', 'answered', 'answered']);
  assert.deepEqual(queryResult.items.map((item) => item.selectedMaterial?.materialId), ['p2', undefined, 'p5']);
  assert.equal(queryResult.items[0]?.selectedMaterial?.text, 'Exact paragraph two.');
  assert.equal(queryResult.items[2]?.selectedMaterial?.text, 'Exact paragraph five.');
  const choiceResults = queryResult.items.flatMap((item) => item.result?.type === 'choice' ? [item.result] : []);
  assert.equal(choiceResults.length, queryResult.items.length);
  const sharedOptions = Object.keys(choiceResults[0]!.probabilities);
  for (const result of choiceResults) assert.deepEqual(Object.keys(result.probabilities), sharedOptions);
});
