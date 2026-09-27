import { BudgetLedger } from '../infrastructure/budget-ledger.js';
import { CheckpointStore, type RunCheckpoint } from '../infrastructure/checkpoint-store.js';
import type { DecisionProvider, DecisionResult } from '../domain/decision/contract.js';
import { JourneyExecutionError, runJourney } from '../domain/journey/run.js';
import { loadStudy } from '../domain/study/load-study.js';
import { promptContractHash } from '../domain/decision/prompt.js';
import { executionFingerprint, stimulusFingerprint } from '../infrastructure/identity.js';

export class RunCancelled extends Error {
  constructor() {
    super('Run cancellation was requested.');
    this.name = 'RunCancelled';
  }
}

export async function runWorker(
  store: CheckpointStore,
  checkpoint: RunCheckpoint,
  provider: DecisionProvider,
  restoredBudget?: BudgetLedger,
): Promise<RunCheckpoint> {
  const study = await loadStudy(checkpoint.manifestPath, checkpoint.cohortPath);
  const stimulus = stimulusFingerprint(study.manifest, study.profiles, promptContractHash());
  const identityProvider = checkpoint.provider.kind === 'laya'
    ? { kind: 'laya' as const, checkpoint: checkpoint.provider.checkpoint, contextLimit: checkpoint.provider.contextLimit, baseUrl: checkpoint.provider.baseUrl, timeoutMs: checkpoint.provider.timeoutMs, ...(checkpoint.provider.precision === undefined ? {} : { precision: checkpoint.provider.precision }) }
    : checkpoint.provider;
  const execution = executionFingerprint(stimulus, identityProvider);
  if (stimulus !== checkpoint.stimulusFingerprint || execution !== checkpoint.executionFingerprint) {
    throw new Error('Study or provider settings changed since this run was prepared.');
  }

  const { maxUsd, ...budgetRest } = checkpoint.budget;
  const ledger = restoredBudget ?? BudgetLedger.restore({ ...budgetRest, ...(maxUsd === undefined ? {} : { maxUsd }) });
  const profileById = new Map(study.profiles.map((profile) => [profile.id, profile]));
  const cursor = { next: 0 };

  const runReader = async (readerId: string): Promise<void> => {
    const profile = profileById.get(readerId);
    if (!profile) throw new Error(`Frozen reader ${readerId} is no longer present.`);
    let decisions: Array<{ decisionId: string; result: DecisionResult }> = [];
    const previousJourney = (await store.read(checkpoint.runId)).journeys.find((journey) => journey.readerId === readerId);
    const attemptHistory = [...(previousJourney?.attemptHistory ?? []), ...(previousJourney?.decisions ?? [])];
    try {
      const result = await runJourney({
        study: study.manifest,
        profile,
        ask: async (request) => {
          if (await cancellationRequested(store, checkpoint.runId)) throw new RunCancelled();
          const reservation = await ledger.reserve(1, checkpoint.provider.kind === 'jev' ? checkpoint.maxPerCallUsd : undefined);
          await updateCheckpoint(store, checkpoint.runId, (current) => ({
            ...current,
            budget: ledger.snapshot(),
            activeReaderIds: addUnique(current.activeReaderIds, readerId),
          }));
          if (await cancellationRequested(store, checkpoint.runId)) {
            await ledger.settle(reservation, { attempts: 0, chargeStatus: 'not_billed' });
            await updateCheckpoint(store, checkpoint.runId, (current) => ({ ...current, budget: ledger.snapshot() }));
            throw new RunCancelled();
          }
          let decision: DecisionResult;
          try {
            decision = await provider.decide(request, 1);
          } catch (error) {
            const evidence = errorEvidence(error);
            await ledger.settle(reservation, evidence);
            await updateCheckpoint(store, checkpoint.runId, (current) => ({
              ...current,
              budget: ledger.snapshot(),
              journeys: replaceJourney(current.journeys, {
                readerId,
                status: 'partial',
                decisions,
                attemptHistory,
              }, current.readerIds),
            }));
            throw error;
          }
          await ledger.settle(reservation, {
            attempts: decision.attempts,
            chargeStatus: decision.chargeStatus,
            ...(decision.chargeUsd === undefined ? {} : { chargeUsd: decision.chargeUsd }),
          });
          decisions = [...decisions, { decisionId: request.question.id, result: decision }];
          await updateCheckpoint(store, checkpoint.runId, (current) => ({
            ...current,
            budget: ledger.snapshot(),
            journeys: replaceJourney(current.journeys, {
              readerId,
              status: 'partial',
              decisions,
              attemptHistory,
            }, current.readerIds),
          }));
          return decision;
        },
      });
      await updateCheckpoint(store, checkpoint.runId, (current) => ({
        ...current,
        budget: ledger.snapshot(),
        journeys: replaceJourney(current.journeys, { readerId, status: 'completed', result, decisions, attemptHistory }, current.readerIds),
      }));
    } catch (error) {
      const cancelled = error instanceof RunCancelled || await cancellationRequested(store, checkpoint.runId);
      const current = await store.read(checkpoint.runId);
      const previous = current.journeys.find((journey) => journey.readerId === readerId);
      decisions = decisions.length > 0 ? decisions : previous?.decisions ?? [];
      await updateCheckpoint(store, checkpoint.runId, (latest) => ({
        ...latest,
        budget: ledger.snapshot(),
        journeys: replaceJourney(latest.journeys, {
          readerId,
          status: cancelled ? 'partial' : 'failed',
          decisions,
          attemptHistory,
          ...(!cancelled ? { failureKind: isUnsupported(error) ? 'unsupported-input' as const : error instanceof JourneyExecutionError ? 'journey' as const : 'provider' as const } : {}),
        }, latest.readerIds),
      }));
    } finally {
      await updateCheckpoint(store, checkpoint.runId, (current) => ({
        ...current,
        activeReaderIds: current.activeReaderIds.filter((id) => id !== readerId),
        budget: ledger.snapshot(),
      }));
    }
  };

  const worker = async (): Promise<void> => {
    while (cursor.next < checkpoint.readerIds.length) {
      if (await cancellationRequested(store, checkpoint.runId)) return;
      const readerId = checkpoint.readerIds[cursor.next++];
      if (!readerId) return;
      const current = await store.read(checkpoint.runId);
      if (current.journeys.some((journey) => journey.readerId === readerId && journey.status === 'completed')) continue;
      await runReader(readerId);
    }
  };

  await Promise.all(Array.from({ length: Math.min(checkpoint.concurrency, checkpoint.readerIds.length) }, () => worker()));
  return updateCheckpoint(store, checkpoint.runId, (current) => {
    const done = new Set(current.journeys.filter((journey) => journey.status === 'completed').map((journey) => journey.readerId));
    const failed = current.journeys.some((journey) => journey.status === 'failed');
    const status = current.cancellationRequested ? 'cancelled' : done.size === current.readerIds.length ? 'completed' : failed ? 'partial' : 'partial';
    return { ...current, status, budget: ledger.snapshot(), activeReaderIds: [] };
  });
}

async function cancellationRequested(store: CheckpointStore, runId: string): Promise<boolean> {
  return (await store.read(runId)).cancellationRequested;
}

async function updateCheckpoint(
  store: CheckpointStore,
  runId: string,
  mutate: (current: RunCheckpoint) => RunCheckpoint,
): Promise<RunCheckpoint> {
  return store.update(runId, (current) => ({ ...mutate(current), updatedAt: new Date().toISOString() }));
}

function replaceJourney(
  journeys: RunCheckpoint['journeys'],
  replacement: RunCheckpoint['journeys'][number],
  readerOrder: readonly string[],
): RunCheckpoint['journeys'] {
  const next = [...journeys.filter((journey) => journey.readerId !== replacement.readerId), replacement];
  const index = new Map(readerOrder.map((id, order) => [id, order]));
  return next.sort((left, right) => (index.get(left.readerId) ?? Number.MAX_SAFE_INTEGER) - (index.get(right.readerId) ?? Number.MAX_SAFE_INTEGER));
}

function addUnique(values: readonly string[], value: string): string[] {
  return values.includes(value) ? [...values] : [...values, value];
}

function isUnsupported(error: unknown): boolean {
  return error instanceof Error && /unsupported-input/i.test(error.message);
}

function errorEvidence(error: unknown): { attempts: number; chargeStatus: 'billed' | 'not_billed' | 'unknown'; chargeUsd?: number } {
  if (!error || typeof error !== 'object') return { attempts: 1, chargeStatus: 'unknown' };
  const value = error as Record<string, unknown>;
  const attempts = Number.isInteger(value.attempts) && (value.attempts as number) >= 0 ? value.attempts as number : 1;
  if (value.chargeStatus === 'billed' && typeof value.chargeUsd === 'number') {
    return { attempts, chargeStatus: 'billed', chargeUsd: value.chargeUsd };
  }
  if (value.chargeStatus === 'not_billed') return { attempts, chargeStatus: 'not_billed' };
  return { attempts, chargeStatus: 'unknown' };
}
