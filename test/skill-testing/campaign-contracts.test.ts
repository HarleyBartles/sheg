import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertComparableManifests, prepareCampaign, readFrozenCampaign, type CampaignConfig } from '../../scripts/skill-testing/contracts.js';
import { runCampaign } from '../../scripts/skill-testing/runner.js';
import { openRunStore } from '../../src/infrastructure/run-store.js';
import { createControlledRecoveryProvider } from '../../scripts/skill-testing/controlled-recovery.js';
import { JevProvider } from '../../src/providers/jev.js';
import { createProvider } from '../../src/providers/factory.js';

function fixture(): { root: string; config: CampaignConfig; cleanup: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sheg-skill-campaign-contracts-'));
  const old = path.join(root, 'old');
  const candidate = path.join(root, 'candidate');
  const setupArm = (directory: string, label: string) => {
    mkdirSync(path.join(directory, 'references'), { recursive: true });
    writeFileSync(path.join(directory, 'SKILL.md'), `---\ndescription: ${label} guidance\n---\n${label} skill body`);
    writeFileSync(path.join(directory, 'references', 'policy.md'), `${label} reference`);
  };
  setupArm(old, 'old');
  setupArm(candidate, 'candidate');
  const config: CampaignConfig = {
    id: 'frozen-skill-check',
    scenarioId: 'selected-material-isolation-no-fit',
    suite: 'focused',
    classification: 'capability',
    repetitions: 2,
    concurrency: 1,
    timeoutMs: 60000,
    execution: { adapter: 'codex', model: 'test-model', reasoning: 'medium' },
    arms: [
      { id: 'old', guidanceRoot: old, referencePaths: ['references/policy.md'] },
      { id: 'candidate', guidanceRoot: candidate, referencePaths: ['references/policy.md'] },
    ],
  };
  return { root, config, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('preparation freezes each guidance arm and renders prompts from the frozen copy', () => {
  const input = fixture();
  try {
    const output = path.join(input.root, 'campaign');
    const manifest = prepareCampaign(input.config, output);
    writeFileSync(path.join(input.root, 'old', 'references', 'policy.md'), 'mutated after preparation');
    const oldArm = manifest.arms.find((arm) => arm.id === 'old');
    assert.ok(oldArm);
    assert.match(oldArm.actorPrompt, /old reference/);
    assert.doesNotMatch(oldArm.actorPrompt, /mutated after preparation/);
    assert.equal(readFileSync(path.join(output, 'snapshots', 'old', 'references', 'policy.md'), 'utf8'), 'old reference');
  } finally { input.cleanup(); }
});

test('frozen campaign loading rejects changed prompt, criteria, execution, and snapshot content', () => {
  const input = fixture();
  try {
    const changedPrompt = path.join(input.root, 'changed-prompt');
    prepareCampaign(input.config, changedPrompt);
    const promptJson = JSON.parse(readFileSync(path.join(changedPrompt, 'campaign.json'), 'utf8')) as { arms: Array<{ actorPrompt: string }> };
    promptJson.arms[0]!.actorPrompt += '\nMutation';
    writeFileSync(path.join(changedPrompt, 'campaign.json'), `${JSON.stringify(promptJson, null, 2)}\n`);
    assert.throws(() => readFrozenCampaign(changedPrompt), /frozen campaign manifest/i);

    const changedSnapshot = path.join(input.root, 'changed-snapshot');
    prepareCampaign(input.config, changedSnapshot);
    writeFileSync(path.join(changedSnapshot, 'snapshots', 'old', 'references', 'policy.md'), 'Mutation');
    assert.throws(() => readFrozenCampaign(changedSnapshot), /snapshot.*hash/i);
  } finally { input.cleanup(); }
});

test('comparison rejects changes to scenario evidence, criteria, or execution settings', () => {
  const input = fixture();
  try {
    const first = prepareCampaign(input.config, path.join(input.root, 'first'));
    const changed = prepareCampaign({
      ...input.config,
      execution: { ...input.config.execution, model: 'different-model' },
    }, path.join(input.root, 'second'));
    assert.throws(() => assertComparableManifests(first, changed), /execution/i);
  } finally { input.cleanup(); }
});

test('comparison rejects changed timeout and concurrency settings', () => {
  const input = fixture();
  try {
    const first = prepareCampaign(input.config, path.join(input.root, 'first-limits'));
    const longer = prepareCampaign({ ...input.config, timeoutMs: 3600000 }, path.join(input.root, 'longer'));
    const wider = prepareCampaign({ ...input.config, concurrency: 2 }, path.join(input.root, 'wider'));
    assert.throws(() => assertComparableManifests(first, longer), /timeoutMs/i);
    assert.throws(() => assertComparableManifests(first, wider), /concurrency/i);
  } finally { input.cleanup(); }
});

test('partial-journey workflow fixture seeds the real isolated Sheg store for each trial', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sheg-partial-workflow-seed-'));
  try {
    const skill = path.resolve('skills/stimulus-response-polling');
    const config: CampaignConfig = {
      id: 'partial-journey-workflow', scenarioId: 'partial-journey-recovery', suite: 'workflow',
      classification: 'regression', repetitions: 2, concurrency: 1, timeoutMs: 60_000,
      execution: { adapter: 'codex', model: 'test-model' },
      arms: [{ id: 'candidate', guidanceRoot: skill, referencePaths: ['references/run-and-recovery.md', 'references/interpret-results.md'] }],
    };
    const campaign = path.join(root, 'campaign');
    const manifest = prepareCampaign(config, campaign);
    assert.deepEqual(manifest.workflowSetup, { kind: 'partial-journey-recovery', version: 1 });
    assert.ok(manifest.workflowTurns?.length === 3);

    const observedRunIds: string[] = [];
    const result = await runCampaign(campaign, {
      async preflight(workflowSetup) { assert.deepEqual(workflowSetup, { kind: 'partial-journey-recovery', version: 1 }); return { adapter: 'controlled-test' }; },
      async execute() { throw new Error('Workflow fixture must use persistent execution.'); },
      async executeWorkflow(input) {
        assert.deepEqual(input.workflowSetup, { kind: 'partial-journey-recovery', version: 1 });
        const prompts = [input.initialPrompt, ...input.turns];
        const turnPrompts = prompts.map((prompt, index) => index === 0 ? prompt.split('## Workflow turn 1\n').at(-1)! : prompt);
        const runIds = turnPrompts.map((prompt) => /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i.exec(prompt)?.[0]);
        assert.ok(runIds.every((runId) => runId && runId !== '{{runId}}'), `Expected a generated run ID in every turn: ${JSON.stringify(runIds)}`);
        assert.equal(new Set(runIds).size, 1, `Expected one run ID across all turns: ${JSON.stringify(runIds)}`);
        const runId = runIds[0]!;
        observedRunIds.push(runId);
        const store = openRunStore(path.join(input.cwd, 'sheg-data'));
        try {
          const status = store.getStatus(runId);
          const journey = store.getJourneyRun(runId);
          const attempts = store.attempts(runId).items;
          assert.equal(status.status, 'partial');
          assert.deepEqual(status.lifecycle.resume, { eligible: true });
          assert.equal(status.usedCalls, 3, JSON.stringify(status));
          assert.equal(status.maxCalls, 8);
          assert.deepEqual(journey.respondents.map(({ respondentId, status }) => [respondentId, status]), [['reader-a', 'completed'], ['reader-b', 'failed']]);
          assert.equal(journey.respondents.find(({ respondentId }) => respondentId === 'reader-b')?.events.filter(({ type }) => type === 'response').length, 1, JSON.stringify(journey.respondents));
          const readerB = journey.respondents.find(({ respondentId }) => respondentId === 'reader-b')!;
          assert.equal(readerB.route.length, 1, JSON.stringify(journey.respondents));
          const failedTurn = journey.evaluations.find(({ respondentId, questionId, status }) => respondentId === 'reader-b' && questionId === 'clarity' && status === 'failed')!;
          const scenario = JSON.parse(readFileSync('skills/stimulus-response-polling/tests/behavior/scenarios.json', 'utf8')) as { id: string; controlledEvidence: unknown }[];
          const controlled = scenario.find(({ id }) => id === 'partial-journey-recovery')!.controlledEvidence as { status: string; usedCalls: number; maxCalls: number; respondents: { respondentId: string; route?: { toNodeId: string }[]; failedTurn?: { nodeId: string; questionId: string; status: string; failure: { code: string } } }[] };
          const controlledReaderB = controlled.respondents.find(({ respondentId }) => respondentId === 'reader-b')!;
          assert.equal(controlled.status, status.status);
          assert.equal(controlled.usedCalls, status.usedCalls);
          assert.equal(controlled.maxCalls, status.maxCalls);
          assert.equal(controlledReaderB.route?.[0]?.toNodeId, readerB.route[0]?.toNodeId);
          assert.equal(controlledReaderB.failedTurn?.nodeId, failedTurn.nodeId);
          assert.equal(controlledReaderB.failedTurn?.questionId, failedTurn.questionId);
          assert.equal(controlledReaderB.failedTurn?.status, failedTurn.status);
          assert.equal(controlledReaderB.failedTurn?.failure.code, failedTurn.failure?.code);
          assert.equal(attempts.length, 3, JSON.stringify(attempts));
          assert.deepEqual(attempts.map(({ status }) => status), ['answered', 'answered', 'failed']);
          assert.ok(attempts.every(({ status }) => status !== 'reserved' && status !== 'uncertain'));
        } finally { store.close(); }
        return { status: 'completed', exitCode: 0, rawEvents: '', rawFinalMessage: 'inspected', rawStderr: '', sessionId: 'workflow-test', observedSettings: {}, workflowTurnEvents: [] };
      },
    });
    assert.equal(result.runtimeErrors, 0, readFileSync(path.join(campaign, 'attempts.jsonl'), 'utf8'));
    assert.equal(result.captured, 2);
    assert.equal(new Set(observedRunIds).size, 2);
    assert.ok(observedRunIds.every((runId) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(runId)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('controlled recovery provider exists only in its harness and accepts its frozen route', async () => {
  const provider = createControlledRecoveryProvider({ kind: 'jev', route: 'typesafe', model: 'jev-latest' });
  const result = await provider.decide({ state: {}, question: { type: 'score', id: 'clarity', instructions: 'How clear?', rubric: ['Unclear', 'Mixed', 'Clear'] } }, 1);
  assert.deepEqual({ type: result.type, score: result.type === 'score' ? result.score : undefined, model: result.model }, { type: 'score', score: 2, model: 'controlled/partial-journey-recovery' });
  await assert.rejects(() => provider.decide({ state: {}, question: { type: 'choice', id: 'interest', instructions: 'Continue?', options: { yes: 'Yes', no: 'No' } }, optionIds: ['yes', 'no'] }, 1), /unexpected turn/i);
  assert.throws(() => createControlledRecoveryProvider({ kind: 'jev', route: 'typesafe', model: 'other' }), /frozen TypeSafe fixture/i);
  assert.throws(() => createControlledRecoveryProvider({ kind: 'laya', baseUrl: 'https://example.invalid', checkpoint: 'fixture', contextLimit: 32000, headLimit: 4000, tokenizerJsonPath: 'tokenizer.json', tokenizerSha256: 'a'.repeat(64), timeoutMs: 1000 }), /frozen TypeSafe fixture/i);
});

test('ordinary provider construction cannot be switched to a fixture by ambient test environment', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousProvider = process.env.SHEG_TEST_PROVIDER;
  try {
    process.env.NODE_ENV = 'test';
    process.env.SHEG_TEST_PROVIDER = 'partial-journey-recovery';
    assert.ok(createProvider({ kind: 'jev', route: 'typesafe', model: 'jev-latest' }) instanceof JevProvider);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousProvider === undefined) delete process.env.SHEG_TEST_PROVIDER; else process.env.SHEG_TEST_PROVIDER = previousProvider;
  }
});

test('preparation rejects missing guidance references and output collisions', () => {
  const input = fixture();
  try {
    const missingReference: CampaignConfig = {
      ...input.config,
      arms: input.config.arms.map((arm) => ({ ...arm, referencePaths: ['references/missing.md'] })),
    };
    assert.throws(() => prepareCampaign(missingReference, path.join(input.root, 'missing')), /reference/i);
    const output = path.join(input.root, 'collision');
    prepareCampaign(input.config, output);
    assert.throws(() => prepareCampaign(input.config, output), /exist|collision|overwrite/i);
  } finally { input.cleanup(); }
});

test('trial identities are unique and discovery snapshots descriptions without skill bodies', () => {
  const input = fixture();
  try {
    const config: CampaignConfig = {
      ...input.config,
      suite: 'discovery',
      arms: [{ id: 'candidate', guidanceRoot: path.join(input.root, 'candidate'), referencePaths: [] }],
    };
    const manifest = prepareCampaign(config, path.join(input.root, 'discovery'));
    assert.equal(new Set(manifest.trials.map((trial) => trial.trialId)).size, 2);
    assert.ok(manifest.arms[0]?.discoveryPrompt.includes('candidate guidance'));
    assert.ok(!manifest.arms[0]?.discoveryPrompt.includes('candidate skill body'));
    const noGuidance = prepareCampaign({
      ...input.config,
      arms: [{ id: 'no-guidance', referencePaths: [] }],
    }, path.join(input.root, 'no-guidance'));
    assert.doesNotMatch(noGuidance.arms[0]!.actorPrompt, /candidate skill body|candidate reference/);
    assert.deepEqual(noGuidance.arms[0]!.skillReferenceHashes, {});
  } finally { input.cleanup(); }
});

test('discovery prompt has a distinct skill-selection result contract and no skill-body injection', () => {
  const input = fixture();
  try {
    const config: CampaignConfig = {
      ...input.config, id: 'discovery-contract', scenarioId: 'discover-polling-vocabulary-near-miss', suite: 'discovery',
      arms: [{ id: 'candidate', guidanceRoot: path.join(input.root, 'candidate'), referencePaths: [] }],
    };
    const manifest = prepareCampaign(config, path.join(input.root, 'discovery-contract'));
    const prompt = manifest.arms[0]!.discoveryPrompt;
    assert.match(prompt, /selectedSkill \(study-design, stimulus-response-polling, or null\)/);
    assert.match(prompt, /candidate guidance/);
    assert.match(prompt, /querying recorded evidence/);
    assert.match(prompt, /study-design/);
    assert.doesNotMatch(prompt, /candidate skill body|# Stimulus-response polling|# Study design/);
    assert.match(prompt, /responsive CSS/);
  } finally { input.cleanup(); }
});
