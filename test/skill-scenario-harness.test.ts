import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
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
  selectScenarios,
} from '../scripts/skill-scenario.js';

const expectedScenarioIds = [
  'changed-rubric-comparison',
  'cumulative-journey-material',
  'cumulative-journey-material-heldout',
  'discover-polling-frontend-near-miss',
  'discover-polling-positive',
  'discover-polling-vocabulary-near-miss',
  'discover-study-design-positive',
  'independent-dependent-questions',
  'isolated-storage-inspection',
  'live-storage-inspection',
  'live-storage-inspection-heldout',
  'partial-journey-recovery',
  'partial-run-selected-question',
  'purposeful-input-variation',
  'selected-material-follow-on',
  'selected-material-isolation-heldout',
  'selected-material-isolation-no-fit',
  'sequence-versus-linear-graph',
  'typed-answer-failure',
];

test('skill behavior catalog has paired versioned scenarios and evaluators', () => {
  const scenarios = loadScenarioCatalog();
  const evaluators = loadEvaluatorCatalog();
  const ids = scenarios.map((scenario) => scenario.id).sort();

  assert.deepEqual(ids, expectedScenarioIds);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(evaluators.map((evaluator) => evaluator.scenarioId).sort(), expectedScenarioIds);
  for (const scenario of scenarios) {
    assert.ok(scenario.tags.length > 0, `${scenario.id} needs at least one selectable tag`);
    assert.equal(evaluators.find((evaluator) => evaluator.scenarioId === scenario.id)?.version, scenario.version);
  }
});

test('scenario selection intersects owner, tags, and guidance paths and can include shared safeguards', () => {
  const selected = selectScenarios({
    ownerSkill: 'stimulus-response-polling',
    tags: ['lifecycle'],
    guidancePaths: ['references/run-and-recovery.md'],
    includeSharedSafeguards: true,
  });
  const ids = selected.map(({ id }) => id);
  assert.deepEqual(ids, [
    'partial-run-selected-question', 'typed-answer-failure', 'purposeful-input-variation', 'selected-material-isolation-no-fit', 'selected-material-follow-on',
    'cumulative-journey-material', 'cumulative-journey-material-heldout',
    'live-storage-inspection-heldout', 'live-storage-inspection',
  ]);
  assert.throws(() => selectScenarios({}), /owner, tag, or guidance path/);
});

test('actor prompts include only the owner skill, declared references, user request and controlled evidence', () => {
  const scenario = loadScenarioCatalog().find((candidate) => candidate.id === 'selected-material-isolation-no-fit')!;
  const prompt = renderActorPrompt(scenario.id);
  const evaluator = loadEvaluatorCatalog().find((candidate) => candidate.scenarioId === scenario.id)!;

  assert.ok(prompt.includes('# Stimulus-response polling'));
  assert.ok(prompt.includes(scenario.userRequest));
  assert.ok(prompt.includes(JSON.stringify(scenario.controlledEvidence, null, 2)));
  assert.match(prompt, /"finalResponse": string.*"uncertainties": string\[\]/);
  assert.match(prompt, /Keep finalResponse as a string/);
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
  assert.match(controlPrompt.prompt, /"finalResponse": string.*"uncertainties": string\[\]/);
  assert.match(controlPrompt.prompt, /Keep finalResponse as a string/);
  assert.doesNotMatch(controlPrompt.prompt, /Current skill and declared references|# Stimulus-response polling/);
  assert.match(controlPrompt.sha256, /^[a-f0-9]{64}$/);
});

test('typed recovery scenario supplies the routed recovery guidance it asks the actor to apply', () => {
  const scenario = loadScenarioCatalog().find((candidate) => candidate.id === 'typed-answer-failure')!;
  const prompt = renderActorPrompt(scenario.id);

  assert.ok(scenario.referencePaths.includes('references/run-and-recovery.md'));
  assert.ok(prompt.includes('when the original call allowance permits'));
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

test('evaluator rejects malformed stored wrappers instead of treating them as raw actor output', () => {
  assert.throws(() => renderEvaluatorPrompt('sequence-versus-linear-graph', {
    scenarioId: 'sequence-versus-linear-graph',
    scenarioVersion: 2,
    guided: { actor: { finalResponse: 'Observed answer.' } },
    controls: [null],
  }), /Stored trace wrapper is malformed/);
});

test('evaluator requires a guided actor when replaying a stored wrapper without a control selector', () => {
  assert.throws(() => renderEvaluatorPrompt('typed-answer-failure', {
    scenarioId: 'typed-answer-failure',
    scenarioVersion: 6,
    controls: [{
      actor: { finalResponse: 'Control output.' },
      evaluator: { notes: 'PRIVATE_OLD_VERDICT' },
    }],
  }), /Stored trace wrapper has no guided actor/);
});

test('evaluator prompts can select a stored no-guidance control without including the guided actor or prior judgment', () => {
  const prompt = renderEvaluatorPrompt('typed-answer-failure', {
    scenarioId: 'typed-answer-failure',
    scenarioVersion: 6,
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
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'sheg-scenario-control-'));
  const tracePath = path.join(scratch, 'synthetic-trace.json');
  try {
    writeFileSync(tracePath, JSON.stringify({
      scenarioId: 'typed-answer-failure', scenarioVersion: 6,
      controls: [{ actor: { scenarioId: 'typed-answer-failure', finalResponse: 'The response failed with invalid_answer.' } }],
    }));
    const prompt = execFileSync(process.execPath, [
      '--import', 'tsx',
      path.join(process.cwd(), 'scripts/skill-scenario.ts'),
      '--evaluator-prompt', 'typed-answer-failure', tracePath, '--control', '1',
    ], { encoding: 'utf8' });
    assert.match(prompt, /trace selection: no-guidance control 1/);
    assert.match(prompt, /invalid_answer/);
    assert.doesNotMatch(prompt, /proposedFollowOns/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('evaluator refuses to replay a control whose actor scenario ID conflicts with its wrapper', () => {
  assert.throws(() => renderEvaluatorPrompt('selected-material-isolation-no-fit', {
    scenarioId: 'selected-material-isolation-no-fit',
    scenarioVersion: 10,
    controls: [{ actor: { scenarioId: 'control_selected_material', finalResponse: 'Wrong identity.' } }],
  }, { controlIndex: 1 }), /Actor trace does not match scenario/);
});

test('evaluator prompt control selector validates the stored one-based index', () => {
  assert.throws(() => renderEvaluatorPrompt('typed-answer-failure', {
    scenarioId: 'typed-answer-failure', scenarioVersion: 6, controls: [],
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
  assert.throws(() => renderEvaluatorPrompt('selected-material-isolation-no-fit', {
    scenarioId: 'selected-material-isolation-no-fit', scenarioVersion: 3,
    guided: { actor: { scenarioId: 'selected-material-isolation-no-fit', scenarioVersion: 3, finalResponse: 'Synthetic stale trace.' } },
  }), /version 3.*current version 10/);
});

test('evaluator rejects raw actors that declare a stale scenario version', () => {
  assert.throws(() => renderEvaluatorPrompt('typed-answer-failure', {
    scenarioId: 'typed-answer-failure',
    scenarioVersion: 2,
    finalResponse: 'Stale actor output.',
  }), /version 2.*current version 6/);
});

test('evaluator can inspect a JSON trace that violates the actor output schema', () => {
  const prompt = renderEvaluatorPrompt('typed-answer-failure', {
    scenarioId: 'typed-answer-failure',
    scenarioVersion: 6,
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

test('legacy trace schema validates a synthetic wrapper without storing campaign output', () => {
  const scenario = loadScenarioCatalog().find((item) => item.id === 'typed-answer-failure')!;
  const evaluator = loadEvaluatorCatalog().find((item) => item.scenarioId === scenario.id)!;
  const trace = baselineTraceSchema.parse({
    scenarioId: scenario.id, scenarioVersion: scenario.version, trialId: 'synthetic-contract', mode: 'guided',
    model: 'fixture-model', reasoning: 'medium', skillReferenceHashes: { 'SKILL.md': 'a'.repeat(64) },
    guided: {
      actor: { scenarioId: scenario.id, scenarioVersion: scenario.version, actions: [], finalResponse: 'Synthetic behavior fixture.', uncertainties: [] },
      evaluator: { scenarioId: scenario.id, criterionResults: evaluator.criteria.map(({ id }) => ({ criterionId: id, result: 'uncertain', evidence: 'Synthetic test data.' })), notes: '' },
    },
    controls: [], simulationOnly: true, toolUseAudit: 'not-captured',
  });
  assert.equal(trace.guided.actor.scenarioId, scenario.id);
  assert.equal(trace.guided.actor.scenarioVersion, scenario.version);
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
  assert.deepEqual(queryResult.lifecycle, { state: 'stopped', resume: { eligible: true } });
  assert.deepEqual(queryResult.items.map((item) => item.status), ['answered', 'answered']);
  assert.deepEqual(queryResult.items.map((item) => item.result?.type === 'choice' ? item.result.choice : undefined), ['A', 'B']);
  assert.equal(queryResult.totalMatches, queryResult.items.length);
  assert.deepEqual(queryResult.matchedCoverage, { evaluations: { total: 2, pending: 0, answered: 2, failed: 0, unreached: 0 },
    representedRespondents: 2, selectedMaterials: { evaluations: 0, respondents: 0, distinctMaterials: 0 } });
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
    statusView: { status: string; usedCalls: number; maxCalls: number; lifecycle: unknown };
    answersView: { items: Array<{ status: string; failure?: { code: string; message: string; detail?: unknown } }> };
  };
  const failedAnswer = evidence.answersView.items.find((item) => item.status === 'failed');

  assert.equal(evidence.statusView.status, 'partial');
  assert.equal(evidence.statusView.usedCalls, evidence.statusView.maxCalls);
  assert.deepEqual(evidence.statusView.lifecycle, { state: 'stopped', resume: { eligible: false, reason: 'call_allowance_exhausted' } });
  assert.deepEqual(failedAnswer?.failure, {
    code: 'invalid_answer',
    message: 'The selected option was not offered by this question.',
    detail: { reason: 'unknown_option', field: 'choice', constraint: 'offered_option' },
  });
});

test('selected-material fixture matches the current run query contract and omits material for no-fit', () => {
  const scenario = loadScenarioCatalog().find((item) => item.id === 'selected-material-isolation-no-fit')!;
  const evidence = scenario.controlledEvidence as { pullQuote: string; sourceQuestion: { id: string; type: string; options: string[] }; followOnQuestion: { id: string; type: string }; followOnState: { mode: string; priorTurnVisibility: string; includeSelectedMaterial: boolean }; respondentProfiles: Array<{ respondentId: string; profile: string }>; queryResult: unknown };
  const queryResult = runEvidencePageSchema.parse(evidence.queryResult);

  assert.deepEqual(queryResult.items.map((item) => item.status), ['answered', 'answered', 'answered']);
  assert.deepEqual(queryResult.items.map((item) => item.selectedMaterial?.materialId), ['p2', undefined, 'p5']);
  assert.deepEqual(queryResult.matchedCoverage, { evaluations: { total: 3, pending: 0, answered: 3, failed: 0, unreached: 0 },
    representedRespondents: 3, selectedMaterials: { evaluations: 2, respondents: 2, distinctMaterials: 2 } });
  assert.equal(new Set(evidence.respondentProfiles.map(({ profile }) => profile)).size, 3);
  assert.equal(new Set(queryResult.items.flatMap((item) => item.selectedMaterial ? [item.selectedMaterial.materialId] : [])).size, 2);
  assert.equal(evidence.pullQuote, 'A city is a promise people keep making to each other.');
  assert.deepEqual(evidence.sourceQuestion, { id: 'q-pull-quote', type: 'choice', prompt: 'Which paragraph best represents the pull quote?', options: ['p2', 'p5', 'no-fit'] });
  assert.deepEqual(evidence.followOnQuestion, { id: 'quote-fit', type: 'noul', prompt: 'Does this paragraph express the pull quote?' });
  assert.deepEqual(evidence.followOnState, { mode: 'fresh-material', priorTurnVisibility: 'empty', includeSelectedMaterial: true });
  assert.equal(queryResult.items[0]?.selectedMaterial?.text, 'Exact paragraph two.');
  assert.equal(queryResult.items[2]?.selectedMaterial?.text, 'Exact paragraph five.');
  const choiceResults = queryResult.items.flatMap((item) => item.result?.type === 'choice' ? [item.result] : []);
  assert.equal(choiceResults.length, queryResult.items.length);
  const sharedOptions = Object.keys(choiceResults[0]!.probabilities);
  for (const result of choiceResults) assert.deepEqual(Object.keys(result.probabilities), sharedOptions);
});

test('held-out live inspection uses distinct wording with the same read-only evidence contract', () => {
  const scenarios = loadScenarioCatalog();
  const primary = scenarios.find((scenario) => scenario.id === 'live-storage-inspection')!;
  const heldout = scenarios.find((scenario) => scenario.id === 'live-storage-inspection-heldout')!;
  const evaluators = loadEvaluatorCatalog();
  const primaryEvaluator = evaluators.find((evaluator) => evaluator.scenarioId === primary.id)!;
  const heldoutEvaluator = evaluators.find((evaluator) => evaluator.scenarioId === heldout.id)!;
  assert.equal(heldout.ownerSkill, primary.ownerSkill);
  assert.notEqual(heldout.userRequest, primary.userRequest);
  assert.deepEqual(heldoutEvaluator.criteria, primaryEvaluator.criteria);
  assert.deepEqual(heldoutEvaluator.prohibitedClaims, primaryEvaluator.prohibitedClaims);
});

test('held-out material-history case changes wording while preserving evidence and rubric', () => {
  const scenarios = loadScenarioCatalog();
  const primary = scenarios.find((scenario) => scenario.id === 'cumulative-journey-material')!;
  const heldout = scenarios.find((scenario) => scenario.id === 'cumulative-journey-material-heldout')!;
  const evaluators = loadEvaluatorCatalog();
  const primaryEvaluator = evaluators.find((evaluator) => evaluator.scenarioId === primary.id)!;
  const heldoutEvaluator = evaluators.find((evaluator) => evaluator.scenarioId === heldout.id)!;
  assert.notEqual(heldout.userRequest, primary.userRequest);
  assert.deepEqual(heldout.controlledEvidence, primary.controlledEvidence);
  assert.deepEqual(heldoutEvaluator.criteria, primaryEvaluator.criteria);
  assert.deepEqual(heldoutEvaluator.prohibitedClaims, primaryEvaluator.prohibitedClaims);
});
