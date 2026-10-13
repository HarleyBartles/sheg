import { executeQuestionRun } from '../application/question-worker.js';
import { openRunPersistence } from '../infrastructure/run-store.js';
import { assertProviderReady, createProvider } from '../providers/factory.js';
import { openImageAssetRepository } from '../infrastructure/sqlite/image-assets.js';

const [outputDirectory, runId] = process.argv.slice(2);
if (!outputDirectory || !runId) throw new Error('Usage: worker <output-directory> <run-id>');
const store = openRunPersistence(outputDirectory);
const images = openImageAssetRepository(outputDirectory);
try {
  await executeQuestionRun(store, runId, createProvider, {
    imageResolver: { resolve(assetId: string) { return { metadata: images.metadata(assetId), bytes: images.bytes(assetId) }; } },
  }, assertProviderReady);
} finally { images.close(); store.close(); }
