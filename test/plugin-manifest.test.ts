import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginManifest } from '../scripts/generate-plugin-manifest.js';

test('the plugin manifest generator takes its version only from package identity', () => {
  const manifest = createPluginManifest({ $schema: 'plugin-schema', name: 'sheg', description: 'A plugin.' }, { version: '0.3.0-dev.7' });

  assert.deepEqual(manifest, { $schema: 'plugin-schema', name: 'sheg', version: '0.3.0-dev.7', description: 'A plugin.' });
});
