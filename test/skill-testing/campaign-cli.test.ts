import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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
  } finally { rmSync(root, { recursive: true, force: true }); }
});
