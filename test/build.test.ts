import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildPlugin } from '../scripts/build.js';

test('build replaces the distribution with only current runtime outputs', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'polling-build-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const outputDirectory = path.join(temporaryDirectory, 'dist');
  await mkdir(path.join(outputDirectory, 'skills/stimulus-response-polling/assets'), { recursive: true });
  await writeFile(path.join(outputDirectory, 'stale.js'), 'stale');
  await writeFile(path.join(outputDirectory, 'skills/stimulus-response-polling/assets/reader-archetypes.json'), 'stale');

  await buildPlugin(outputDirectory);

  assert.deepEqual((await readdir(outputDirectory)).sort(), ['cli.js', 'data', 'mcp.js', 'worker.js']);
  assert.deepEqual(await readdir(path.join(outputDirectory, 'data')), ['reader-archetypes.json']);
  assert.deepEqual(JSON.parse(await readFile(path.join(outputDirectory, 'data/reader-archetypes.json'), 'utf8')), JSON.parse(await readFile(new URL('../src/domain/readers/reader-archetypes.json', import.meta.url), 'utf8')));
});
