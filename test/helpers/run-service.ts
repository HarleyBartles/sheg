import { createRunService, type ProviderFactory, type RunServiceOptions, type WorkerLauncher } from '../../src/application/run-service.js';
import type { RunStore } from '../../src/application/run-store.js';
import { splitRunStore } from '../../src/infrastructure/run-store.js';

export function createRunServiceForStore(
  store: RunStore,
  dataRoot: string,
  providerFactory: ProviderFactory,
  launcher: WorkerLauncher,
  options?: RunServiceOptions,
) {
  return createRunService(splitRunStore(store), dataRoot, providerFactory, launcher, options);
}
