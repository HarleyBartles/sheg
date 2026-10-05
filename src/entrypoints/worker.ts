import { executeQuestionRun } from '../application/question-worker.js';
import { openRunPersistence } from '../infrastructure/run-store.js';
import { createProvider } from '../providers/factory.js';

const [outputDirectory, runId] = process.argv.slice(2);
if (!outputDirectory || !runId) throw new Error('Usage: worker <output-directory> <run-id>');
const store = openRunPersistence(outputDirectory);
try { await executeQuestionRun(store, runId, createProvider); }
finally { store.close(); }
