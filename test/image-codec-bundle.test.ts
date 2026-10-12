import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { codecAssetNames } from '../src/infrastructure/images/codec-assets.js';

test('copied ESM codec decodes and scales all formats without node_modules or network', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-codec-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = path.join(root, 'codec-assets');
  await mkdir(assets);
  for (const name of codecAssetNames) await cp(path.resolve('dist/codec-assets', name), path.join(assets, name));
  const bundle = path.join(root, 'codec-smoke.mjs');
  await build({ entryPoints: [path.resolve('test/fixtures/image-codec-smoke.ts')], outfile: bundle, bundle: true, platform: 'node', target: 'node24', format: 'esm' });
  const preload = path.join(root, 'deny-network.mjs');
  await writeFile(preload, 'globalThis.fetch = () => { throw new Error("network access forbidden"); };');
  assert.equal((await readdir(root)).includes('node_modules'), false);
  for (const format of ['png', 'jpeg', 'webp']) {
    const input = path.resolve(`test/fixtures/images/${format === 'png' ? 'four-corners-transparent.png' : `four-corners.${format}`}`);
    const output = path.join(root, `candidate.${format}`);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, bundle, assets, input, output], {
      cwd: root,
      env: { PATH: '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), { width: 40, height: 20, format });
    assert.equal((await readFile(output)).length > 0, true);
  }
  const noAssets = path.join(root, 'missing-assets');
  await mkdir(noAssets);
  for (const name of codecAssetNames) if (name !== 'squoosh_png_bg.wasm') await cp(path.resolve('dist/codec-assets', name), path.join(noAssets, name));
  const missing = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, bundle, noAssets, path.resolve('test/fixtures/images/four-corners-transparent.png'), path.join(root, 'missing.png')], {
    cwd: root,
    env: { PATH: '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  assert.notEqual(missing.status, 0);
  assert.deepEqual(JSON.parse(missing.stdout), { code: 'image_codec_unavailable' });
});
