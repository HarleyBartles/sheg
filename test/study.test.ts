import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { StudyInputError } from '../src/errors.js';
import { loadStudy } from '../src/study.js';

const fixtureDirectory = fileURLToPath(new URL('./fixtures/', import.meta.url));

async function copiedStudy(t: TestContext, manifestName = 'article.json') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'polling-study-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(fixtureDirectory, directory, { recursive: true });
  return {
    directory,
    manifestPath: path.join(directory, manifestName),
    cohortPath: path.join(directory, 'cohort.json'),
  };
}

test('loads article and scan manifests with verified source and ordered frozen readers', async (t) => {
  const articleFiles = await copiedStudy(t);
  const scanFiles = await copiedStudy(t, 'scan.json');

  const article = await loadStudy(articleFiles.manifestPath, articleFiles.cohortPath);
  const scan = await loadStudy(scanFiles.manifestPath, scanFiles.cohortPath);

  assert.equal(article.manifest.entry, 'article');
  assert.deepEqual(article.profiles.map((reader) => reader.id), [
    'curious-outside-reader',
    'craft-reader',
  ]);
  assert.equal(article.sources[0]?.path, path.join(articleFiles.directory, 'article-source.md'));
  assert.equal(article.sources[0]?.sha256, 'dc6bb97ebce3cd0c42945143c1eb230a74377111308d8b8563652898d996daf5');
  assert.equal(scan.manifest.entry, 'scan');
  assert.deepEqual(scan.manifest.scanCards.map((card) => card.beatId), ['symptom', 'repair']);
});

test('accepts an explicitly absolute source reference', async (t) => {
  const files = await copiedStudy(t);
  const manifest = JSON.parse(await readFile(files.manifestPath, 'utf8')) as {
    source: { path: string; sha256: string };
  };
  manifest.source.path = path.join(files.directory, 'article-source.md');
  await writeFile(files.manifestPath, JSON.stringify(manifest));

  const study = await loadStudy(files.manifestPath, files.cohortPath);

  assert.equal(study.sources[0]?.path, manifest.source.path);
});

test('rejects source drift before a run can be created', async (t) => {
  const files = await copiedStudy(t);
  const sourcePath = path.join(files.directory, 'article-source.md');
  await writeFile(sourcePath, `${await readFile(sourcePath, 'utf8')}A changed source.\n`);

  await assert.rejects(loadStudy(files.manifestPath, files.cohortPath), /source hash/i);
});

test('rejects unsupported old manifest versions', async (t) => {
  const files = await copiedStudy(t);
  const manifest = JSON.parse(await readFile(files.manifestPath, 'utf8')) as { version: string };
  manifest.version = '0.0.5';
  await writeFile(files.manifestPath, JSON.stringify(manifest));

  await assert.rejects(loadStudy(files.manifestPath, files.cohortPath), /only manifest version 1\.0/i);
});

test('rejects dangling aside references and a decision ceiling too small for the route', async (t) => {
  const files = await copiedStudy(t);
  const manifest = JSON.parse(await readFile(files.manifestPath, 'utf8')) as {
    asides: Array<{ offerAfterBeatId: string }>;
    maxDecisions: number;
  };
  manifest.asides[0]!.offerAfterBeatId = 'missing-beat';
  await writeFile(files.manifestPath, JSON.stringify(manifest));
  await assert.rejects(loadStudy(files.manifestPath, files.cohortPath), /aside.*beat/i);

  manifest.asides[0]!.offerAfterBeatId = 'investigation';
  manifest.maxDecisions = 1;
  await writeFile(files.manifestPath, JSON.stringify(manifest));
  await assert.rejects(loadStudy(files.manifestPath, files.cohortPath), /decision ceiling/i);
});

test('rejects duplicate readers and archetypes absent from the bundled catalogue', async (t) => {
  const files = await copiedStudy(t);
  const cohort = JSON.parse(await readFile(files.cohortPath, 'utf8')) as {
    readers: Array<{ id: string; archetypeId: string }>;
  };
  cohort.readers[1]!.id = cohort.readers[0]!.id;
  await writeFile(files.cohortPath, JSON.stringify(cohort));
  await assert.rejects(loadStudy(files.manifestPath, files.cohortPath), /duplicate reader/i);

  cohort.readers[1]!.id = 'craft-reader';
  cohort.readers[1]!.archetypeId = 'unlisted-archetype';
  await writeFile(files.cohortPath, JSON.stringify(cohort));
  await assert.rejects(loadStudy(files.manifestPath, files.cohortPath), /unknown archetype/i);
});

test('requires an explicit frozen cohort and rejects unknown manifest fields', async (t) => {
  const files = await copiedStudy(t);
  await assert.rejects(loadStudy(files.manifestPath, undefined), StudyInputError);

  const manifest = JSON.parse(await readFile(files.manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.workspaceDiscovery = true;
  await writeFile(files.manifestPath, JSON.stringify(manifest));
  await assert.rejects(loadStudy(files.manifestPath, files.cohortPath), /unknown|unrecognized/i);
});
