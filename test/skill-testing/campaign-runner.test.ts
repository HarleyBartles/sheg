import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareCampaign, type CampaignConfig } from '../../scripts/skill-testing/contracts.js';
import { addTrial, runCampaign, type CampaignAdapter, type ExecutionResult } from '../../scripts/skill-testing/runner.js';

function setup(): { root: string; campaign: string; config: CampaignConfig; cleanup: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sheg-campaign-runner-'));
  const config: CampaignConfig = {
    id: 'runner-test', scenarioId: 'selected-material-isolation-no-fit', suite: 'focused',
    classification: 'regression', repetitions: 2, concurrency: 1, timeoutMs: 60000,
    execution: { adapter: 'fake', model: 'test-model' },
    arms: [{ id: 'candidate', guidanceRoot: path.resolve('skills/stimulus-response-polling'), referencePaths: ['references/run-and-recovery.md'] }],
  };
  const campaign = path.join(root, 'campaign');
  prepareCampaign(config, campaign);
  return { root, campaign, config, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function result(finalMessage: string): ExecutionResult {
  return { status: 'completed', exitCode: 0, rawEvents: '{"type":"turn.completed"}\n', rawFinalMessage: finalMessage, rawStderr: '', sessionId: 'session-test', observedSettings: { model: 'test-model' } };
}

function adapter(execute: CampaignAdapter['execute']): CampaignAdapter { return { execute }; }

test('runner retains outputs and resume never dispatches an already captured trial', async () => {
  const input = setup();
  let calls = 0;
  try {
    const backend = adapter(async () => { calls += 1; return result(`trial ${calls}`); });
    await assert.rejects(runCampaign(input.campaign, backend, { afterCapture: () => { throw new Error('simulated runner interruption'); } }), /simulated runner interruption/);
    const second = await runCampaign(input.campaign, backend);
    assert.equal(second.captured, 2);
    assert.equal(calls, 2);
    const events = readFileSync(path.join(input.campaign, 'attempts.jsonl'), 'utf8');
    assert.match(events, /output-captured/);
    assert.equal(events.match(/output-captured/g)?.length, 2);
  } finally { input.cleanup(); }
});

test('resume retries runtime failures under a new attempt ID and preserves the failed attempt', async () => {
  const input = setup();
  let calls = 0;
  try {
    const backend = adapter(async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary adapter failure');
      return result('completed after retry');
    });
    const first = await runCampaign(input.campaign, backend);
    assert.equal(first.runtimeErrors, 1);
    const second = await runCampaign(input.campaign, backend);
    assert.equal(second.captured, 2);
    assert.equal(calls, 3);
    const events = readFileSync(path.join(input.campaign, 'attempts.jsonl'), 'utf8');
    assert.match(events, /runtime-error/);
    assert.match(events, /attempt-002/);
  } finally { input.cleanup(); }
});

test('behavioral reruns append a stable new trial instead of replacing a failed result', () => {
  const input = setup();
  try {
    const added = addTrial(input.campaign, 'candidate');
    const again = addTrial(input.campaign, 'candidate');
    assert.equal(added.trialId, 'selected-material-isolation-no-fit@v5:candidate:003');
    assert.equal(again.trialId, 'selected-material-isolation-no-fit@v5:candidate:004');
    assert.notEqual(added.trialId, again.trialId);
    const events = readFileSync(path.join(input.campaign, 'attempts.jsonl'), 'utf8');
    assert.match(events, /trial-added/);
  } finally { input.cleanup(); }
});

test('malformed final text is preserved byte for byte for a later grader', async () => {
  const input = setup();
  try {
    await runCampaign(input.campaign, adapter(async () => result('not-json and left unchanged')));
    const manifest = JSON.parse(readFileSync(path.join(input.campaign, 'campaign.json'), 'utf8')) as { trials: Array<{ trialId: string }> };
    const first = manifest.trials[0]!;
    const firstSegment = first.trialId.replace(/[^a-zA-Z0-9._-]/g, '-');
    const attemptSegment = `${first.trialId}:attempt-001`.replace(/[^a-zA-Z0-9._-]/g, '-');
    const finalPath = path.join(input.campaign, 'attempts', firstSegment, attemptSegment, 'raw-final-message.txt');
    assert.equal(readFileSync(finalPath, 'utf8'), 'not-json and left unchanged');
  } finally { input.cleanup(); }
});

test('resume records an interrupted attempt and continues with a new attempt ID', async () => {
  const input = setup();
  try {
    const manifest = JSON.parse(readFileSync(path.join(input.campaign, 'campaign.json'), 'utf8')) as { trials: Array<{ trialId: string }> };
    appendFileSync(path.join(input.campaign, 'attempts.jsonl'), `${JSON.stringify({ type: 'attempt-started', trialId: manifest.trials[0]!.trialId, attemptId: `${manifest.trials[0]!.trialId}:attempt-001` })}\n`);
    await runCampaign(input.campaign, adapter(async () => result('recovered')));
    const journal = readFileSync(path.join(input.campaign, 'attempts.jsonl'), 'utf8');
    assert.match(journal, /attempt-interrupted/);
    assert.match(journal, /attempt-002/);
  } finally { input.cleanup(); }
});

test('timed out provider execution is retained as a runtime error rather than a behavior result', async () => {
  const input = setup();
  try {
    const timedOut: ExecutionResult = { ...result('partial'), status: 'timed-out', exitCode: null };
    const summary = await runCampaign(input.campaign, adapter(async () => timedOut));
    assert.equal(summary.captured, 0);
    assert.equal(summary.runtimeErrors, 2);
    const journal = readFileSync(path.join(input.campaign, 'attempts.jsonl'), 'utf8');
    assert.match(journal, /timed-out/);
  } finally { input.cleanup(); }
});

test('runner snapshots per-attempt Sheg MCP data for tool evidence inspection', async () => {
  const input = setup();
  try {
    const backend = adapter(async (call) => {
      const data = path.join(call.cwd, 'sheg-data');
      mkdirSync(data, { recursive: true });
      writeFileSync(path.join(data, 'run-evidence.json'), '{"tool":"run_inspect"}');
      return result('captured');
    });
    await runCampaign(input.campaign, backend);
    const manifest = JSON.parse(readFileSync(path.join(input.campaign, 'campaign.json'), 'utf8')) as { trials: Array<{ trialId: string }> };
    const trial = manifest.trials[0]!;
    const trialPart = trial.trialId.replace(/[^a-zA-Z0-9._-]/g, '-');
    const copiedEvidence = path.join(input.campaign, 'attempts', trialPart, `${trial.trialId}:attempt-001`.replace(/[^a-zA-Z0-9._-]/g, '-'), 'sheg-data', 'run-evidence.json');
    assert.equal(readFileSync(copiedEvidence, 'utf8'), '{"tool":"run_inspect"}');
  } finally { input.cleanup(); }
});
