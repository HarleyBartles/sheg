import { createHash } from 'node:crypto';
import { AttemptLedger } from '../domain/attempt-ledger.js';
import { CheckpointStore, type ContextFailure, type RunCheckpoint } from '../infrastructure/checkpoint-store.js';
import type { DecisionRequest, DecisionResult } from '../domain/decision/decision.js';
import type { DecisionProvider } from '../domain/decision/provider.js';
import { JourneyExecutionError, runJourney } from '../domain/journey/run.js';
import { loadStudy } from '../infrastructure/study-loader.js';
import { promptContractHash } from '../domain/decision/prompt.js';
import { executionFingerprint, stimulusFingerprint } from '../infrastructure/identity.js';

export class RunCancelled extends Error {
  constructor() { super('Run cancellation was requested.'); this.name = 'RunCancelled'; }
}

export async function runWorker(store: CheckpointStore, checkpoint: RunCheckpoint, provider: DecisionProvider, restoredBudget?: AttemptLedger): Promise<RunCheckpoint> {
  const study = await loadStudy(checkpoint.manifestPath, checkpoint.cohortPath);
  const stimulus = stimulusFingerprint(study.manifest, study.cohort, promptContractHash());
  const identityProvider = checkpoint.provider.kind === 'laya'
    ? { kind: 'laya' as const, checkpoint: checkpoint.provider.checkpoint, contextLimit: checkpoint.provider.contextLimit, headLimit: checkpoint.provider.headLimit, tokenizerSha256: checkpoint.provider.tokenizerSha256, baseUrl: checkpoint.provider.baseUrl, timeoutMs: checkpoint.provider.timeoutMs, ...(checkpoint.provider.precision === undefined ? {} : { precision: checkpoint.provider.precision }) }
    : checkpoint.provider;
  if (stimulus !== checkpoint.stimulusFingerprint || executionFingerprint(stimulus, identityProvider) !== checkpoint.executionFingerprint) throw new Error('Study or provider settings changed since this run was prepared.');

  const ledger = restoredBudget ?? AttemptLedger.restore(checkpoint.budget);
  const respondents = new Map(study.respondents.map((respondent) => [respondent.id, respondent]));
  const cells = study.manifest.arms.flatMap((arm) => study.respondents.map((respondent) => ({ arm, respondent, id: cellId(arm.id, respondent.id) })));
  const cursor = { next: 0 };
  let stopWorkers = false;

  const runCell = async (arm: typeof study.manifest.arms[number], respondentId: string, id: string): Promise<void> => {
    const profile = respondents.get(respondentId);
    if (!profile) throw new Error(`Frozen respondent ${respondentId} is no longer present.`);
    let decisions: RunCheckpoint['journeys'][number]['decisions'] = [];
    const previous = (await store.read(checkpoint.runId)).journeys.find((journey) => journey.armId === arm.id && journey.respondentId === respondentId);
    let failedAttempts = previous?.failedAttempts ?? 0;
    const attemptHistory = [...(previous?.attemptHistory ?? [])];
    const replayDecisions = previous?.decisions ?? [];
    const presentedTaskIds = [...(previous?.presentedTaskIds ?? [])];
    let replayCursor = 0;
    let failedNodeId: string | null = null;
    await updateCheckpoint(store, checkpoint.runId, (current) => ({ ...current, journeys: replaceJourney(current.journeys, { armId: arm.id, respondentId, status: 'partial', decisions: replayDecisions, attemptHistory, failedAttempts, presentedTaskIds }) }));
    try {
      const result = await runJourney({ arm, profile, ask: async (request, nodeId) => {
        const legacyChoiceReplay = checkpoint.migratedFromFormatVersion === 2;
        const providerRequest = legacyChoiceReplay ? legacyChoiceRequest(request) : request;
        const replay = replayDecisions[replayCursor];
        if (replay) {
          if (replay.decisionId !== request.question.id) throw new Error('Task sequence changed while recovering the run.');
          if (replay.requestFingerprint !== requestFingerprint(request) && !(legacyChoiceReplay && replay.requestFingerprint === legacyChoiceRequestFingerprint(request))) throw new Error('Rendered task request changed while recovering the run.');
          replayCursor += 1;
          decisions.push(replay);
          return replay.result;
        }
        const presentedCount = presentedTaskIds.filter((id) => id === request.question.id).length;
        const completedCount = decisions.filter((decision) => decision.decisionId === request.question.id).length;
        if (presentedCount <= completedCount) presentedTaskIds.push(request.question.id);
        await updateCheckpoint(store, checkpoint.runId, (current) => ({ ...current, journeys: replaceJourney(current.journeys, { armId: arm.id, respondentId, status: 'partial', decisions, attemptHistory, failedAttempts, presentedTaskIds }) }));
        if (await cancellationRequested(store, checkpoint.runId)) throw new RunCancelled();
        const reservation = await ledger.reserve(1);
        await updateCheckpoint(store, checkpoint.runId, (current) => ({ ...current, budget: ledger.snapshot(), activeCellIds: addUnique(current.activeCellIds, id) }));
        if (await cancellationRequested(store, checkpoint.runId)) {
          await ledger.settle(reservation, { attempts: 0 });
          throw new RunCancelled();
        }
        failedNodeId = nodeId;
        let decision: DecisionResult;
        try { decision = await provider.decide(providerRequest, 1); }
        catch (error) {
          const evidence = errorEvidence(error);
          await ledger.settle(reservation, evidence);
          failedAttempts += evidence.attempts;
          await updateCheckpoint(store, checkpoint.runId, (current) => ({ ...current, budget: ledger.snapshot(), journeys: replaceJourney(current.journeys, { armId: arm.id, respondentId, status: 'partial', decisions, attemptHistory, failedAttempts, presentedTaskIds }) }));
          throw error;
        }
        await ledger.settle(reservation, { attempts: decision.attempts });
        decisions = [...decisions, { decisionId: request.question.id, requestFingerprint: legacyChoiceReplay ? legacyChoiceRequestFingerprint(request) : requestFingerprint(request), result: decision }];
        await updateCheckpoint(store, checkpoint.runId, (current) => ({ ...current, budget: ledger.snapshot(), journeys: replaceJourney(current.journeys, { armId: arm.id, respondentId, status: 'partial', decisions, attemptHistory, failedAttempts, presentedTaskIds }) }));
        return decision;
      } });
      await updateCheckpoint(store, checkpoint.runId, (current) => ({ ...current, budget: ledger.snapshot(), journeys: replaceJourney(current.journeys, { armId: arm.id, respondentId, status: 'completed', result, decisions, attemptHistory, failedAttempts, presentedTaskIds }) }));
    } catch (error) {
      const cancelled = error instanceof RunCancelled || await cancellationRequested(store, checkpoint.runId);
      const current = await store.read(checkpoint.runId);
      const previousJourney = current.journeys.find((journey) => journey.armId === arm.id && journey.respondentId === respondentId);
      decisions = decisions.length > 0 ? decisions : previousJourney?.decisions ?? [];
      const failureEvidence = cancelled ? null : admissionFailure(error, failedNodeId);
      await updateCheckpoint(store, checkpoint.runId, (latest) => ({ ...latest, budget: ledger.snapshot(), journeys: replaceJourney(latest.journeys, {
        armId: arm.id, respondentId, status: cancelled ? 'partial' : 'failed', decisions, attemptHistory, failedAttempts, presentedTaskIds,
        ...(!cancelled ? { failureKind: isUnsupported(error) ? 'unsupported-input' as const : error instanceof JourneyExecutionError ? 'journey' as const : 'provider' as const } : {}),
        ...(failureEvidence === null ? {} : { failureEvidence }),
      }) }));
    } finally {
      await updateCheckpoint(store, checkpoint.runId, (current) => ({ ...current, activeCellIds: current.activeCellIds.filter((cell) => cell !== id), budget: ledger.snapshot() }));
    }
  };

  const worker = async (): Promise<void> => {
    while (!stopWorkers && cursor.next < cells.length) {
      if (await cancellationRequested(store, checkpoint.runId)) return;
      if (stopWorkers) return;
      const cell = cells[cursor.next++];
      if (!cell) return;
      const current = await store.read(checkpoint.runId);
      if (stopWorkers) return;
      if (current.journeys.some((journey) => journey.armId === cell.arm.id && journey.respondentId === cell.respondent.id && journey.status === 'completed')) continue;
      await runCell(cell.arm, cell.respondent.id, cell.id);
    }
  };
  const workers = Array.from({ length: Math.min(checkpoint.concurrency, cells.length) }, async () => {
    try { await worker(); }
    catch (error) { stopWorkers = true; throw error; }
  });
  const workerResults = await Promise.allSettled(workers);
  const workerFailure = workerResults.find((result) => result.status === 'rejected');
  if (workerFailure?.status === 'rejected') throw workerFailure.reason;
  return updateCheckpoint(store, checkpoint.runId, (current) => {
    const completed = new Set(current.journeys.filter((journey) => journey.status === 'completed').map((journey) => cellId(journey.armId, journey.respondentId)));
    const failed = current.journeys.some((journey) => journey.status === 'failed');
    return { ...current, status: current.cancellationRequested ? 'cancelled' : completed.size === cells.length ? 'completed' : failed ? 'partial' : 'partial', budget: ledger.snapshot(), activeCellIds: [] };
  });
}

function cellId(armId: string, respondentId: string): string { return `${armId}/${respondentId}`; }
function requestFingerprint(request: unknown): string { return createHash('sha256').update(JSON.stringify(request)).digest('hex'); }
export function legacyChoiceRequestFingerprint(request: unknown): string {
  if (typeof request !== 'object' || request === null || !('question' in request) || !('state' in request)) return '';
  const value = request as { question: Record<string, unknown>; state: Record<string, unknown> };
  if (value.question.type !== 'choice') return '';
  const question = { ...value.question };
  delete question.type;
  const state = legacyChoiceState(value.state);
  return requestFingerprint({ state, question, ...('optionIds' in (request as object) ? { optionIds: (request as unknown as { optionIds: unknown }).optionIds } : {}) });
}
function legacyChoiceRequest(request: DecisionRequest): DecisionRequest {
  if (request.question.type !== 'choice') throw new Error('Version-2 checkpoints can resume Choice tasks only.');
  return { ...request, state: legacyChoiceState(request.state) } as DecisionRequest;
}
function legacyChoiceState(source: Record<string, unknown>): Record<string, unknown> {
  const state = structuredClone(source);
  const trajectory = state.trajectory as Record<string, unknown> | undefined;
  if (trajectory) {
    delete trajectory.responses;
    trajectory.decisionCount = Array.isArray(trajectory.choices) ? trajectory.choices.length : 0;
    delete trajectory.payloadUtf8Bytes;
    let bytes = 0;
    for (;;) { const size = new TextEncoder().encode(JSON.stringify({ ...trajectory, payloadUtf8Bytes: bytes })).length; if (size === bytes) break; bytes = size; }
    trajectory.payloadUtf8Bytes = bytes;
  }
  return state;
}
function replaceJourney(journeys: RunCheckpoint['journeys'], replacement: RunCheckpoint['journeys'][number]): RunCheckpoint['journeys'] {
  return [...journeys.filter((journey) => !(journey.armId === replacement.armId && journey.respondentId === replacement.respondentId)), replacement];
}
async function cancellationRequested(store: CheckpointStore, runId: string): Promise<boolean> { return (await store.read(runId)).cancellationRequested; }
async function updateCheckpoint(store: CheckpointStore, runId: string, mutate: (current: RunCheckpoint) => RunCheckpoint): Promise<RunCheckpoint> {
  return store.update(runId, (current) => ({ ...mutate(current), updatedAt: new Date().toISOString() }));
}
function addUnique(values: string[], value: string): string[] { return values.includes(value) ? values : [...values, value]; }
function errorEvidence(error: unknown): { attempts: number } {
  if (typeof error === 'object' && error !== null && 'attempts' in error && typeof error.attempts === 'number' && Number.isSafeInteger(error.attempts) && error.attempts >= 0) {
    return { attempts: error.attempts };
  }
  return { attempts: 1 };
}
function isUnsupported(error: unknown): boolean { return typeof error === 'object' && error !== null && 'message' in error && String(error.message).includes('unsupported-input'); }
function admissionFailure(error: unknown, nodeId: string | null): ContextFailure | null {
  if (typeof error !== 'object' || error === null || !('contextFit' in error) || !('decisionId' in error)) return null;
  const { contextFit: fit, decisionId } = error as { contextFit?: { reason?: string; status: string; tokens: number; effectiveLimit: number; method: string }; decisionId?: string };
  if (!fit || !decisionId || !nodeId || !Number.isSafeInteger(fit.tokens) || fit.tokens < 0 || !Number.isSafeInteger(fit.effectiveLimit) || fit.effectiveLimit < 0) return null;
  return { decisionId, nodeId, reason: fit.reason ?? fit.status, tokens: fit.tokens, effectiveLimit: fit.effectiveLimit, measurementMethod: fit.method };
}
