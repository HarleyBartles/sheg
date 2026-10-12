import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { respondentArchetypeGroups } from '../src/domain/respondents/archetype-catalogue.js';
import { codecAssetNames } from '../src/infrastructure/images/codec-assets.js';
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

  assert.deepEqual((await readdir(outputDirectory)).sort(), ['cli.js', 'codec-assets', 'credentials', 'data', 'licenses', 'mcp.js', 'migrations', 'queries', 'worker.js']);
  assert.equal(await readFile(path.join(outputDirectory, 'queries/load-journey-worker-turn.sql'), 'utf8'), await readFile(new URL('../src/infrastructure/sqlite/queries/load-journey-worker-turn.sql', import.meta.url), 'utf8'));
  assert.equal(await readFile(path.join(outputDirectory, 'credentials/windows-credential.ps1'), 'utf8'), await readFile(new URL('../src/infrastructure/credentials/windows-credential.ps1', import.meta.url), 'utf8'));
  assert.equal(await readFile(path.join(outputDirectory, 'migrations/0000_baseline_v9/migration.sql'), 'utf8'), await readFile(new URL('../migrations/0000_baseline_v9/migration.sql', import.meta.url), 'utf8'));
  assert.equal(await readFile(path.join(outputDirectory, 'migrations/0001_image_assets/migration.sql'), 'utf8'), await readFile(new URL('../migrations/0001_image_assets/migration.sql', import.meta.url), 'utf8'));
  assert.equal(await readFile(path.join(outputDirectory, 'licenses/drizzle-orm-Apache-2.0.txt'), 'utf8'), await readFile(new URL('../licenses/drizzle-orm-Apache-2.0.txt', import.meta.url), 'utf8'));
  assert.deepEqual((await readdir(path.join(outputDirectory, 'codec-assets'))).sort(), [...codecAssetNames].sort());
  for (const name of codecAssetNames) assert.deepEqual(await readFile(path.join(outputDirectory, 'codec-assets', name)), await readFile(new URL(`../node_modules/@jsquash/${codecSourceFor(name)}`, import.meta.url)));
  assert.equal((await readFile(path.join(outputDirectory, 'licenses/jsquash/jpeg/LICENSE.codec.md'), 'utf8')).includes('libjpeg-turbo'), true);
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

function codecSourceFor(name: string): string {
  return ({
    'squoosh_png_bg.wasm': 'png/codec/pkg/squoosh_png_bg.wasm',
    'mozjpeg_dec.wasm': 'jpeg/codec/dec/mozjpeg_dec.wasm',
    'mozjpeg_enc.wasm': 'jpeg/codec/enc/mozjpeg_enc.wasm',
    'webp_dec.wasm': 'webp/codec/dec/webp_dec.wasm',
    'webp_enc_simd.wasm': 'webp/codec/enc/webp_enc_simd.wasm',
    'squoosh_resize_bg.wasm': 'resize/lib/resize/pkg/squoosh_resize_bg.wasm',
  } as Record<string, string>)[name]!;
}
