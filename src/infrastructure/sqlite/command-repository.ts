import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { decisionRequestSchema, type DecisionValue } from '../../domain/decision/decision.js';
import type { JourneyDefinition } from '../../domain/study/arm.js';
import { resumeRefusalMessage as resumeRefusalMessageFor, type RunStatus } from '../../domain/run/lifecycle.js';
import { runRequestSchema, type PreparedJourneyRun, type PreparedRun } from '../../domain/run/request.js';
import type { DeleteResult, RunCommandRepository } from '../../application/run-store.js';
import { RunStoreError } from '../../application/run-store.js';
import { hashCanonical } from '../identity.js';
import { journeyTopology, journeyTransitionForResponse } from '../../domain/journey/topology.js';
import { asNumber, asText, parseJson, parseJsonRecord, parseStored, type DatabaseRow } from './rows.js';
import { reservePhysicalAttempt } from './commands/reservation.js';
import { chargeReservedAttempt, markAttemptUncertain, settlePollBatch, settleSingleAttempt } from './commands/settlement.js';
import { settleJourneyTurn } from './commands/journey-transition.js';
import { deleteRunSelection, markActiveJourneyRespondentsUnreached, markPendingEvaluationsUnreached, prepareResumedRun, reopenFailedQuestions, reopenJourneyEvaluation, reopenSharedFailure, restoreFailedJourneyRespondent } from './commands/recovery.js';
import { acceptPreparedJourney, acceptPreparedRun } from './commands/acceptance.js';
import { reconcileSelectedRuns } from './commands/reconciliation.js';
import { failOwnedRun, failPreparedLaunch, finishRun, refreshWorkerLease, requestRunCancellation, claimPreparedRun } from './commands/lifecycle.js';
import { PREPARED_LAUNCH_WINDOW_MS, RECONCILE_SELECTION_LIMIT, WORKER_LEASE_DURATION_MS } from './work-policy.js';
import type { SqliteRepositoryContext } from './repository-context.js';
import { validateRunIds } from './run-ids.js';

export function createSqliteCommandRepository(
  context: SqliteRepositoryContext,
  storageInfo: () => { integrity: 'ok' | 'failed' },
): RunCommandRepository {
  function optimizeStorage(): void {
    context.ensureOpen();
    if (storageInfo().integrity !== 'ok') throw new RunStoreError('storage_integrity_failed', 'Sheg will not optimize a datastore whose integrity check failed.');
    try { context.database.exec('PRAGMA optimize'); }
    catch (error) { throw new RunStoreError('storage_operation_failed', 'Sheg could not optimize the datastore.', { cause: error }); }
  }

  function deleteRuns(this: RunCommandRepository, runIds: string[]): DeleteResult {
    context.ensureOpen();
    validateRunIds(runIds);
    return deleteRunSelection({
      database: context.database,
      orm: context.connection.orm,
      transaction: context.transaction,
      now: context.now,
      reconcile: (snapshot, nowMs) => reconcileSelectedRuns(context.connection.orm, snapshot, nowMs),
      notFound: context.notFound,
      optimize: () => this.optimizeStorage(),
    }, runIds);
  }

  return {
    accept(submissionId: string, preparedInput: PreparedRun) {
      context.ensureOpen();
      return acceptPreparedRun(acceptanceContext(context), submissionId, preparedInput);
    },

    acceptJourney(submissionId: string, preparedInput: PreparedJourneyRun) {
      context.ensureOpen();
      return acceptPreparedJourney(acceptanceContext(context), submissionId, preparedInput);
    },

    requestCancel(runId) {
      context.ensureOpen();
      return context.transaction(() => {
        const row = context.database.prepare('SELECT status FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined;
        if (!row) throw context.notFound();
        requestRunCancellation(context.connection.orm, runId, asText(row.status, 'run status'));
        return context.statusInside(runId);
      });
    },

    resume(runId, nowMs) {
      context.ensureOpen();
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RunStoreError('invalid_time', 'Resume time must be a nonnegative safe integer.');
      return context.transaction(() => {
        context.reconcileInside(runId, nowMs);
        const statusView = context.statusInside(runId);
        if (statusView.status === 'prepared') return { started: false, run: statusView };
        const resume = statusView.lifecycle.resume;
        if (!resume.eligible) {
          throw new RunStoreError('run_not_resumable', resumeRefusalMessageFor(resume.reason));
        }
        const run = context.database.prepare('SELECT status, failure_scope, reserved_calls, cancel_requested, used_calls, max_calls, request_json FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined;
        if (!run) throw context.notFound();
        const status = asText(run.status, 'run status');
        const storedRequest = parseJsonRecord(run.request_json, 'run request');
        const parsedRequest = runRequestSchema.safeParse(storedRequest.request);
        if (!parsedRequest.success) throw new RunStoreError('data_integrity_error', 'Stored run request is invalid.');
        const isJourney = parsedRequest.data.kind === 'journey';

        const failed = context.database.prepare("SELECT COUNT(*) AS count FROM evaluations WHERE run_id = ? AND status = 'failed'").get(runId) as DatabaseRow;
        const journeyFailures = status === 'partial' && isJourney && statusView.lifecycle.resume.eligible
          ? context.database.prepare(`SELECT e.evaluation_id, e.respondent_id, e.turn_id, e.node_id, e.context_id
            FROM evaluations e JOIN journey_respondents jr ON jr.run_id = e.run_id AND jr.respondent_id = e.respondent_id
            WHERE e.run_id = ? AND e.status = 'failed' AND jr.status = 'failed' ORDER BY e.ordinal`).all(runId) as DatabaseRow[]
          : [];
        const runFailure = context.database.prepare("SELECT attempt_id, evaluation_id FROM attempts WHERE run_id = ? AND status = 'failed' AND failure_scope = 'run' ORDER BY attempt_sequence DESC LIMIT 1").get(runId) as DatabaseRow | undefined;
        const failedRunEvaluationId = runFailure ? asText(runFailure.evaluation_id, 'failed evaluation ID') : undefined;
        const failedEvaluation = failedRunEvaluationId
          ? context.database.prepare("SELECT status FROM evaluations WHERE run_id = ? AND evaluation_id = ?").get(runId, failedRunEvaluationId) as DatabaseRow | undefined
          : undefined;
        const canRetrySharedFailure = status === 'failed' && asText(run.failure_scope, 'failure scope') === 'run' &&
          failedEvaluation !== undefined && asText(failedEvaluation.status, 'evaluation status') === 'failed';
        const canRetryQuestionFailures = status === 'partial' && asNumber(failed.count, 'failed evaluation count') > 0 && !isJourney;
        if (canRetrySharedFailure && runFailure) reopenSharedFailure(context.connection.orm, runId, asText(runFailure.attempt_id, 'failed attempt ID'));
        if (canRetryQuestionFailures) reopenFailedQuestions(context.connection.orm, runId);
        for (const checkpoint of journeyFailures) {
          const evaluationId = asText(checkpoint.evaluation_id, 'failed evaluation ID');
          const respondentId = asText(checkpoint.respondent_id, 'failed respondent ID');
          const reopened = reopenJourneyEvaluation(context.connection.orm, runId, evaluationId, respondentId);
          const restored = restoreFailedJourneyRespondent(context.connection.orm, runId, respondentId,
            asText(checkpoint.node_id, 'failed turn node ID'), asText(checkpoint.turn_id, 'failed turn ID'),
            asText(checkpoint.context_id, 'failed turn context ID'));
          if (!reopened || !restored) throw new RunStoreError('data_integrity_error', 'The saved failed journey checkpoint changed during resume.');
        }
        prepareResumedRun(context.connection.orm, runId, nowMs + PREPARED_LAUNCH_WINDOW_MS);
        return { started: true, run: context.statusInside(runId) };
      });
    },

    deleteRuns,
    optimizeStorage,

    claim(runId, nowMs, workerPid) {
      context.ensureOpen();
      if (!Number.isSafeInteger(workerPid) || workerPid < 1) throw new RunStoreError('invalid_worker_pid', 'Worker PID must be a positive integer.');
      return context.transaction(() => {
        const row = context.database.prepare('SELECT status, created_ms, cancel_requested, lease_expires_ms FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined;
        if (!row) throw context.notFound();
        const launchDeadline = row.lease_expires_ms === null ? asNumber(row.created_ms, 'created time') + PREPARED_LAUNCH_WINDOW_MS : asNumber(row.lease_expires_ms, 'launch deadline');
        if (asText(row.status, 'run status') !== 'prepared' || asNumber(row.cancel_requested, 'cancel flag') === 1 || nowMs >= launchDeadline) return null;
        const ownerToken = randomUUID();
        if (!claimPreparedRun(context.connection.orm, runId, ownerToken, workerPid, nowMs + WORKER_LEASE_DURATION_MS)) return null;
        return { runId, ownerToken };
      });
    },

    heartbeat(claim, nowMs) {
      context.ensureOpen();
      return context.transaction(() => refreshWorkerLease(context.connection.orm, claim, nowMs, WORKER_LEASE_DURATION_MS));
    },

    reserveNext(claim, nowMs) {
      context.ensureOpen();
      return context.transaction(() => {
        const run = context.ownedRun(claim, nowMs);
        if (asNumber(run.cancel_requested, 'cancel flag') === 1 || asNumber(run.reserved_calls, 'reserved calls') !== 0 ||
            asNumber(run.used_calls, 'used calls') + asNumber(run.reserved_calls, 'reserved calls') >= asNumber(run.max_calls, 'maximum calls')) return null;
        const row = context.database.prepare("SELECT * FROM evaluations WHERE run_id = ? AND status = 'pending' ORDER BY ordinal LIMIT 1").get(claim.runId) as DatabaseRow | undefined;
        if (!row) return null;
        const attemptId = randomUUID();
        const evaluationId = asText(row.evaluation_id, 'evaluation ID');
        reservePhysicalAttempt(context.connection.orm, {
          attemptId, runId: claim.runId, groupId: asText(row.group_id, 'group ID'), anchorEvaluationId: evaluationId,
          packetFingerprint: asText(row.packet_fingerprint, 'packet fingerprint'), ownerToken: claim.ownerToken,
          startedMs: nowMs, evaluationIds: [evaluationId],
        });
        return { attemptId, evaluation: context.evaluationFromRow(row) };
      });
    },

    reserveBatch(claim, groupId, evaluationIds, nowMs) {
      context.ensureOpen();
      return context.transaction(() => {
        const run = context.ownedRun(claim, nowMs);
        if (!evaluationIds.length || new Set(evaluationIds).size !== evaluationIds.length || asNumber(run.cancel_requested, 'cancel flag') === 1 ||
            asNumber(run.reserved_calls, 'reserved calls') !== 0 || asNumber(run.used_calls, 'used calls') >= asNumber(run.max_calls, 'maximum calls')) return null;
        const group = context.database.prepare('SELECT * FROM question_groups WHERE run_id = ? AND group_id = ?').get(claim.runId, groupId) as DatabaseRow | undefined;
        if (!group) throw new RunStoreError('question_group_not_found', 'The requested question group was not found in this run.');
        const orderedIds = parseStored(z.array(z.string().min(1)), parseJson(group.question_ids_json, 'group question IDs'), 'group question IDs');
        const rows = context.database.prepare("SELECT * FROM evaluations WHERE run_id = ? AND group_id = ? AND status = 'pending'").all(claim.runId, groupId) as DatabaseRow[];
        const byId = new Map(rows.map((row) => [asText(row.evaluation_id, 'evaluation ID'), row]));
        const selected = evaluationIds.map((id) => byId.get(id));
        if (selected.some((row) => !row) || selected.some((row) => !orderedIds.includes(asText(row!.question_id, 'question ID')))) {
          throw new RunStoreError('invalid_batch_reservation', 'A batch may reserve only pending evaluations from the requested group.');
        }
        const sorted = [...selected as DatabaseRow[]].sort((left, right) => orderedIds.indexOf(asText(left.question_id, 'question ID')) - orderedIds.indexOf(asText(right.question_id, 'question ID')));
        const attemptId = randomUUID();
        const anchorId = asText(sorted[0]!.evaluation_id, 'evaluation ID');
        const state = parseJson(group.state_json, 'group state');
        const packetQuestions = sorted.map((row) => decisionRequestSchema.parse(parseJson(row.packet_json, 'frozen packet')).question);
        const packetFingerprint = hashCanonical({ state, questions: packetQuestions });
        reservePhysicalAttempt(context.connection.orm, {
          attemptId, runId: claim.runId, groupId, anchorEvaluationId: anchorId, packetFingerprint,
          ownerToken: claim.ownerToken, startedMs: nowMs,
          evaluationIds: sorted.map((row) => asText(row.evaluation_id, 'evaluation ID')),
        });
        return { attemptId, evaluations: sorted.map((row) => context.evaluationFromRow(row)) };
      });
    },

    settleBatch(claim, attemptId, outcome) {
      context.ensureOpen();
      return context.transaction(() => settlePollBatch({ database: context.database, orm: context.connection.orm, now: context.now, ownedRun: context.ownedRun }, claim, attemptId, outcome));
    },

    settle(claim, attemptId, outcome) {
      context.ensureOpen();
      context.transaction(() => settleSingleAttempt({ database: context.database, orm: context.connection.orm, now: context.now, ownedRun: context.ownedRun }, claim, attemptId, outcome));
    },

    settleJourney(claim, attemptId, outcome, transition) {
      context.ensureOpen();
      context.transaction(() => settleJourneyTurn({
        database: context.database,
        orm: context.connection.orm,
        now: context.now,
        ownedRun: context.ownedRun,
        sameDecisionValue,
        journeyRouteTarget,
        isJourneyAskNode,
      }, claim, attemptId, outcome, transition));
    },

    finish(claim) {
      context.ensureOpen();
      return context.transaction(() => {
        const run = context.ownedRun(claim, context.now());
        if (asNumber(run.reserved_calls, 'reserved calls') !== 0) {
          throw new RunStoreError('attempt_in_flight', 'A run cannot finish while a provider attempt is still reserved.');
        }
        const atCallCeiling = asNumber(run.used_calls, 'used calls') >= asNumber(run.max_calls, 'maximum calls');
        if (atCallCeiling && asNumber(run.cancel_requested, 'cancel flag') === 0 && run.failure_scope !== 'run') {
          const hasJourney = context.database.prepare('SELECT 1 FROM journey_respondents WHERE run_id = ? LIMIT 1').get(claim.runId) as DatabaseRow | undefined;
          if (hasJourney) {
            markPendingEvaluationsUnreached(context.connection.orm, claim.runId);
            markActiveJourneyRespondentsUnreached(context.connection.orm, claim.runId);
          }
        }
        let status: RunStatus;
        if (run.failure_scope === 'run') status = 'failed';
        else if (asNumber(run.cancel_requested, 'cancel flag') === 1) status = 'cancelled';
        else {
          const counts = context.database.prepare(`SELECT
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'unreached' THEN 1 ELSE 0 END) AS unreached
            FROM evaluations WHERE run_id = ?`).get(claim.runId) as DatabaseRow;
          status = asNumber(counts.pending, 'pending count') === 0 && asNumber(counts.failed, 'failed count') === 0 && asNumber(counts.unreached, 'unreached count') === 0 ? 'completed' : 'partial';
        }
        finishRun(context.connection.orm, claim.runId, status);
        return context.statusInside(claim.runId);
      });
    },

    failLaunch(runId, code) {
      context.ensureOpen();
      context.transaction(() => {
        if (!failPreparedLaunch(context.connection.orm, runId, code)) context.statusInside(runId);
      });
    },

    failRun(claim, code, message) {
      context.ensureOpen();
      context.transaction(() => {
        context.ownedRun(claim, context.now());
        const reserved = context.database.prepare("SELECT attempt_id FROM attempts WHERE run_id = ? AND owner_token = ? AND status = 'reserved'").get(claim.runId, claim.ownerToken) as DatabaseRow | undefined;
        if (reserved) {
          markAttemptUncertain(context.connection.orm, asText(reserved.attempt_id, 'attempt ID'), context.now(), 'The provider outcome could not be confirmed');
          if (!chargeReservedAttempt(context.connection.orm, claim.runId, 1)) throw new RunStoreError('data_integrity_error', 'The run has no reserved physical call to account for.');
        }
        if (!failOwnedRun(context.connection.orm, claim.runId, claim.ownerToken, code, message)) {
          throw new RunStoreError('worker_ownership_lost', 'This worker no longer owns the run.');
        }
      });
    },

    reconcile(runId, nowMs) {
      context.ensureOpen();
      return context.transaction(() => {
        context.reconcileInside(runId, nowMs);
        return context.statusInside(runId);
      });
    },

    reconcileMany(runIds, nowMs) {
      context.ensureOpen();
      const uniqueRunIds = [...new Set(runIds)];
      context.transaction(() => {
        for (const runId of uniqueRunIds) context.reconcileInside(runId, nowMs);
      });
    },

    reconcileActive(nowMs) {
      context.ensureOpen();
      context.transaction(() => {
        while (true) {
          const active = context.database.prepare(`SELECT run_id FROM runs WHERE
            (status = 'prepared' AND COALESCE(lease_expires_ms, created_ms + ?) <= ?) OR
            (status = 'running' AND lease_expires_ms <= ?)
            ORDER BY COALESCE(lease_expires_ms, created_ms), run_id LIMIT ?`)
            .all(PREPARED_LAUNCH_WINDOW_MS, nowMs, nowMs, RECONCILE_SELECTION_LIMIT) as DatabaseRow[];
          if (!active.length) break;
          for (const row of active) context.reconcileInside(asText(row.run_id, 'run ID'), nowMs);
        }
      });
    },
  };
}

function acceptanceContext(context: SqliteRepositoryContext) {
  return {
    database: context.database,
    orm: context.connection.orm,
    now: context.now,
    transaction: context.transaction,
    statusInside: context.statusInside,
    reconcileInside: context.reconcileInside,
    notFound: context.notFound,
  };
}

function sameDecisionValue(left: DecisionValue, right: DecisionValue): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'choice' && right.type === 'choice') return left.choice === right.choice && hashCanonical(left.probabilities ?? null) === hashCanonical(right.probabilities ?? null) && left.confidence === right.confidence;
  if (left.type === 'score' && right.type === 'score') return left.score === right.score && hashCanonical(left.probabilities) === hashCanonical(right.probabilities) && hashCanonical(left.legend) === hashCanonical(right.legend) && left.confidence === right.confidence;
  return left.type === 'noul' && right.type === 'noul' && left.noul === right.noul;
}

function isJourneyAskNode(journey: JourneyDefinition, nodeId: string, questionId: string): boolean {
  const node = journeyTopology(journey).nodes.find((candidate) => candidate.id === nodeId);
  return node?.kind === 'ask' && node.taskId === questionId;
}

function journeyRouteTarget(journey: JourneyDefinition, nodeId: string, response: DecisionValue): string | undefined {
  return journeyTransitionForResponse(journeyTopology(journey), nodeId, response)?.toNodeId;
}
