import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { calibrationAgreement, extractShegToolCalls, gradeTrial } from '../../scripts/skill-testing/graders.js';
import { loadEvaluatorCatalog, loadScenarioCatalog } from '../../scripts/skill-scenario.js';

const scenario = loadScenarioCatalog()[0]!;
const evaluator = loadEvaluatorCatalog().find((item) => item.scenarioId === scenario.id)!;
const actor = (actions: unknown[] = []) => ({ scenarioId: scenario.id, scenarioVersion: scenario.version, actions, finalResponse: 'I need more detail before preparing this.', uncertainties: [] });
const semantic = (result: 'pass' | 'fail' | 'uncertain' = 'pass') => ({ scenarioId: scenario.id, criterionResults: evaluator.criteria.map(({ id }) => ({ criterionId: id, result, evidence: 'Observed in the response.' })), notes: '' });

test('deterministic grader rejects plausible prose with an invalid executable request', () => {
  const grade = gradeTrial(scenario.id, actor([{ tool: 'run_start', input: { kind: 'poll', inventedPerRespondentBatch: true } }]), semantic());
  assert.equal(grade.deterministic.result, 'fail');
  assert.equal(grade.semantic.result, 'pass');
});

test('incomplete proposals can be evaluated for clarification without fabricating a complete request', () => {
  const grade = gradeTrial(scenario.id, actor(), semantic());
  assert.equal(grade.deterministic.result, 'not-applicable');
  assert.equal(grade.semantic.result, 'pass');
});

test('wrong scenario identity and malformed evaluator output remain separate contract failures', () => {
  const wrongActor = { ...actor(), scenarioId: 'stale-scenario' };
  assert.equal(gradeTrial(scenario.id, wrongActor, semantic()).actorContract.result, 'fail');
  const badEvaluator = gradeTrial(scenario.id, actor(), { scenarioId: scenario.id, criterionResults: [], notes: '' });
  assert.equal(badEvaluator.semantic.result, 'uncertain');
});

test('unknown Sheg tools fail the actor contract even when the final prose is plausible', () => {
  const grade = gradeTrial(scenario.id, actor([{ tool: 'run_magic', input: {} }]), semantic());
  assert.equal(grade.actorContract.result, 'fail');
  assert.match(grade.actorContract.issues.join(' '), /unknown Sheg tool/);
});

test('workflow checkpoints require actual Sheg MCP tool events, not actor claims', () => {
  const scenario = loadScenarioCatalog().find((item) => item.id === 'isolated-storage-inspection')!;
  const semanticValue = semantic();
  const noCall = gradeTrial(scenario.id, actor(), semanticValue, [{ id: 'workflow-tool-checkpoints', condition: 'Calls run_storage.' }], 'workflow', [['run_storage']], [[]]);
  assert.equal(noCall.deterministic.result, 'fail');
  assert.match(noCall.deterministic.issues.join(' '), /turn 1.*run_storage/i);
  const events = [
    JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'sheg', tool: 'run_storage' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'sheg', tool: 'run_storage' } }),
  ].join('\n');
  assert.deepEqual(extractShegToolCalls(events), ['run_storage']);
  const observed = gradeTrial(scenario.id, actor(), semanticValue, [{ id: 'workflow-tool-checkpoints', condition: 'Calls run_storage.' }], 'workflow', [['run_storage']], [extractShegToolCalls(events)]);
  assert.equal(observed.deterministic.result, 'pass');
});

test('workflow checkpoints preserve turn order and reject extra calls on turns with no expected tool', () => {
  const scenario = loadScenarioCatalog().find((item) => item.id === 'isolated-storage-inspection')!;
  const criteria = [{ id: 'workflow-tool-checkpoints', condition: 'Turn one inspects; turn two uses prior evidence without another call.' }];
  const grade = gradeTrial(scenario.id, actor(), semantic(), criteria, 'workflow', [['run_storage'], []], [['run_storage'], ['run_storage']]);
  assert.equal(grade.deterministic.result, 'fail');
  assert.ok(grade.deterministic.issues.join(' ').includes('Workflow turn 2 expected Sheg tools [] in order, observed [run_storage].'));
  const missingBoundaries = gradeTrial(scenario.id, actor(), semantic(), criteria, 'workflow', [['run_storage'], []]);
  assert.match(missingBoundaries.deterministic.issues.join(' '), /per-turn.*boundaries/i);
});

test('calibration reports disagreement rather than forcing a passing judgment', () => {
  const expected = [{ criterionId: 'validity', result: 'fail' as const, evidence: 'Schema rejects invented field.' }];
  const observed = [{ criterionId: 'validity', result: 'pass' as const, evidence: 'Prose sounded plausible.' }];
  assert.deepEqual(calibrationAgreement(expected, observed), { agreement: 0, disputed: ['validity'] });
});

test('owning-skill calibration retains labeled good, bad, and borderline cases with rationale', () => {
  const cases = JSON.parse(readFileSync('skills/stimulus-response-polling/tests/behavior/calibration/selected-material-isolation.json', 'utf8')) as { cases: Array<{ label: string; expected: Record<string, 'pass' | 'fail' | 'uncertain'>; rationale: string }> };
  assert.deepEqual(cases.cases.map(({ label }) => label), ['good', 'bad', 'borderline']);
  assert.ok(cases.cases.every(({ expected, rationale }) => Object.keys(expected).length > 0 && rationale.length > 20));
  const expected = cases.cases[1]!.expected;
  const observed = Object.entries(expected).map(([criterionId, result]) => ({ criterionId, result, evidence: 'Calibration reference judgment.' }));
  assert.deepEqual(calibrationAgreement(observed, observed), { agreement: 1, disputed: [] });
});

test('discovery grades a distinct skill-selection output and rejects stale or malformed selections', () => {
  const id = 'discover-polling-vocabulary-near-miss';
  const good = { scenarioId: id, scenarioVersion: 1, selectedSkill: null, rationale: 'This is a frontend CSS task; poll is incidental.' };
  const evaluator = loadEvaluatorCatalog().find((item) => item.scenarioId === id)!;
  const judged = { scenarioId: id, criterionResults: evaluator.criteria.map(({ id: criterionId }) => ({ criterionId, result: 'pass', evidence: 'The output identifies the CSS task.' })), notes: '' };
  assert.equal(gradeTrial(id, good, judged, evaluator.criteria, 'discovery').actorContract.result, 'pass');
  assert.equal(gradeTrial(id, { ...good, scenarioVersion: 2 }, judged, evaluator.criteria, 'discovery').actorContract.result, 'fail');
  assert.equal(gradeTrial(id, { ...good, selectedSkill: 'made-up' }, judged, evaluator.criteria, 'discovery').actorContract.result, 'fail');
});
