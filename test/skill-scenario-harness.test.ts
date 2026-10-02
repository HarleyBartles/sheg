import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
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
  assert.throws(() => assertReferencePathContained('study-design', '../../package.json'), /outside.*skill/i);
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
    }
  }
});
