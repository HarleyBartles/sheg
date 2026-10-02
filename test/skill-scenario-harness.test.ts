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
  renderControlPrompt,
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

test('no-guidance control prompts preserve the scenario request and evidence without skill text', () => {
  const scenario = loadScenarioCatalog().find((candidate) => candidate.id === 'typed-answer-failure')!;
  const controlPrompt = renderControlPrompt(scenario.id);

  assert.ok(controlPrompt.prompt.includes(scenario.userRequest));
  assert.ok(controlPrompt.prompt.includes(JSON.stringify(scenario.controlledEvidence, null, 2)));
  assert.doesNotMatch(controlPrompt.prompt, /Current skill and declared references|# Stimulus-response polling/);
  assert.match(controlPrompt.sha256, /^[a-f0-9]{64}$/);
});

test('scenario CLI emits a reproducible no-guidance control prompt and digest', () => {
  const output = execFileSync(process.execPath, [
    '--import', 'tsx',
    path.join(process.cwd(), 'scripts/skill-scenario.ts'),
    '--control-prompt', 'typed-answer-failure',
  ], { encoding: 'utf8' });
  const control = JSON.parse(output) as { prompt: string; sha256: string };

  assert.equal(control.sha256, renderControlPrompt('typed-answer-failure').sha256);
  assert.ok(control.prompt.includes('One respondent\'s answer failed with invalid_answer'));
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
    scenarioVersion: 2,
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
    scenarioVersion: 4,
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
  assert.match(prompt, /invalid_answer/);
  assert.doesNotMatch(prompt, /proposedFollowOns/);
});

test('evaluator refuses to replay a control whose actor scenario ID conflicts with its wrapper', () => {
  assert.throws(() => renderEvaluatorPrompt('selected-material-isolation-no-fit', {
    scenarioId: 'selected-material-isolation-no-fit',
    scenarioVersion: 4,
    controls: [{ actor: { scenarioId: 'control_selected_material', finalResponse: 'Wrong identity.' } }],
  }, { controlIndex: 1 }), /Actor trace does not match scenario/);
});

test('evaluator prompt control selector validates the stored one-based index', () => {
  assert.throws(() => renderEvaluatorPrompt('typed-answer-failure', {
    scenarioId: 'typed-answer-failure', scenarioVersion: 4, controls: [],
  }, { controlIndex: 1 }), /no control at index 1/);
  assert.throws(() => renderEvaluatorPrompt('typed-answer-failure', {}, { controlIndex: 0 }), /positive one-based integer/);
  assert.throws(() => renderEvaluatorPrompt('typed-answer-failure', { scenarioId: 'another-scenario', finalResponse: 'Mismatch.' }), /does not match scenario/);
  assert.throws(() => renderEvaluatorPrompt('typed-answer-failure', { scenarioId: '', finalResponse: 'Empty identity.' }), /does not match scenario/);
});

test('evaluator rejects a wrapped trace from another scenario before selecting its actor', () => {
  assert.throws(() => renderEvaluatorPrompt('typed-answer-failure', {
    scenarioId: 'independent-dependent-questions',
    scenarioVersion: 1,
    controls: [{ actor: { finalResponse: 'Wrong scenario control.' } }],
  }, { controlIndex: 1 }), /Stored trace does not match scenario/);
});

test('evaluator rejects archived versions of a scenario before selecting an actor', () => {
  const tracePath = path.join(process.cwd(), 'skills/stimulus-response-polling/tests/behavior/traces/archive/selected-material-isolation-no-fit-v3.json');
  const trace = JSON.parse(readFileSync(tracePath, 'utf8')) as unknown;

  assert.throws(() => renderEvaluatorPrompt('selected-material-isolation-no-fit', trace), /version 3.*current version 4/);
});

test('evaluator rejects raw actors that declare a stale scenario version', () => {
  assert.throws(() => renderEvaluatorPrompt('typed-answer-failure', {
    scenarioId: 'typed-answer-failure',
    scenarioVersion: 2,
    finalResponse: 'Stale actor output.',
  }), /version 2.*current version 4/);
});

test('evaluator can inspect a JSON trace that violates the actor output schema', () => {
  const prompt = renderEvaluatorPrompt('typed-answer-failure', {
    scenarioId: 'typed-answer-failure',
    scenarioVersion: 4,
    actions: [{ tool: 4 }],
    finalResponse: 'The failure was described.',
  });

  assert.ok(prompt.includes('"tool": 4'));
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
      for (const control of trace.controls) {
        assert.equal(control.inputPromptSha256, renderControlPrompt(trace.scenarioId).sha256);
      }
    }
  }
});

test('partial selected-question fixture separates complete Q2 evidence from a failed Q1 sibling', () => {
  const scenario = loadScenarioCatalog().find((item) => item.id === 'partial-run-selected-question')!;
  const evidence = scenario.controlledEvidence as {
    queryResult: unknown;
    siblingFailure: { respondentId: string; questionId: string; status: string; failureCode: string };
  };
  const queryResult = runEvidencePageSchema.parse(evidence.queryResult);

  assert.equal(queryResult.sourceStatus, 'partial');
  assert.equal(queryResult.sourceComplete, false);
  assert.deepEqual(queryResult.items.map((item) => item.status), ['answered', 'answered']);
  assert.deepEqual(queryResult.items.map((item) => item.result?.type === 'choice' ? item.result.choice : undefined), ['A', 'B']);
  assert.equal(queryResult.totalMatches, queryResult.items.length);
  assert.deepEqual(queryResult.coverage, {
    totalEvaluations: 3,
    completedEvaluations: 2,
    failedEvaluations: 1,
    respondents: { total: 2, active: 1, completed: 1, failed: 0, unreached: 0 },
  });
  const siblingFailure = evidence.siblingFailure;
  assert.deepEqual(siblingFailure, { respondentId: 'r1', questionId: 'Q1', status: 'failed', failureCode: 'invalid_answer' });
});

test('typed answer recovery fixture has a precise failure and an exhausted original call allowance', () => {
  const scenario = loadScenarioCatalog().find((item) => item.id === 'typed-answer-failure')!;
  const evidence = scenario.controlledEvidence as {
    statusView: { status: string; usedCalls: number; maxCalls: number };
    answersView: { items: Array<{ status: string; failure?: { code: string; message: string } }> };
  };
  const failedAnswer = evidence.answersView.items.find((item) => item.status === 'failed');

  assert.equal(evidence.statusView.status, 'partial');
  assert.equal(evidence.statusView.usedCalls, evidence.statusView.maxCalls);
  assert.deepEqual(failedAnswer?.failure, {
    code: 'invalid_answer',
    message: 'The provider returned an invalid answer for this question.',
  });
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
