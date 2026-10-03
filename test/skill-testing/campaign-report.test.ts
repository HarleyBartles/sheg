import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareCampaign, type CampaignConfig } from '../../scripts/skill-testing/contracts.js';
import { compareCampaigns, gradeBlindComparisons, gradeCampaign, renderCampaignReport, collectCampaignReport } from '../../scripts/skill-testing/report.js';
import { runCampaign, type CampaignAdapter } from '../../scripts/skill-testing/runner.js';

function config(id: string, model = 'test-model'): CampaignConfig {
  return {
    id, scenarioId: 'selected-material-isolation-no-fit', suite: 'focused', classification: 'regression', repetitions: 2,
    concurrency: 1, timeoutMs: 5000, execution: { adapter: 'fake', model },
    arms: [{ id: 'candidate', guidanceRoot: path.resolve('skills/stimulus-response-polling'), referencePaths: ['references/run-and-recovery.md'] }],
  };
}
function actor(finalResponse: string): string {
  return JSON.stringify({ scenarioId: 'selected-material-isolation-no-fit', scenarioVersion: 5, actions: [], finalResponse, uncertainties: [] });
}

test('report separates runtime errors from behavioral denominators and escapes actor HTML', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sheg-campaign-report-'));
  try {
    const campaign = path.join(root, 'candidate');
    const manifest = prepareCampaign(config('report-test'), campaign);
    let calls = 0;
    const adapter: CampaignAdapter = { async execute() {
      calls += 1;
      if (calls === 1) throw new Error('offline runtime failure');
      return { status: 'completed', exitCode: 0, rawEvents: '', rawFinalMessage: actor('<script>nope</script>'), rawStderr: '', sessionId: null, observedSettings: {} };
    } };
    await runCampaign(campaign, adapter);
    let judgePrompt = '';
    await gradeCampaign(campaign, { async execute(input) {
      judgePrompt = input.prompt;
      const judged = { scenarioId: manifest.scenarioId, criterionResults: manifest.evaluationBasis.criteria.map(({ id }) => ({ criterionId: id, result: 'pass', evidence: 'The response asks for clarification.' })), notes: '' };
      return { status: 'completed', exitCode: 0, rawEvents: '', rawFinalMessage: JSON.stringify(judged), rawStderr: '', sessionId: 'judge-session', observedSettings: { model: 'judge-model' } };
    } });
    const report = collectCampaignReport(campaign);
    const rendered = renderCampaignReport(report);
    assert.equal(report.summary.runtimeErrors, 1);
    assert.equal(report.summary.sampleSize, 2);
    assert.equal(report.summary.completeTrialPasses, 1);
    assert.equal(report.summary.semanticPasses, 1);
    assert.equal(report.summary.semanticFailures, 0);
    assert.equal(report.summary.semanticUncertain, 0);
    assert.equal(report.summary.semanticNotRun, 0);
    assert.equal((report.summary.criterionCounts as Record<string, { pass: number }>)[manifest.evaluationBasis.criteria[0]!.id]!.pass, 1);
    assert.doesNotMatch(judgePrompt, /candidate skill body|Arm: candidate|candidate label/);
    assert.match(judgePrompt, /Private evaluation criteria/);
    assert.match(rendered.html, /&lt;script&gt;nope&lt;\/script&gt;/);
    assert.doesNotMatch(rendered.html, /<script>nope/);
    assert.match(rendered.html, /raw output/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('campaign comparison blocks changed execution inputs', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sheg-campaign-compare-'));
  try {
    prepareCampaign(config('baseline'), path.join(root, 'baseline'));
    prepareCampaign(config('candidate', 'other-model'), path.join(root, 'candidate'));
    assert.throws(() => compareCampaigns(path.join(root, 'baseline'), path.join(root, 'candidate'), { baselineArmId: 'candidate', candidateArmId: 'candidate' }), /execution/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('campaign comparison blocks changed evaluator adapter and ambient runtime identities', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sheg-campaign-runtime-'));
  try {
    const baseline = path.join(root, 'baseline');
    const candidate = path.join(root, 'candidate');
    prepareCampaign({ ...config('runtime-baseline'), repetitions: 1 }, baseline);
    prepareCampaign({ ...config('runtime-candidate'), repetitions: 1 }, candidate);
    const adapter = (version: string): CampaignAdapter => ({
      async preflight() { return { adapter: 'codex', version, shegMcpConfigSha256: 'fixed-config' }; },
      async execute() { return { status: 'completed', exitCode: 0, rawEvents: '', rawFinalMessage: actor('Captured.'), rawStderr: '', sessionId: null, observedSettings: {} }; },
    });
    await runCampaign(baseline, adapter('actor-runtime'));
    await runCampaign(candidate, adapter('actor-runtime'));
    await gradeCampaign(baseline, adapter('judge-runtime-1'));
    await gradeCampaign(candidate, adapter('judge-runtime-2'));
    assert.throws(() => compareCampaigns(baseline, candidate, { baselineArmId: 'candidate', candidateArmId: 'candidate' }), /adapter and ambient runtime identity/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reporting and comparison reject a campaign manifest edited after preparation', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sheg-campaign-manifest-integrity-'));
  try {
    const baseline = path.join(root, 'baseline');
    const candidate = path.join(root, 'candidate');
    prepareCampaign(config('baseline-integrity'), baseline);
    prepareCampaign(config('candidate-integrity'), candidate);
    const manifestPath = path.join(candidate, 'campaign.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { execution: Record<string, unknown> };
    manifest.execution.model = 'edited-after-preparation';
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.throws(() => collectCampaignReport(candidate), /frozen campaign manifest/i);
    assert.throws(() => compareCampaigns(baseline, candidate, { baselineArmId: 'candidate', candidateArmId: 'candidate' }), /frozen campaign manifest/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('campaign comparison reports per-criterion count changes', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sheg-campaign-criterion-delta-'));
  try {
    const baseline = path.join(root, 'baseline');
    const candidate = path.join(root, 'candidate');
    const baselineManifest = prepareCampaign({ ...config('baseline'), repetitions: 1 }, baseline);
    const candidateManifest = prepareCampaign({ ...config('candidate'), repetitions: 1 }, candidate);
    const actorAdapter: CampaignAdapter = { async execute() { return { status: 'completed', exitCode: 0, rawEvents: '', rawFinalMessage: actor('I would ask for the missing selections first.'), rawStderr: '', sessionId: null, observedSettings: {} }; } };
    await runCampaign(baseline, actorAdapter);
    await runCampaign(candidate, actorAdapter);
    const gradeWith = (manifest: typeof baselineManifest, result: 'pass' | 'fail'): CampaignAdapter => ({ async execute() {
      const judged = { scenarioId: manifest.scenarioId, criterionResults: manifest.evaluationBasis.criteria.map(({ id }) => ({ criterionId: id, result, evidence: `Observed ${result} evidence.` })), notes: '' };
      return { status: 'completed', exitCode: 0, rawEvents: '', rawFinalMessage: JSON.stringify(judged), rawStderr: '', sessionId: 'judge', observedSettings: {} };
    } });
    await gradeCampaign(baseline, gradeWith(baselineManifest, 'fail'));
    await gradeCampaign(candidate, gradeWith(candidateManifest, 'pass'));
    const comparison = compareCampaigns(baseline, candidate, { baselineArmId: 'candidate', candidateArmId: 'candidate' }) as { criterionChanges: Array<{ criterionId: string; baseline: { pass: number; fail: number }; candidate: { pass: number; fail: number }; delta: { pass: number; fail: number } }> };
    assert.equal(comparison.criterionChanges[0]!.baseline.fail, 1);
    assert.equal(comparison.criterionChanges[0]!.candidate.pass, 1);
    assert.equal(comparison.criterionChanges[0]!.delta.fail, -1);
    assert.equal(comparison.criterionChanges[0]!.delta.pass, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('evaluator timeouts are uncertain judgments and remain separate from actor runtime errors', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sheg-judge-timeout-'));
  try {
    const campaign = path.join(root, 'campaign');
    prepareCampaign({ ...config('judge-timeout'), repetitions: 1 }, campaign);
    await runCampaign(campaign, { async execute() {
      return { status: 'completed', exitCode: 0, rawEvents: '', rawFinalMessage: actor('I would ask for the missing selections first.'), rawStderr: '', sessionId: 'actor', observedSettings: {} };
    } });
    await gradeCampaign(campaign, { async execute() {
      return { status: 'timed-out', exitCode: null, rawEvents: '', rawFinalMessage: '', rawStderr: '', sessionId: null, observedSettings: {} };
    } });
    const report = collectCampaignReport(campaign);
    assert.equal(report.summary.runtimeErrors, 0);
    assert.equal(report.summary.semanticNotRun, 0);
    assert.equal(report.trials[0]!.grade?.semantic.result, 'uncertain');
    assert.match(report.trials[0]!.grade?.semantic.error ?? '', /timed-out/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('grading resumes from retained evaluator output when the grade file is missing', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sheg-grade-recovery-'));
  try {
    const campaign = path.join(root, 'campaign');
    const manifest = prepareCampaign({ ...config('grade-recovery'), repetitions: 1 }, campaign);
    await runCampaign(campaign, { async execute() { return { status: 'completed', exitCode: 0, rawEvents: '', rawFinalMessage: actor('The request needs a clarification.'), rawStderr: '', sessionId: 'actor', observedSettings: {} }; } });
    const judged = { scenarioId: manifest.scenarioId, criterionResults: manifest.evaluationBasis.criteria.map(({ id }) => ({ criterionId: id, result: 'pass', evidence: 'Observed output.' })), notes: '' };
    await gradeCampaign(campaign, { async execute() { return { status: 'completed', exitCode: 0, rawEvents: '', rawFinalMessage: JSON.stringify(judged), rawStderr: '', sessionId: 'judge', observedSettings: {} }; } });
    const trialDirectory = readdirSync(path.join(campaign, 'attempts'))[0]!;
    const attemptDirectory = readdirSync(path.join(campaign, 'attempts', trialDirectory))[0]!;
    const evaluatorDirectory = path.join(campaign, 'attempts', trialDirectory, attemptDirectory, 'evaluator');
    rmSync(path.join(evaluatorDirectory, 'grade.json'));
    let redispatched = 0;
    const resumed = await gradeCampaign(campaign, { async execute() { redispatched += 1; throw new Error('must reuse captured evaluator output'); } });
    assert.equal(redispatched, 0);
    assert.equal(resumed, 1);
    assert.ok(existsSync(path.join(evaluatorDirectory, 'grade.json')));
    const recoveredTrial = collectCampaignReport(campaign).trials[0]!;
    assert.equal(recoveredTrial.grade?.actorContract.result, 'pass');
    assert.equal(recoveredTrial.responseExcerpt, 'The request needs a clarification.');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('campaign resume rejects a changed effective concurrency', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sheg-concurrency-identity-'));
  try {
    const campaign = path.join(root, 'campaign');
    prepareCampaign({ ...config('concurrency-identity'), repetitions: 2, concurrency: 2 }, campaign);
    const adapter: CampaignAdapter = { async execute() { return { status: 'completed', exitCode: 0, rawEvents: '', rawFinalMessage: actor('Done.'), rawStderr: '', sessionId: null, observedSettings: {} }; } };
    await runCampaign(campaign, adapter, { concurrency: 1 });
    await assert.rejects(runCampaign(campaign, adapter, { concurrency: 2 }), /runtime identity changed/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workflow report deterministically rejects a missing MCP call and accepts an observed Sheg event', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sheg-workflow-tool-report-'));
  try {
    const campaign = path.join(root, 'campaign');
    const workflow = {
      ...config('workflow-tool-report'), suite: 'workflow' as const, repetitions: 2,
      workflowTurns: [
        { user: 'Inspect storage.', expectedTools: ['run_storage'], criteria: [] },
        { user: 'Explain the prior result without another call.', expectedTools: [], criteria: [] },
      ],
    };
    const manifest = prepareCampaign(workflow, campaign);
    let actorCalls = 0;
    await runCampaign(campaign, { async execute() { throw new Error('Workflow actor must use the conversation adapter.'); }, async executeWorkflow() {
      actorCalls += 1;
      const storageCall = `${JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'sheg', tool: 'run_storage' } })}\n`;
      const workflowTurnEvents = actorCalls === 1 ? [storageCall, storageCall] : [storageCall, ''];
      return { status: 'completed', exitCode: 0, rawEvents: workflowTurnEvents.join(''), rawFinalMessage: 'Done.', rawStderr: '', sessionId: `actor-${actorCalls}`, observedSettings: {}, workflowTurnEvents };
    } });
    await gradeCampaign(campaign, { async execute() {
      const judged = { scenarioId: manifest.scenarioId, criterionResults: manifest.evaluationBasis.criteria.map(({ id }) => ({ criterionId: id, result: 'pass', evidence: 'The actor output and captured workflow evidence satisfy this criterion.' })), notes: '' };
      return { status: 'completed', exitCode: 0, rawEvents: '', rawFinalMessage: JSON.stringify(judged), rawStderr: '', sessionId: 'judge', observedSettings: {} };
    } });
    const report = collectCampaignReport(campaign);
    assert.equal(report.summary.deterministicFailures, 1);
    assert.equal(report.summary.completeTrialPasses, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('blind comparison uses stable anonymous labels, reverses display order, and retains judge disagreement', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sheg-blind-compare-'));
  try {
    const baseline = path.join(root, 'baseline');
    const candidate = path.join(root, 'candidate');
    const manifest = prepareCampaign({ ...config('baseline'), repetitions: 1 }, baseline);
    prepareCampaign({ ...config('candidate'), repetitions: 1 }, candidate);
    const makeActor = (response: string): CampaignAdapter => ({ async execute() { return { status: 'completed', exitCode: 0, rawEvents: '', rawFinalMessage: actor(response), rawStderr: '', sessionId: null, observedSettings: {} }; } });
    await runCampaign(baseline, makeActor('Baseline answer.'));
    await runCampaign(candidate, makeActor('Candidate answer.'));
    const prompts: string[] = [];
    let judgeIndex = 0;
    const arms = { baselineArmId: 'candidate', candidateArmId: 'candidate' };
    const judgments = await gradeBlindComparisons(baseline, candidate, arms, { async execute(input) {
      prompts.push(input.prompt);
      judgeIndex += 1;
      const preference = judgeIndex === 1 ? 'A' : 'B';
      const output = { criterionResults: manifest.evaluationBasis.criteria.map(({ id }) => ({ criterionId: id, preferred: preference, evidence: 'The corresponding response states this.' })), notes: '' };
      return { status: 'completed', exitCode: 0, rawEvents: '', rawFinalMessage: JSON.stringify(output), rawStderr: '', sessionId: `judge-${judgeIndex}`, observedSettings: { model: 'judge-model' } };
    } });
    assert.equal(prompts.length, 2);
    assert.ok(prompts[0]!.indexOf('## Output A') < prompts[0]!.indexOf('## Output B'));
    assert.ok(prompts[1]!.indexOf('## Output B') < prompts[1]!.indexOf('## Output A'));
    assert.doesNotMatch(prompts[0]!, /baseline label|candidate label|Arm: candidate/);
    const comparison = judgments[0] as { disagreements: string[]; humanAdjudication: unknown };
    assert.equal(comparison.disagreements.length, manifest.evaluationBasis.criteria.length);
    assert.equal(comparison.humanAdjudication, null);
    const report = collectCampaignReport(candidate);
    assert.equal(report.summary.comparisonDisputedPairs, 1);
    assert.equal(report.summary.humanAdjudicationPending, 1);
    assert.match(renderCampaignReport(report).markdown, /Blind comparisons/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('comparison requires explicit arms and excludes attribution-control results from criterion deltas', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sheg-multiarms-compare-'));
  try {
    const arms = [
      { id: 'old', guidanceRoot: path.resolve('skills/stimulus-response-polling'), referencePaths: ['references/run-and-recovery.md'] },
      { id: 'candidate', guidanceRoot: path.resolve('skills/stimulus-response-polling'), referencePaths: ['references/run-and-recovery.md'] },
      { id: 'no-guidance', referencePaths: [] },
    ];
    const baseline = path.join(root, 'baseline');
    const candidate = path.join(root, 'candidate');
    const baselineManifest = prepareCampaign({ ...config('baseline-multi'), repetitions: 1, arms }, baseline);
    const candidateManifest = prepareCampaign({ ...config('candidate-multi'), repetitions: 1, arms }, candidate);
    let baselineCall = 0;
    let candidateCall = 0;
    const makeActor = (which: 'baseline' | 'candidate'): CampaignAdapter => ({ async execute() {
      const index = which === 'baseline' ? ++baselineCall : ++candidateCall;
      const armId = arms[index - 1]!.id;
      return { status: 'completed', exitCode: 0, rawEvents: '', rawFinalMessage: actor(`${which}-${armId}`), rawStderr: '', sessionId: null, observedSettings: {} };
    } });
    await runCampaign(baseline, makeActor('baseline'));
    await runCampaign(candidate, makeActor('candidate'));
    const gradeByArm = (manifest: typeof baselineManifest): CampaignAdapter => ({ async execute(input) {
      const old = input.prompt.includes('finalResponse') && input.prompt.includes('old');
      const result = old ? 'fail' : 'pass';
      const judged = { scenarioId: manifest.scenarioId, criterionResults: manifest.evaluationBasis.criteria.map(({ id }) => ({ criterionId: id, result, evidence: `${result} evidence for selected arm.` })), notes: '' };
      return { status: 'completed', exitCode: 0, rawEvents: '', rawFinalMessage: JSON.stringify(judged), rawStderr: '', sessionId: null, observedSettings: {} };
    } });
    await gradeCampaign(baseline, gradeByArm(baselineManifest));
    await gradeCampaign(candidate, gradeByArm(candidateManifest));
    const comparison = compareCampaigns(baseline, candidate, { baselineArmId: 'old', candidateArmId: 'candidate' });
    assert.equal(comparison.criterionChanges[0]!.baseline.fail, 1);
    assert.equal(comparison.criterionChanges[0]!.baseline.pass, 0);
    assert.equal(comparison.criterionChanges[0]!.candidate.pass, 1);
    assert.equal(comparison.criterionChanges[0]!.candidate.fail, 0);
    const blindPrompts: string[] = [];
    const judgments = await gradeBlindComparisons(baseline, candidate, { baselineArmId: 'old', candidateArmId: 'candidate' }, { async execute(input) {
      blindPrompts.push(input.prompt);
      const judged = { criterionResults: baselineManifest.evaluationBasis.criteria.map(({ id }) => ({ criterionId: id, preferred: 'tie', evidence: 'Both selected outputs were inspected.' })), notes: '' };
      return { status: 'completed', exitCode: 0, rawEvents: '', rawFinalMessage: JSON.stringify(judged), rawStderr: '', sessionId: null, observedSettings: {} };
    } });
    assert.equal(judgments.length, 1);
    assert.ok(blindPrompts[0]!.includes('baseline-old'));
    assert.ok(blindPrompts[0]!.includes('candidate-candidate'));
    assert.ok(!blindPrompts[0]!.includes('baseline-no-guidance'));
    assert.throws(() => compareCampaigns(baseline, candidate, { baselineArmId: 'absent', candidateArmId: 'candidate' }), /no comparison arm/i);
    assert.throws(() => compareCampaigns(baseline, candidate, { baselineArmId: 'no-guidance', candidateArmId: 'candidate' }), /guided/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
