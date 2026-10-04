import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { campaignScratchRoot } from '../../scripts/skill-testing/runner.js';

test('campaign CLI prepares and inspects off-repository campaign data without dispatching', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sheg-campaign-cli-'));
  try {
    const configPath = path.join(root, 'config.json');
    const outputPath = path.join(root, 'campaign');
    writeFileSync(configPath, JSON.stringify({
      id: 'cli-smoke', scenarioId: 'selected-material-isolation-no-fit', suite: 'focused',
      classification: 'regression', repetitions: 1, concurrency: 1, timeoutMs: 60000,
      execution: { adapter: 'codex', model: 'configured-model' },
      arms: [{ id: 'candidate', guidanceRoot: path.resolve('skills/stimulus-response-polling'), referencePaths: ['references/run-and-recovery.md'] }],
    }));
    const cli = path.resolve('scripts/skill-testing/cli.ts');
    const prepare = execFileSync(process.execPath, ['--import', 'tsx', cli, 'prepare', '--config', configPath, '--output', outputPath], { encoding: 'utf8' });
    assert.match(prepare, /"prepared": true/);
    const status = execFileSync(process.execPath, ['--import', 'tsx', cli, 'status', '--campaign', outputPath], { encoding: 'utf8' });
    assert.match(status, /"trialCount": 1/);
    assert.throws(() => execFileSync(process.execPath, ['--import', 'tsx', cli, 'run', '--campaign', outputPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), /explicit --backend codex/);
    const scratch = campaignScratchRoot(outputPath, 'cli-smoke-trial', 'cli-smoke-attempt');
    mkdirSync(scratch, { recursive: true });
    writeFileSync(path.join(scratch, 'retained.json'), '{}');
    const discarded = execFileSync(process.execPath, ['--import', 'tsx', cli, 'discard', '--campaign', outputPath], { encoding: 'utf8' });
    assert.match(discarded, /"discarded": true/);
    assert.equal(existsSync(outputPath), false);
    assert.equal(existsSync(scratch), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('comparison CLI requires explicit baseline and candidate arms', () => {
  const cli = path.resolve('scripts/skill-testing/cli.ts');
  assert.throws(() => execFileSync(process.execPath, ['--import', 'tsx', cli, 'compare', '--backend', 'codex', '--baseline', 'baseline', '--candidate', 'candidate'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), /--baseline-arm/);
});

test('campaign CLI selects affected scenarios by owner and guidance with shared safeguards', () => {
  const cli = path.resolve('scripts/skill-testing/cli.ts');
  const output = execFileSync(process.execPath, [
    '--import', 'tsx', cli, 'select', '--owner', 'stimulus-response-polling', '--guidance-path', 'references/run-and-recovery.md', '--include-shared',
  ], { encoding: 'utf8' });
  const selected = JSON.parse(output) as Array<{ id: string; tags: string[] }>;
  assert.deepEqual(selected.map(({ id }) => id), [
    'selected-material-isolation-no-fit', 'selected-material-follow-on', 'partial-run-selected-question', 'typed-answer-failure',
    'isolated-storage-inspection', 'live-storage-inspection-heldout', 'live-storage-inspection',
    'selected-material-isolation-heldout', 'partial-journey-recovery', 'purposeful-input-variation',
    'cumulative-journey-material', 'cumulative-journey-material-heldout',
  ]);
  assert.deepEqual(selected.filter(({ tags }) => tags.includes('shared-safeguard')).map(({ id }) => id), [
    'selected-material-isolation-no-fit', 'selected-material-follow-on', 'partial-run-selected-question', 'typed-answer-failure',
    'live-storage-inspection-heldout', 'live-storage-inspection',
    'purposeful-input-variation', 'cumulative-journey-material', 'cumulative-journey-material-heldout',
  ]);
});
