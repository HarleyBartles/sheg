import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve('.');

test('generated checks reject drift without repairing or deleting checkout files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-generated-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['src', 'scripts', 'skills', 'migrations', 'licenses', 'dist', 'plugins', 'package.json', 'package-lock.json', 'plugin.json', 'plugin.template.json', 'LICENSE', 'mcp.json', 'tsconfig.json']) {
    await cp(path.join(repositoryRoot, name), path.join(root, name), { recursive: true });
  }
  await symlink(path.join(repositoryRoot, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const built = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/build.ts'], { cwd: root, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const check = () => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/check-generated.ts'], { cwd: root, encoding: 'utf8' });
  const clean = check();
  assert.equal(clean.status, 0, clean.stderr);

  const originalManifest = await readFile(path.join(root, 'plugin.json'));
  await writeFile(path.join(root, 'plugin.json'), '{"name":"sheg","version":"0.0.0"}\n');
  await writeFile(path.join(root, 'dist/unexpected.js'), 'unexpected output');
  await rm(path.join(root, 'plugins/sheg/dist/worker.js'));
  const before = await snapshot(root);
  const runtimeOutput = await mkdtemp(path.join(os.tmpdir(), 'sheg-runtime-test-'));
  t.after(() => rm(runtimeOutput, { recursive: true, force: true }));
  const runtimeBuild = spawnSync(process.execPath, ['--import', 'tsx', '--input-type', 'module', '-e',
    "import { buildPlugin } from './scripts/build.ts'; await buildPlugin(process.argv[1]);", runtimeOutput], { cwd: root, encoding: 'utf8' });
  assert.equal(runtimeBuild.status, 0, runtimeBuild.stderr);
  assert.deepEqual(await snapshot(root), before, 'runtime builds used by tests must not repair checkout identities');
  const rejected = check();
  assert.notEqual(rejected.status, 0, rejected.stdout);
  assert.match(rejected.stderr, /plugin\.json/);
  assert.match(rejected.stderr, /unexpected\.js/);
  assert.match(rejected.stderr, /worker\.js/);
  assert.deepEqual(await snapshot(root), before, 'rejection must preserve the stale, extra, and missing outputs');

  await writeFile(path.join(root, 'plugin.json'), originalManifest);
  await rm(path.join(root, 'dist/unexpected.js'));
  await cp(path.join(root, 'dist/worker.js'), path.join(root, 'plugins/sheg/dist/worker.js'));
  await rm(path.join(root, 'plugins/sheg'), { recursive: true });
  const missingPackage = await snapshot(root);
  assert.notEqual(check().status, 0);
  assert.deepEqual(await snapshot(root), missingPackage, 'a missing generated directory must stay missing');
});

async function snapshot(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    files.set(path.relative(root, absolute), createHash('sha256').update(await readFile(absolute)).digest('hex'));
  }
  return files;
}
