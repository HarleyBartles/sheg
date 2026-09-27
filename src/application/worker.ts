import { createHash } from 'node:crypto';
import { BudgetLedger } from '../domain/budget-ledger.js';
import { CheckpointStore, type RunCheckpoint } from '../infrastructure/checkpoint-store.js';
import type { DecisionResult } from '../domain/decision/decision.js';
import type { DecisionProvider } from '../domain/decision/provider.js';
import { JourneyExecutionError, runJourney } from '../domain/journey/run.js';
import { loadStudy } from '../infrastructure/study-loader.js';
import { promptContractHash } from '../domain/decision/prompt.js';
import { executionFingerprint, stimulusFingerprint } from '../infrastructure/identity.js';

export class RunCancelled extends Error {
  constructor() { super('Run cancellation was requested.'); this.name = 'RunCancelled'; }
}

export async function runWorker(store: CheckpointStore, checkpoint: RunCheckpoint, provider: DecisionProvider, restoredBudget?: BudgetLedger): Promise<RunCheckpoint> {
  const study = await loadStudy(checkpoint.manifestPath, checkpoint.cohortPath);
  const stimulus = stimulusFingerprint(study.manifest, study.cohort, promptContractHash());
  const identityProvider = checkpoint.provider.kind === 'laya'
    ? { kind: 'laya' as const, checkpoint: checkpoint.provider.checkpoint, contextLimit: checkpoint.provider.contextLimit, baseUrl: checkpoint.provider.baseUrl, timeoutMs: checkpoint.provider.timeoutMs, ...(checkpoint.provider.precision === undefined ? {} : { precision: checkpoint.provider.precision }) }
    : checkpoint.provider;
  if (stimulus !== checkpoint.stimulusFingerprint || executionFingerprint(stimulus, identityProvider) !== checkpoint.executionFingerprint) throw new Error('Study or provider settings changed since this run was prepared.');

  const { maxUsd, ...budgetRest } = checkpoint.budget;
  const ledger = restoredBudget ?? BudgetLedger.restore({ ...budgetRest, ...(maxUsd === undefined ? {} : { maxUsd }) });
  const respondents = new Map(study.respondents.map((respondent) => [respondent.id, respondent]));
  const cells = study.manifest.arms.flatMap((arm) => study.respondents.map((respondent) => ({ arm, respondent, id: cellId(arm.id, respondent.id) })));
  const cursor = { next: 0 };

  const runCell = async (arm: typeof study.manifest.arms[number], respondentId: string, id: string): Promise<void> => {
    const profile = respondents.get(respondentId);
    if (!profile) throw new Error(`Frozen respondent ${respondentId} is no longer present.`);
    let decisions: RunCheckpoint['journeys'][number]['decisions'] = [];
    const previous = (await store.read(checkpoint.runId)).journeys.find((journey) => journey.armId === arm.id && journey.respondentId === respondentId);
    const attemptHistory = [...(previous?.attemptHistory ?? [])];
    const replayDecisions = previous?.decisions ?? [];
    const presentedTaskIds = [...(previous?.presentedTaskIds ?? [])];
    let replayCursor = 0;
    await updateCheckpoint(store, checkpoint.runId, (current) => ({ ...current, journeys: replaceJourney(current.journeys, { armId: arm.id, respondentId, status: 'partial', decisions: replayDecisions, attemptHistory, presentedTaskIds }) }));
    try {
      const result = await runJourney({ arm, profile, ask: async (request) => {
        const replay = replayDecisions[replayCursor];
        if (replay) {
          if (replay.decisionId !== request.question.id) throw new Error('Task sequence changed while recovering the run.');
          if (replay.requestFingerprint !== requestFingerprint(request)) throw new Error('Rendered task request changed while recovering the run.');
          replayCursor += 1;
          decisions.push(replay);
          return replay.result;
        }
        const presentedCount = presentedTaskIds.filter((id) => id === request.question.id).length;
        const completedCount = decisions.filter((decision) => decision.decisionId === request.question.id).length;
        if (presentedCount <= completedCount) presentedTaskIds.push(request.question.id);
        await updateCheckpoint(store, checkpoint.runId, (current) => ({ ...current, journeys: replaceJourney(current.journeys, { armId: arm.id, respondentId, status: 'partial', decisions, attemptHistory, presentedTaskIds }) }));
        if (await cancellationRequested(store, checkpoint.runId)) throw new RunCancelled();
        const reservation = await ledger.reserve(1, checkpoint.provider.kind === 'jev' ? checkpoint.maxPerCallUsd : undefined);
        await updateCheckpoint(store, checkpoint.runId, (current) => ({ ...current, budget: ledger.snapshot(), activeCellIds: addUnique(current.activeCellIds, id) }));
        if (await cancellationRequested(store, checkpoint.runId)) {
          await ledger.settle(reservation, { attempts: 0, chargeStatus: 'not_billed' });
          throw new RunCancelled();
        }
        let decision: DecisionResult;
        try { decision = await provider.decide(request, 1); }
        catch (error) {
          await ledger.settle(reservation, errorEvidence(error));
          await updateCheckpoint(store, checkpoint.runId, (current) => ({ ...current, budget: ledger.snapshot(), journeys: replaceJourney(current.journeys, { armId: arm.id, respondentId, status: 'partial', decisions, attemptHistory, presentedTaskIds }) }));
          throw error;
        }
        await ledger.settle(reservation, { attempts: decision.attempts, chargeStatus: decision.chargeStatus, ...(decision.chargeUsd === undefined ? {} : { chargeUsd: decision.chargeUsd }) });
        decisions = [...decisions, { decisionId: request.question.id, requestFingerprint: requestFingerprint(request), result: decision }];
        await updateCheckpoint(store, checkpoint.runId, (current) => ({ ...current, budget: ledger.snapshot(), journeys: replaceJourney(current.journeys, { armId: arm.id, respondentId, status: 'partial', decisions, attemptHistory, presentedTaskIds }) }));
        return decision;
      } });
      await updateCheckpoint(store, checkpoint.runId, (current) => ({ ...current, budget: ledger.snapshot(), journeys: replaceJourney(current.journeys, { armId: arm.id, respondentId, status: 'completed', result, decisions, attemptHistory, presentedTaskIds }) }));
    } catch (error) {
      const cancelled = error instanceof RunCancelled || await cancellationRequested(store, checkpoint.runId);
      const current = await store.read(checkpoint.runId);
      const previousJourney = current.journeys.find((journey) => journey.armId === arm.id && journey.respondentId === respondentId);
      decisions = decisions.length > 0 ? decisions : previousJourney?.decisions ?? [];
      await updateCheckpoint(store, checkpoint.runId, (latest) => ({ ...latest, budget: ledger.snapshot(), journeys: replaceJourney(latest.journeys, {
        armId: arm.id, respondentId, status: cancelled ? 'partial' : 'failed', decisions, attemptHistory, presentedTaskIds,
        ...(!cancelled ? { failureKind: isUnsupported(error) ? 'unsupported-input' as const : error instanceof JourneyExecutionError ? 'journey' as const : 'provider' as const } : {}),
      }) }));
    } finally {
      await updateCheckpoint(store, checkpoint.runId, (current) => ({ ...current, activeCellIds: current.activeCellIds.filter((cell) => cell !== id), budget: ledger.snapshot() }));
    }
  };

  const worker = async (): Promise<void> => {
    while (cursor.next < cells.length) {
      if (await cancellationRequested(store, checkpoint.runId)) return;
      const cell = cells[cursor.next++];
      if (!cell) return;
      const current = await store.read(checkpoint.runId);
      if (current.journeys.some((journey) => journey.armId === cell.arm.id && journey.respondentId === cell.respondent.id && journey.status === 'completed')) continue;
      await runCell(cell.arm, cell.respondent.id, cell.id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(checkpoint.concurrency, cells.length) }, () => worker()));
  return updateCheckpoint(store, checkpoint.runId, (current) => {
    const completed = new Set(current.journeys.filter((journey) => journey.status === 'completed').map((journey) => cellId(journey.armId, journey.respondentId)));
    const failed = current.journeys.some((journey) => journey.status === 'failed');
    return { ...current, status: current.cancellationRequested ? 'cancelled' : completed.size === cells.length ? 'completed' : failed ? 'partial' : 'partial', budget: ledger.snapshot(), activeCellIds: [] };
  });
}

function cellId(armId: string, respondentId: string): string { return `${armId}/${respondentId}`; }
function requestFingerprint(request: unknown): string { return createHash('sha256').update(JSON.stringify(request)).digest('hex'); }
function replaceJourney(journeys: RunCheckpoint['journeys'], replacement: RunCheckpoint['journeys'][number]): RunCheckpoint['journeys'] {
  return [...journeys.filter((journey) => !(journey.armId === replacement.armId && journey.respondentId === replacement.respondentId)), replacement];
}
async function cancellationRequested(store: CheckpointStore, runId: string): Promise<boolean> { return (await store.read(runId)).cancellationRequested; }
async function updateCheckpoint(store: CheckpointStore, runId: string, mutate: (current: RunCheckpoint) => RunCheckpoint): Promise<RunCheckpoint> {
  return store.update(runId, (current) => ({ ...mutate(current), updatedAt: new Date().toISOString() }));
}
function addUnique(values: string[], value: string): string[] { return values.includes(value) ? values : [...values, value]; }
function errorEvidence(error: unknown): { attempts: number; chargeStatus: 'not_billed' | 'unknown' | 'billed'; chargeUsd?: number } {
  if (typeof error === 'object' && error !== null && 'attempts' in error && typeof error.attempts === 'number' && 'chargeStatus' in error && ['not_billed', 'unknown', 'billed'].includes(String(error.chargeStatus))) {
    const evidence = error as { attempts: number; chargeStatus: 'not_billed' | 'unknown' | 'billed'; chargeUsd?: number };
    return { attempts: evidence.attempts, chargeStatus: evidence.chargeStatus, ...(evidence.chargeUsd === undefined ? {} : { chargeUsd: evidence.chargeUsd }) };
  }
  return { attempts: 0, chargeStatus: 'not_billed' };
}
function isUnsupported(error: unknown): boolean { return typeof error === 'object' && error !== null && 'message' in error && String(error.message).includes('unsupported-input'); }
