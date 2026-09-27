import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

  assert.deepEqual((await readdir(outputDirectory)).sort(), ['cli.js', 'data', 'mcp.js', 'worker.js']);
  const dataDirectory = path.join(outputDirectory, 'data/respondent-archetypes');
  assert.deepEqual(await readdir(dataDirectory), respondentArchetypeGroups.map((group) => group.filename).sort());
  for (const group of respondentArchetypeGroups) {
    assert.deepEqual(JSON.parse(await readFile(path.join(dataDirectory, group.filename), 'utf8')), JSON.parse(await readFile(new URL(`../src/domain/respondents/archetype-groups/${group.filename}`, import.meta.url), 'utf8')));
  }
});
