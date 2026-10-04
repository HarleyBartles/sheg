import os from 'node:os';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createRunService } from '../../src/application/run-service.js';
import { executeQuestionRun } from '../../src/application/question-worker.js';
import { resolveDataRoot } from '../../src/infrastructure/data-root.js';
import { openRunStore } from '../../src/infrastructure/run-store.js';
import { createPollingServer } from '../../src/entrypoints/mcp.js';
import { createControlledRecoveryProvider } from './controlled-recovery.js';

function createControlledRecoveryServer(): ReturnType<typeof createPollingServer> {
  const dataRoot = resolveDataRoot(process.env, process.platform, os.homedir());
  const store = openRunStore(dataRoot);
  const providerFactory = createControlledRecoveryProvider;
  const service = createRunService(
    store,
    dataRoot,
    providerFactory,
    { async launch(_root, runId) { await executeQuestionRun(store, runId, providerFactory); } },
    { assertProviderReady: async () => {} },
  );
  return createPollingServer(service);
}

serveStdio(createControlledRecoveryServer, { onerror: (error) => process.stderr.write(`${error.message}\n`) });
