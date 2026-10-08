import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginManifest } from '../scripts/generate-plugin-manifest.js';

test('the plugin manifest generator takes its version only from package identity', () => {
  const manifest = createPluginManifest({ $schema: 'plugin-schema', name: 'sheg', description: 'A plugin.' }, { version: '0.3.0-dev.7' });

  assert.deepEqual(manifest, { $schema: 'plugin-schema', name: 'sheg', version: '0.3.0-dev.7', description: 'A plugin.' });
});

test('manifest generation rejects identities that packaging cannot accept', () => {
  for (const version of ['00.3.1', '0.03.1', '0.3.01', '0.3.1-dev.0', '0.3.1-dev.01', '0.3.1-rc.0', '0.3.1-rc.01']) {
    assert.throws(() => createPluginManifest({ name: 'sheg' }, { version }), /supported stable or prerelease version/, version);
  }
  for (const version of ['0.3.1', '0.3.1-dev.1', '0.3.1-rc.12']) {
    assert.equal(createPluginManifest({ name: 'sheg' }, { version }).version, version);
  }
});
