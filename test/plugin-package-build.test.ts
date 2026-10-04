import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generatePluginPackage } from '../scripts/generate-plugin-package.js';

const repositoryRoot = path.resolve('.');

test('plugin package generation emits only reproducible runtime inputs from canonical source', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-package-generation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ['LICENSE', 'mcp.json', 'package.json', 'plugin.json']) await cp(path.join(repositoryRoot, file), path.join(root, file));
  await cp(path.join(repositoryRoot, 'dist'), path.join(root, 'dist'), { recursive: true });
  await cp(path.join(repositoryRoot, 'skills'), path.join(root, 'skills'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await writeFile(path.join(root, 'src/private.ts'), 'must not ship');
  await writeFile(path.join(root, 'test/private.test.ts'), 'must not ship');
  await writeFile(path.join(root, 'scripts/build.ts'), 'must not ship');
  await mkdir(path.join(root, 'skills/study-design/tests/behavior'), { recursive: true });
  await writeFile(path.join(root, 'skills/study-design/tests/behavior/evaluator.json'), '{}');
  await mkdir(path.join(root, 'plugins/sheg'), { recursive: true });
  await writeFile(path.join(root, 'plugins/sheg/stale.txt'), 'remove stale generated output');

  await generatePluginPackage(root);
  const packageRoot = path.join(root, 'plugins/sheg');
  const first = await snapshot(packageRoot);
  await generatePluginPackage(root);
  const second = await snapshot(packageRoot);
  assert.deepEqual([...second.keys()], [...first.keys()]);
  for (const [file, content] of first) assert.deepEqual(second.get(file), content, `${file} should be reproducible`);

  assert.deepEqual(JSON.parse((await readFile(path.join(packageRoot, 'package.json'))).toString()), {
    name: 'sheg',
    version: JSON.parse((await readFile(path.join(root, 'package.json'))).toString()).version,
    type: 'module',
  });
  assert.deepEqual(await readFile(path.join(packageRoot, 'plugin.json')), await readFile(path.join(root, 'plugin.json')));
  assert.ok(first.has('LICENSE'));
  assert.ok(first.has('dist/mcp.js'));
  assert.ok(first.has('dist/worker.js'));
  assert.ok(first.has('dist/credentials/windows-credential.ps1'));
  assert.ok(first.has('dist/data/respondent-archetypes/story-craft-and-culture.json'));
  assert.ok(first.has('skills/stimulus-response-polling/SKILL.md'));
  assert.ok(first.has('skills/stimulus-response-polling/references/run-and-recovery.md'));
  assert.ok(first.has('skills/stimulus-response-polling/assets/run-request.schema.json'));
  assert.ok(first.has('skills/study-design/SKILL.md'));
  assert.ok([...first.keys()].every((file) => !file.includes('/tests/') && !file.startsWith('src/') && !file.startsWith('test/') && !file.startsWith('scripts/')));
  assert.ok(!first.has('.agents/plugins/marketplace.json'));
});

test('marketplace path keeps the existing marketplace and plugin identity and resolves from repository root', async () => {
  const marketplace = JSON.parse(await readFile(path.join(repositoryRoot, '.agents/plugins/marketplace.json'), 'utf8')) as {
    name: string;
    plugins: Array<{ name: string; source: { source: string; path: string } }>;
  };
  assert.equal(marketplace.name, 'sheg');
  assert.equal(marketplace.plugins[0]?.name, 'sheg');
  assert.deepEqual(marketplace.plugins[0]?.source, { source: 'local', path: './plugins/sheg' });
  assert.equal(path.resolve(repositoryRoot, marketplace.plugins[0]!.source.path), path.join(repositoryRoot, 'plugins/sheg'));
});

test('package generation refuses an unsafe destination parent without modifying it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-package-parent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = 'preserve unrelated file';
  await writeFile(path.join(root, 'plugins'), marker);
  await assert.rejects(generatePluginPackage(root), /parent must be a directory/i);
  assert.equal(await readFile(path.join(root, 'plugins'), 'utf8'), marker);
});

async function snapshot(directory: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(entry.parentPath, entry.name);
    const relative = path.relative(directory, fullPath).replaceAll('\\', '/');
    const content = await readFile(fullPath);
    files.set(relative, content);
  }
  return new Map([...files].sort(([left], [right]) => left.localeCompare(right)));
}
