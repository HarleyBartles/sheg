import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { syncPackageLockVersion } from '../scripts/generate-package-lock.js';

test('package-lock generation follows package.json and preserves dependency metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-lock-version-'));
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'sheg', version: '0.3.0-dev.12' }));
    const input = {
      name: 'sheg',
      version: '0.3.0-dev.11',
      lockfileVersion: 3,
      packages: {
        '': { name: 'sheg', version: '0.3.0-dev.11', license: 'MIT' },
        'node_modules/zod': { version: '4.6.5', resolved: 'https://registry.npmjs.org/zod/-/zod-4.6.5.tgz' },
      },
      dependencies: { zod: { version: '4.6.5' } },
    };
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify(input, null, 2));

    await syncPackageLockVersion(root);

    const actual = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8')) as typeof input;
    assert.equal(actual.version, '0.3.0-dev.12');
    assert.equal(actual.packages[''].version, '0.3.0-dev.12');
    assert.deepEqual(actual.packages['node_modules/zod'], input.packages['node_modules/zod']);
    assert.deepEqual(actual.dependencies, input.dependencies);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('package-lock generation rejects a lockfile without the root package entry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-lock-version-invalid-'));
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'sheg', version: '0.3.0-dev.12' }));
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'sheg', version: '0.3.0-dev.11', packages: {} }));
    await assert.rejects(syncPackageLockVersion(root), /root package entry/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
