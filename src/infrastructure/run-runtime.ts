import os from 'node:os';
import { createRunService, RunServiceError, type RunService } from '../application/run-service.js';
import { resolveDataRoot } from './data-root.js';
import { ProcessLock } from './process-lock.js';
import { inspectRunStoreCompatibility, openRunStore, resetRunStore, runStoreBackupAvailable, RunStoreError, SCHEMA_VERSION, type RunStore } from './run-store.js';
import { DetachedWorkerLauncher } from './worker-launcher.js';
import { assertProviderReady, createProvider } from '../providers/factory.js';
import type { StorageOperation } from '../application/run-operations.js';

// Composition and datastore recovery are shared by all public entrypoints.
export function createRunRuntime(dataRoot = resolveDataRoot(process.env, process.platform, os.homedir()), service?: RunService) {
  let runtimeService: RunService;
  let ownedStore: RunStore | undefined;
  let storeReady = service !== undefined;
  let startupFailure: unknown;
  if (service) runtimeService = service;
  else {
    try { const runtime = createDefaultRunService(dataRoot); runtimeService = runtime.service; ownedStore = runtime.store; storeReady = true; }
    catch (error) { runtimeService = unavailableRunService(); startupFailure = error; }
  }

  async function storage(input: StorageOperation): Promise<unknown> {
    if (input.operation === 'inspect') {
      if (storeReady) return { ...runtimeService.storageInfo(), recoveryRequired: false, compatibility: { status: 'current', schemaVersion: SCHEMA_VERSION } };
      const observed = inspectRunStoreCompatibility(dataRoot);
      if (observed.status === 'current') {
        const runtime = createDefaultRunService(dataRoot);
        runtimeService = runtime.service;
        ownedStore = runtime.store;
        storeReady = true;
        startupFailure = undefined;
        return { ...runtimeService.storageInfo(), recoveryRequired: false, compatibility: { status: 'current', schemaVersion: SCHEMA_VERSION } };
      }
      const issue = startupFailure instanceof RunStoreError
        ? { code: startupFailure.code }
        : { code: observed.status === 'unreadable' ? 'datastore_unreadable' : 'datastore_open_failed' };
      const compatibility = compatibilityStatus(observed, startupFailure);
      return { recoveryRequired: true, compatibility, issue, backupAvailable: runStoreBackupAvailable(dataRoot) };
    }

    if (input.operation === 'optimize') {
      if (!storeReady) throw recoveryRequiredError();
      runtimeService.optimizeStorage();
      return { optimized: true };
    }

    const resetLock = await ProcessLock.acquire(dataRoot, 'run-storage-reset');
    try {
      if (storeReady || inspectRunStoreCompatibility(dataRoot).status === 'current') {
        throw new RunServiceError('recovery_not_required', 'The datastore no longer requires recovery; inspect its current status before taking further action.');
      }
      const reset = resetRunStore(dataRoot);
      const runtime = createDefaultRunService(dataRoot);
      runtimeService = runtime.service;
      ownedStore = runtime.store;
      storeReady = true;
      startupFailure = undefined;
      return { ...reset, recoveryRequired: false, compatibility: { status: 'current', schemaVersion: SCHEMA_VERSION } };
    } catch (error) {
      startupFailure = error;
      throw error;
    } finally {
      await resetLock.release();
    }
  }

  return {
    get service(): RunService { return runtimeService; },
    close(): void { ownedStore?.close(); ownedStore = undefined; },
    storage,
  };
}

function compatibilityStatus(observed: ReturnType<typeof inspectRunStoreCompatibility>, startupFailure: unknown): Record<string, unknown> {
  if (startupFailure instanceof RunStoreError && startupFailure.code.startsWith('migration_')) {
    return { status: 'migration_failed', schemaVersion: observed.status === 'migration_available' ? observed.schemaVersion : null };
  }
  if (observed.status === 'migration_available') return { status: 'migration_available', schemaVersion: observed.schemaVersion };
  if (observed.status === 'uninitialized') return { status: 'uninitialized', schemaVersion: 0 };
  return { status: observed.status, schemaVersion: observed.status === 'unreadable' ? null : observed.schemaVersion };
}

function createDefaultRunService(dataRoot: string): { service: RunService; store: RunStore } {
  const store = openRunStore(dataRoot);
  return { service: createRunService(store, dataRoot, createProvider, new DetachedWorkerLauncher(), { assertProviderReady }), store };
}

function unavailableRunService(): RunService {
  return new Proxy(Object.create(null) as RunService, {
    get: (_target, property) => property === 'then' ? undefined : () => { throw recoveryRequiredError(); },
  });
}

function recoveryRequiredError(): RunServiceError {
  return new RunServiceError('datastore_recovery_required', 'The Sheg datastore requires recovery. Inspect storage before using study operations.');
}

