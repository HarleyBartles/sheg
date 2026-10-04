import { setInterval, clearInterval } from 'node:timers';
import { randomUUID } from 'node:crypto';
import type { RunStore } from '../infrastructure/run-store.js';
import { hashCanonical } from '../infrastructure/identity.js';
import { advanceJourney, normalizeResponse } from '../domain/journey/run.js';
import type { JourneyRespondentState } from '../domain/run/lifecycle.js';
import { ProviderCallError } from '../domain/decision/provider-failure.js';
import type { EvaluationFailure } from '../domain/run/lifecycle.js';
import type { ProviderFactory } from './run-service.js';
import { decisionValueFromResult } from '../domain/decision/decision.js';
import type { DecisionBatchRequest, DecisionBatchResult } from '../domain/decision/decision.js';

const HEARTBEAT_MS = 2_000;
export async function executeQuestionRun(store: RunStore, runId: string, providerFactory: ProviderFactory): Promise<void> {
  const claim = store.claim(runId, Date.now(), process.pid);
  if (!claim) return;
  const heartbeat = setInterval(() => {
    try {
      if (!store.heartbeat(claim, Date.now())) clearInterval(heartbeat);
    } catch { clearInterval(heartbeat); }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    if (store.getRequestKind(runId) === 'journey') {
      await executeJourney(store, runId, claim, providerFactory);
    } else {
      await executePoll(store, runId, claim, providerFactory);
    }
    store.finish(claim);
  } catch {
    try { store.failRun(claim, 'worker_failed', 'The run worker stopped unexpectedly.'); } catch { /* Expired ownership is reconciled by a later read. */ }
  } finally {
    clearInterval(heartbeat);
  }
}

async function executePoll(store: RunStore, runId: string, claim: import('../domain/run/lifecycle.js').WorkerClaim, providerFactory: ProviderFactory): Promise<void> {
  const prepared = store.getRequest(runId);
  const provider = providerFactory(prepared.request.provider);
  const answers = new Map(store.evaluationStatuses(runId).map((answer) => [answer.evaluationId, answer.status]));
  for (const group of prepared.groups ?? []) {
    const evaluations = prepared.evaluations.filter((evaluation) => evaluation.groupId === group.groupId);
    while (true) {
      if (!store.heartbeat(claim, Date.now())) return;
      const pending = evaluations.filter((evaluation) => answers.get(evaluation.evaluationId) === 'pending');
      if (!pending.length) break;
      let batchEvaluations = [pending[0]!];
      if (provider.decideBatch && provider.measureBatch) {
        let selected: typeof pending = [];
        for (let size = pending.length; size >= 1; size -= 1) {
          const candidate = pending.slice(0, size);
          const fit = await provider.measureBatch({ state: group.state, questions: candidate.map(({ packet }) => packet.question) });
          if (fit.status === 'fits') { selected = candidate; break; }
          if (fit.status === 'unavailable') throw new Error('Provider could not confirm fit for the remaining question group.');
        }
        if (!selected.length) throw new Error('The remaining question does not fit the provider context.');
        batchEvaluations = selected;
      }
      const reservation = store.reserveBatch(claim, group.groupId, batchEvaluations.map(({ evaluationId }) => evaluationId), Date.now());
      if (!reservation) break;
      const batch: DecisionBatchRequest = { state: group.state, questions: reservation.evaluations.map(({ packet }) => packet.question) };
      try {
        let result: DecisionBatchResult;
        if (provider.decideBatch) result = await provider.decideBatch(batch, 1);
        else {
          const single = await provider.decide(reservation.evaluations[0]!.packet, 1);
          result = { answers: [{ questionId: reservation.evaluations[0]!.questionId, value: decisionValueFromResult(single) }], execution: {
            attempts: single.attempts, provider: single.provider, model: single.model,
            ...(single.checkpoint ? { checkpoint: single.checkpoint } : {}), latencyMs: single.latencyMs, usage: single.usage,
            ...(single.cost ? { cost: single.cost } : {}),
          } };
        }
        store.settleBatch(claim, reservation.attemptId, { kind: 'answered', result });
      } catch (error) {
        const scope = failureScope(error);
        store.settleBatch(claim, reservation.attemptId, { kind: 'failed', ...failureDetails(error, scope), scope });
        if (scope === 'run') return;
      }
      for (const evaluation of batchEvaluations) answers.set(evaluation.evaluationId, 'answered');
      const latest = new Map(store.evaluationStatuses(runId).map((answer) => [answer.evaluationId, answer.status]));
      for (const evaluation of evaluations) answers.set(evaluation.evaluationId, latest.get(evaluation.evaluationId) ?? answers.get(evaluation.evaluationId)!);
    }
  }
}

async function executeJourney(store: RunStore, runId: string, claim: import('../domain/run/lifecycle.js').WorkerClaim, providerFactory: ProviderFactory): Promise<void> {
  const accepted = store.getJourneyRun(runId);
  const provider = providerFactory(accepted.request.provider);
  while (true) {
    if (!store.heartbeat(claim, Date.now())) return;
    const reservation = store.reserveNext(claim, Date.now());
    if (!reservation) break;
    const currentRun = store.getJourneyRun(runId);
    const currentEvaluation = currentRun.evaluations.find(({ evaluationId }) => evaluationId === reservation.evaluation.evaluationId);
    const respondentState = currentRun.respondents.find(({ respondentId }) => respondentId === reservation.evaluation.respondentId);
    const profile = currentRun.request.respondents.find(({ id }) => id === reservation.evaluation.respondentId);
    if (!currentEvaluation || !respondentState || !profile || respondentState.status !== 'active' || respondentState.currentTurnId !== currentEvaluation.turnId) {
      throw new Error('Reserved journey turn has no matching active respondent state.');
    }
    try {
      const result = await provider.decide(reservation.evaluation.packet, 1);
      const value = normalizeResponse(result, reservation.evaluation.packet.question.type);
      const progress = advanceJourney(currentRun.request.journey, profile, {
        currentNodeId: currentEvaluation.nodeId, events: respondentState.events, route: respondentState.route,
      }, value, currentRun.compilerFingerprint);
      const nextEvaluation = progress.next ? {
        evaluationId: randomUUID(), turnId: randomUUID(), contextId: randomUUID(),
        respondentId: respondentState.respondentId, questionId: progress.next.taskId, nodeId: progress.next.nodeId,
        pathId: progress.next.pathId,
        occurrence: currentRun.evaluations.filter(({ respondentId, nodeId }) => respondentId === respondentState.respondentId && nodeId === progress.next!.nodeId).length + 1,
        ordinal: currentRun.evaluations.length, packet: progress.next.packet,
        packetFingerprint: hashCanonical({ packet: progress.next.packet, compilerFingerprint: currentRun.compilerFingerprint }),
      } : undefined;
      const state: JourneyRespondentState = {
        ...respondentState,
        status: progress.status,
        currentNodeId: nextEvaluation?.nodeId ?? null,
        currentTurnId: nextEvaluation?.turnId ?? null,
        currentContextId: nextEvaluation?.contextId ?? null,
        revision: respondentState.revision + 1,
        events: progress.events,
        route: progress.route,
        ...(progress.outcome === null ? {} : { outcome: progress.outcome }),
      };
      store.settleJourney(claim, reservation.attemptId, { kind: 'answered', result }, {
        respondentId: respondentState.respondentId, expectedRevision: respondentState.revision, state, ...(nextEvaluation ? { nextEvaluation } : {}),
      });
    } catch (error) {
      const scope = failureScope(error);
      const state: JourneyRespondentState = {
        ...respondentState,
        status: scope === 'run' ? 'active' : 'failed',
        currentNodeId: scope === 'run' ? currentEvaluation.nodeId : null,
        currentTurnId: scope === 'run' ? currentEvaluation.turnId : null,
        currentContextId: scope === 'run' ? currentEvaluation.contextId : null,
        revision: respondentState.revision + 1,
      };
      store.settleJourney(claim, reservation.attemptId, { kind: 'failed', ...failureDetails(error, scope), scope }, {
        respondentId: respondentState.respondentId, expectedRevision: respondentState.revision, state,
      });
      if (scope === 'run') break;
    }
  }
}

function failureScope(error: unknown): 'evaluation' | 'run' {
  return error instanceof ProviderCallError ? error.failureScope : 'evaluation';
}

function failureDetails(error: unknown, scope: 'evaluation' | 'run'): EvaluationFailure & { providerAttempts?: number } {
  if (!(error instanceof ProviderCallError)) return { code: scope === 'run' ? 'provider_unavailable' : 'decision_failed', message: 'The respondent evaluation did not produce a valid answer.' };
  const evidence = { providerAttempts: error.attempts, providerFailure: error.evidence };
  if (error.validationFailure) return { ...error.validationFailure, ...evidence };
  if (error.contextFit) return { code: error.contextFit.status === 'overflow' ? 'provider_context_overflow' : 'provider_context_unavailable', message: error.contextFit.status === 'overflow' ? 'The decision packet exceeds the provider context allowance.' : 'Provider context fit could not be verified.', ...evidence };
  const code = scope === 'run' ? error.failureCode : `provider_${error.evidence.category}_failed`;
  return { code, message: scope === 'run' ? 'Provider authentication or service access failed.' : 'The provider could not complete this evaluation.', ...evidence };
}
