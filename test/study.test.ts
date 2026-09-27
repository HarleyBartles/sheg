import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { StudyInputError } from '../src/domain/errors.js';
import { loadStudy } from '../src/domain/study/load-study.js';

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

test('loads article and chapter studies through the same graph primitives', async (t) => {
  const articleFiles = await copiedStudy(t);
  const chapterFiles = await copiedStudy(t, 'chapter.json');
  const article = await loadStudy(articleFiles.manifestPath, articleFiles.cohortPath);
  const chapter = await loadStudy(chapterFiles.manifestPath, chapterFiles.cohortPath);

  assert.deepEqual(article.manifest.items.map((item) => item.id), ['symptom', 'investigation', 'repair', 'test-notes']);
  assert.deepEqual(chapter.manifest.items.map((item) => item.id), ['arrival', 'letter', 'revelation']);
  assert.equal(article.profiles[0]?.id, 'curious-outside-reader');
  assert.equal(article.sources[0]?.path, path.join(articleFiles.directory, 'article-source.md'));
  assert.equal(article.sources[0]?.sha256, 'dc6bb97ebce3cd0c42945143c1eb230a74377111308d8b8563652898d996daf5');
});

test('loads a direct profile cohort without archetypes', async (t) => {
  const files = await copiedStudy(t);
  const cohort = JSON.parse(await readFile(files.cohortPath, 'utf8')) as {
    archetypes?: unknown[];
    readers: Array<Record<string, unknown>>;
  };
  delete cohort.archetypes;
  for (const reader of cohort.readers) {
    delete reader.archetypeId;
    delete reader.variation;
  }
  await writeFile(files.cohortPath, JSON.stringify(cohort));

  const study = await loadStudy(files.manifestPath, files.cohortPath);
  assert.equal(study.profiles.length, 2);
  assert.equal(study.profiles[0]?.archetypeId, undefined);
});

test('accepts an explicitly absolute source reference', async (t) => {
  const files = await copiedStudy(t);
  const manifest = JSON.parse(await readFile(files.manifestPath, 'utf8')) as {
    sources: Array<{ path: string; sha256: string }>;
  };
  manifest.sources[0]!.path = path.join(files.directory, 'article-source.md');
  await writeFile(files.manifestPath, JSON.stringify(manifest));

  const study = await loadStudy(files.manifestPath, files.cohortPath);
  assert.equal(study.sources[0]?.path, manifest.sources[0]!.path);
});

test('rejects changed source content before a run can be created', async (t) => {
  const files = await copiedStudy(t);
  const sourcePath = path.join(files.directory, 'article-source.md');
  await writeFile(sourcePath, `${await readFile(sourcePath, 'utf8')}Changed source.\n`);
  await assert.rejects(loadStudy(files.manifestPath, files.cohortPath), /source hash/i);
});

test('rejects duplicate or dangling graph IDs and malformed choice edges', async (t) => {
  const files = await copiedStudy(t);
  const manifest = JSON.parse(await readFile(files.manifestPath, 'utf8')) as {
    items: Array<{ id: string }>;
    transitions: Array<{ fromNodeId: string; choice?: string; toNodeId: string }>;
  };
  manifest.items[1]!.id = manifest.items[0]!.id;
  await writeFile(files.manifestPath, JSON.stringify(manifest));
  await assert.rejects(loadStudy(files.manifestPath, files.cohortPath), /IDs must be unique/i);

  manifest.items[1]!.id = 'investigation';
  const decisionEdge = manifest.transitions.find((edge) => edge.fromNodeId === 'choose-investigation' && edge.choice === 'continue');
  decisionEdge!.toNodeId = 'missing-node';
  await writeFile(files.manifestPath, JSON.stringify(manifest));
  await assert.rejects(loadStudy(files.manifestPath, files.cohortPath), /unknown.*node/i);

  decisionEdge!.toNodeId = 'show-repair';
  manifest.transitions = manifest.transitions.filter((edge) => !(edge.fromNodeId === 'choose-investigation' && edge.choice === 'leave'));
  await writeFile(files.manifestPath, JSON.stringify(manifest));
  await assert.rejects(loadStudy(files.manifestPath, files.cohortPath), /transition.*label|edge.*label/i);
});

test('rejects unreachable graph nodes and unsupported manifest versions', async (t) => {
  const files = await copiedStudy(t);
  const manifest = JSON.parse(await readFile(files.manifestPath, 'utf8')) as {
    version: string;
    nodes: Array<{ id: string; kind: string; outcome?: string }>;
  };
  manifest.nodes.push({ id: 'orphan', kind: 'terminal', outcome: 'orphaned' });
  await writeFile(files.manifestPath, JSON.stringify(manifest));
  await assert.rejects(loadStudy(files.manifestPath, files.cohortPath), /unreachable/i);

  manifest.nodes.pop();
  manifest.version = '0.0.5';
  await writeFile(files.manifestPath, JSON.stringify(manifest));
  await assert.rejects(loadStudy(files.manifestPath, files.cohortPath), /only manifest version 1\.0/i);
});

test('rejects unknown manifest fields and requires an explicit frozen cohort', async (t) => {
  const files = await copiedStudy(t);
  await assert.rejects(loadStudy(files.manifestPath, undefined), StudyInputError);
  const manifest = JSON.parse(await readFile(files.manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.workspaceDiscovery = true;
  await writeFile(files.manifestPath, JSON.stringify(manifest));
  await assert.rejects(loadStudy(files.manifestPath, files.cohortPath), /unknown|unrecognized/i);
});

test('rejects duplicate readers in a frozen cohort', async (t) => {
  const files = await copiedStudy(t);
  const cohort = JSON.parse(await readFile(files.cohortPath, 'utf8')) as {
    readers: Array<{ id: string }>;
  };
  cohort.readers[1]!.id = cohort.readers[0]!.id;
  await writeFile(files.cohortPath, JSON.stringify(cohort));
  await assert.rejects(loadStudy(files.manifestPath, files.cohortPath), /duplicate reader/i);
});
