import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadStudy } from '../src/infrastructure/study-loader.js';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
async function copiedStudy(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'poll-study-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(fixtures, directory, { recursive: true });
  return { directory, manifest: path.join(directory, 'article.json'), cohort: path.join(directory, 'cohort.json') };
}
test('loads article and chapter as arms using shared stimulus and response primitives', async (t) => {
  const files = await copiedStudy(t);
  const article = await loadStudy(files.manifest, files.cohort);
  const chapter = await loadStudy(path.join(files.directory, 'chapter.json'), files.cohort);
  assert.deepEqual(article.manifest.arms[0]?.items.map((item) => item.id), ['symptom', 'investigation', 'repair', 'test-notes']);
  assert.deepEqual(chapter.manifest.arms[0]?.items.map((item) => item.id), ['arrival', 'letter', 'revelation']);
  assert.equal(article.respondents.length, 2);
  assert.equal(article.sources[0]?.armId, 'original');
});
test('rejects source content that does not match the declared hash', async (t) => {
  const files = await copiedStudy(t);
  await writeFile(path.join(files.directory, 'article-source.md'), `${await readFile(path.join(files.directory, 'article-source.md'), 'utf8')}changed`);
  await assert.rejects(loadStudy(files.manifest, files.cohort), /source hash/i);
});
test('rejects malformed arm graph references and incomplete option edges', async (t) => {
  const files = await copiedStudy(t);
  const data = JSON.parse(await readFile(files.manifest, 'utf8'));
  data.arms[0].presentation.transitions.pop();
  await writeFile(files.manifest, JSON.stringify(data));
  await assert.rejects(loadStudy(files.manifest, files.cohort), /exactly one unconditional transition|unreachable nodes/i);
});
test('rejects duplicate comparison keys for distinct tasks in one arm', async (t) => {
  const files = await copiedStudy(t);
  const data = JSON.parse(await readFile(files.manifest, 'utf8'));
  data.arms[0].tasks[0].comparisonKey = 'same';
  data.arms[0].tasks[1].comparisonKey = 'same';
  await writeFile(files.manifest, JSON.stringify(data));
  await assert.rejects(loadStudy(files.manifest, files.cohort), /comparisonKey must identify at most one task/i);
});
test('rejects duplicate respondents and requires an explicit cohort', async (t) => {
  const files = await copiedStudy(t);
  const cohort = JSON.parse(await readFile(files.cohort, 'utf8'));
  cohort.respondents[1].id = cohort.respondents[0].id;
  await writeFile(files.cohort, JSON.stringify(cohort));
  await assert.rejects(loadStudy(files.manifest, files.cohort), /duplicate respondent/i);
  await assert.rejects(loadStudy(files.manifest, undefined), /explicit frozen cohort/i);
});
