import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { respondentArchetypeGroups } from '../src/domain/respondents/archetype-catalogue.js';
import { buildPlugin } from '../scripts/build.js';

test('build replaces the distribution with only current runtime outputs', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'polling-build-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const outputDirectory = path.join(temporaryDirectory, 'dist');
  await mkdir(path.join(outputDirectory, 'skills/stimulus-response-polling/assets'), { recursive: true });
  await mkdir(path.join(outputDirectory, 'data/respondent-archetypes'), { recursive: true });
  await writeFile(path.join(outputDirectory, 'stale.js'), 'stale');
  await writeFile(path.join(outputDirectory, 'data/respondent-archetypes/stale.json'), 'stale');

  await buildPlugin(outputDirectory);

  assert.deepEqual((await readdir(outputDirectory)).sort(), ['cli.js', 'credentials', 'data', 'mcp.js', 'worker.js']);
  assert.equal(await readFile(path.join(outputDirectory, 'credentials/windows-credential.ps1'), 'utf8'), await readFile(new URL('../src/infrastructure/credentials/windows-credential.ps1', import.meta.url), 'utf8'));
  if (process.platform === 'win32') {
    const status = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(outputDirectory, 'credentials/windows-credential.ps1'),
      '-Operation', 'Status', '-TargetName', 'Sheg/Jev/TypeSafe',
    ], { encoding: 'utf8', windowsHide: true, shell: false });
    assert.equal(status.error, undefined);
    assert.ok(status.status === 0 || status.status === 3);
    assert.ok(status.stdout.trim() === 'AVAILABLE' || status.stdout.trim() === 'MISSING');
    assert.equal(status.stdout.includes('\n'), true);
    assert.equal(status.stderr, '');
  }
  const dataDirectory = path.join(outputDirectory, 'data/respondent-archetypes');
  assert.deepEqual(await readdir(dataDirectory), respondentArchetypeGroups.map((group) => group.filename).sort());
  for (const group of respondentArchetypeGroups) {
    assert.deepEqual(JSON.parse(await readFile(path.join(dataDirectory, group.filename), 'utf8')), JSON.parse(await readFile(new URL(`../src/domain/respondents/archetype-groups/${group.filename}`, import.meta.url), 'utf8')));
  }
});
