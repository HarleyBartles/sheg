import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareCampaign } from '../../scripts/skill-testing/contracts.js';
import { runCampaign, type CampaignAdapter, type ExecutionResult } from '../../scripts/skill-testing/runner.js';

const turns = [
  { user: 'Help design a paragraph-selection study. Ask for missing setup before starting.', evidence: { article: 'Seven paragraphs.' }, expectedTools: [], criteria: ['Ask for the intended reader cohort and confirm the article stimulus before proposing execution.'] },
  { user: 'The cohort is approved. Inspect fit.', evidence: { cohort: ['reader-a', 'reader-b'] }, expectedTools: ['run_inspect'], criteria: ['Inspect the typed request before starting it.'] },
  { user: 'Start the study now.', evidence: { approved: true }, expectedTools: ['run_start'], criteria: ['Start only after explicit approval.'] },
  { user: 'Q2 is answered, Q1 failed. Report partial status.', evidence: { status: 'partial' }, expectedTools: ['run_query'], criteria: ['Preserve the overall partial status and separate failed sibling.'] },
  { user: 'For each paragraph selector, ask about only their selected paragraph.', evidence: { selectedMaterial: ['p2', 'p5'] }, expectedTools: ['run_query'], criteria: ['Check that the current contract supports the requested selection before starting.'] },
];
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sheg-campaign-workflow-'));
  const campaign = path.join(root, 'campaign');
  prepareCampaign({
    id: 'workflow-tools', scenarioId: 'selected-material-isolation-no-fit', suite: 'workflow', classification: 'capability',
    repetitions: 1, concurrency: 1, timeoutMs: 60000, execution: { adapter: 'fake' }, workflowTurns: turns,
    arms: [{ id: 'candidate', guidanceRoot: path.resolve('skills/stimulus-response-polling'), referencePaths: ['references/run-and-recovery.md'] }],
  }, campaign);
  return { root, campaign };
}
const result: ExecutionResult = { status: 'completed', exitCode: 0, rawEvents: '', rawFinalMessage: 'done', rawStderr: '', sessionId: 'persisted-session', observedSettings: {} };

test('workflow actor gets one conversation with Sheg tools and only incrementally supplied turns', async () => {
  const { root, campaign } = setup();
  let input: Parameters<NonNullable<CampaignAdapter['executeWorkflow']>>[0] | undefined;
  try {
    const adapter: CampaignAdapter = {
      async execute() { throw new Error('single-turn execution must not be used for workflows'); },
      async executeWorkflow(value) { input = value; return result; },
    };
    const summary = await runCampaign(campaign, adapter);
    assert.equal(summary.captured, 1);
    assert.ok(input);
    assert.match(input.initialPrompt, /Sheg MCP tools are available/);
    assert.doesNotMatch(input.initialPrompt, /Use available Sheg MCP tools when the user asks/);
    assert.doesNotMatch(input.initialPrompt, /Do not call tools, connectors|Return only JSON|The cohort is approved/);
    assert.doesNotMatch(input.initialPrompt, /intended reader cohort|workflow-tool-checkpoints|expectedTools/);
    assert.match(input.initialPrompt, /Seven paragraphs/);
    assert.deepEqual(input.turns.map((turn) => turn.split('\n')[0]), turns.slice(1).map(({ user }) => user));
    assert.doesNotMatch(input.turns[0]!, /Q2 is answered|selected paragraph/);
    assert.match(input.turns[1]!, /approved/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workflow preflight refuses a single-turn-only backend', async () => {
  const { root, campaign } = setup();
  try {
    await assert.rejects(runCampaign(campaign, { execute: async () => result }), /persistent conversation support/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scripted workflow evidence is frozen into the comparison basis', () => {
  const { root, campaign } = setup();
  try {
    const manifest = JSON.parse(readFileSync(path.join(campaign, 'campaign.json'), 'utf8')) as { basis: { evidenceSha256: string } };
    assert.match(manifest.basis.evidenceSha256, /^[a-f0-9]{64}$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('owning-skill workflow fixture requires real Sheg actions at the relevant checkpoints', () => {
  const fixture = JSON.parse(readFileSync('skills/stimulus-response-polling/tests/behavior/workflows/design-to-partial-results.json', 'utf8')) as { turns: Array<{ user: string; expectedTools: string[] }> };
  assert.deepEqual(fixture.turns.map(({ expectedTools }) => expectedTools), [[], ['run_inspect'], ['run_start'], ['run_query'], ['run_query']]);
  assert.match(fixture.turns[2]!.user, /Start the study/);
  assert.match(fixture.turns[4]!.user, /selected paragraph/);
});

test('live workflow fixture is read-only and changes state by interpreting the captured health response', () => {
  const fixture = JSON.parse(readFileSync('skills/stimulus-response-polling/tests/behavior/workflows/storage-health-follow-up.json', 'utf8')) as { turns: Array<{ user: string; expectedTools: string[] }> };
  assert.deepEqual(fixture.turns.map(({ expectedTools }) => expectedTools), [['run_storage'], []]);
  assert.match(fixture.turns[0]!.user, /without changing/);
  assert.match(fixture.turns[1]!.user, /previous health response/);
  assert.doesNotMatch(fixture.turns.map(({ user }) => user).join(' '), /start the study|run_start/i);
});
