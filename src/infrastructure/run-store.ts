import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { RunCommandRepository, RunPersistence, RunReadRepository, RunStore } from '../application/run-store.js';
import { RunStoreError } from '../application/run-store.js';
import { openSqliteConnection } from './sqlite/connection.js';
import { createSqliteCommandRepository } from './sqlite/command-repository.js';
import { createSqliteReadRepository } from './sqlite/read-repository.js';
import { createSqliteRepositoryContext } from './sqlite/repository-context.js';
export { SCHEMA_VERSION } from './sqlite/schema.js';
export type { AttemptOutcome, DeletePreview, DeleteResult, JourneyTransition, RunListQuery, RunPersistence, RunReadRepository, RunCommandRepository, RunStore, StorageInfo } from '../application/run-store.js';
export { RunStoreError } from '../application/run-store.js';
export { inspectRunStoreCompatibility, runStoreBackupAvailable, type StoreCompatibility } from './sqlite/recovery.js';
import { resetRunStore as resetRunStoreInternal } from './sqlite/recovery.js';

export function openRunStore(dataRoot: string, options: { now?: () => number } = {}): RunStore {
  const persistence = openRunPersistence(dataRoot, options);
  return { ...persistence.reads, ...persistence.commands, close: persistence.close };
}

export function openRunPersistence(dataRoot: string, options: { now?: () => number } = {}): RunPersistence {
  if (!path.isAbsolute(dataRoot)) throw new RunStoreError('invalid_data_root', 'Sheg data directory must be an absolute path.');
  mkdirSync(dataRoot, { recursive: true });
  const databasePath = path.join(dataRoot, 'runs.sqlite');
  const connection = openSqliteConnection(databasePath, dataRoot);
  const context = createSqliteRepositoryContext(connection, databasePath, options.now ?? Date.now);
  const reads = createSqliteReadRepository(context);
  const commands = createSqliteCommandRepository(context, () => reads.storageInfo());
  return { reads, commands, close: context.close };
}

export function splitRunStore(store: RunStore): RunPersistence {
  const reads: RunReadRepository = {
    findSubmission: store.findSubmission.bind(store),
    getStatus: store.getStatus.bind(store),
    evaluationStatuses: store.evaluationStatuses.bind(store),
    getRequestKind: store.getRequestKind.bind(store),
    getRequest: store.getRequest.bind(store),
    getJourneyRun: store.getJourneyRun.bind(store),
    getJourneyWorkerTurn: store.getJourneyWorkerTurn.bind(store),
    list: store.list.bind(store),
    queryEvidence: store.queryEvidence.bind(store),
    getContext: store.getContext.bind(store),
    resolveFollowOnSources: store.resolveFollowOnSources.bind(store),
    answers: store.answers.bind(store),
    attempts: store.attempts.bind(store),
    previewDelete: store.previewDelete.bind(store),
    storageInfo: store.storageInfo.bind(store),
    close: store.close.bind(store),
  };
  const commands: RunCommandRepository = {
    accept: store.accept.bind(store),
    acceptJourney: store.acceptJourney.bind(store),
    requestCancel: store.requestCancel.bind(store),
    resume: store.resume.bind(store),
    deleteRuns: store.deleteRuns.bind(store),
    optimizeStorage: store.optimizeStorage.bind(store),
    claim: store.claim.bind(store),
    heartbeat: store.heartbeat.bind(store),
    reserveNext: store.reserveNext.bind(store),
    reserveBatch: store.reserveBatch.bind(store),
    settleBatch: store.settleBatch.bind(store),
    settle: store.settle.bind(store),
    settleJourney: store.settleJourney.bind(store),
    finish: store.finish.bind(store),
    failLaunch: store.failLaunch.bind(store),
    failRun: store.failRun.bind(store),
    reconcile: store.reconcile.bind(store),
    reconcileMany: store.reconcileMany.bind(store),
    reconcileActive: store.reconcileActive.bind(store),
  };
  return { reads, commands, close: store.close.bind(store) };
}

export function resetRunStore(dataRoot: string): ReturnType<typeof import('./sqlite/recovery.js').resetRunStore> {
  return resetRunStoreInternal(dataRoot, () => {
    const store = openRunStore(dataRoot);
    store.close();
  });
}
