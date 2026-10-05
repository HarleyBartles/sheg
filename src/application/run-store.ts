import type { ProviderFailureEvidence } from '../domain/decision/provider-failure.js';
import type { DecisionFailureDetail, DecisionResult, DecisionBatchResult } from '../domain/decision/decision.js';
import type { AnswerRow, AttemptReservation, JourneyEvaluation, JourneyRespondentState, JourneyRunRecord, JourneyWorkerTurn, Page, RunAttempt, RunContextDetail, RunEvidencePage, RunEvidenceQuery, RunStatus, RunStatusView, WorkerClaim } from '../domain/run/lifecycle.js';
import type { FollowOnSourceSet, FrozenEvaluation, ParsedFollowOnRunRequest, PreparedJourneyRun, PreparedRun, RunListQueryInput } from '../domain/run/request.js';

export type AttemptOutcome =
  | { kind: 'answered'; result: DecisionResult }
  | { kind: 'failed'; code: string; message: string; scope: 'evaluation' | 'run'; detail?: DecisionFailureDetail; providerFailure?: ProviderFailureEvidence; providerAttempts?: number };

export type RunListQuery = RunListQueryInput;
export type DeletePreview = { runs: Array<{ runId: string; status: RunStatus; evaluationCount: number; attemptCount: number; blockedByActiveWork: boolean; retainedFollowOnRunIds: string[] }>; blockedByActiveWork: boolean };
export type DeleteResult = {
  deletedRunIds: string[];
  removed: { runs: number; evaluations: number; attempts: number };
  maintenance: { optimization: 'completed' } | { optimization: 'failed'; failureCode: string };
};
export type StorageInfo = { integrity: 'ok' | 'failed'; databaseBytes: number; runCount: number; evaluationCount: number; attemptCount: number; activeRunCount: number };
export type JourneyTransition = { respondentId: string; expectedRevision: number; state: JourneyRespondentState; nextEvaluation?: JourneyEvaluation };

export class RunStoreError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RunStoreError';
  }
}

export interface RunReadRepository {
  findSubmission(submissionId: string, requestFingerprint: string): RunStatusView | null;
  getStatus(runId: string): RunStatusView;
  evaluationStatuses(runId: string): Array<{ evaluationId: string; status: AnswerRow['status'] }>;
  getRequestKind(runId: string): 'poll' | 'journey' | 'follow-on';
  getRequest(runId: string): PreparedRun;
  getJourneyRun(runId: string): JourneyRunRecord;
  getJourneyWorkerTurn(runId: string, evaluationId: string, respondentId: string): JourneyWorkerTurn;
  list(query: RunListQuery): Page<RunStatusView>;
  queryEvidence(query: RunEvidenceQuery): RunEvidencePage;
  getContext(runId: string, evaluationId: string, contextId: string): RunContextDetail;
  resolveFollowOnSources(request: ParsedFollowOnRunRequest): FollowOnSourceSet;
  answers(runId: string, cursor?: string, limit?: number): Page<AnswerRow>;
  attempts(runId: string, cursor?: string, limit?: number): Page<RunAttempt>;
  previewDelete(runIds: string[]): DeletePreview;
  storageInfo(): StorageInfo;
  close(): void;
}

export interface RunCommandRepository {
  accept(submissionId: string, prepared: PreparedRun): { created: boolean; run: RunStatusView };
  acceptJourney(submissionId: string, prepared: PreparedJourneyRun): { created: boolean; run: RunStatusView };
  requestCancel(runId: string): RunStatusView;
  resume(runId: string, nowMs: number): { started: boolean; run: RunStatusView };
  deleteRuns(runIds: string[]): DeleteResult;
  optimizeStorage(): void;
  claim(runId: string, nowMs: number, workerPid: number): WorkerClaim | null;
  heartbeat(claim: WorkerClaim, nowMs: number): boolean;
  reserveNext(claim: WorkerClaim, nowMs: number): AttemptReservation | null;
  reserveBatch(claim: WorkerClaim, groupId: string, evaluationIds: string[], nowMs: number): { attemptId: string; evaluations: FrozenEvaluation[] } | null;
  settleBatch(claim: WorkerClaim, attemptId: string, outcome: { kind: 'answered'; result: DecisionBatchResult } | Extract<AttemptOutcome, { kind: 'failed' }>): void;
  settle(claim: WorkerClaim, attemptId: string, outcome: AttemptOutcome): void;
  settleJourney(claim: WorkerClaim, attemptId: string, outcome: AttemptOutcome, transition: JourneyTransition): void;
  finish(claim: WorkerClaim): RunStatusView;
  failLaunch(runId: string, code: string): void;
  failRun(claim: WorkerClaim, code: string, message: string): void;
  reconcile(runId: string, nowMs: number): RunStatusView;
  reconcileMany(runIds: string[], nowMs: number): void;
  reconcileActive(nowMs: number): void;
}

export interface RunPersistence {
  reads: RunReadRepository;
  commands: RunCommandRepository;
  close(): void;
}

/** Compatibility surface retained only at the infrastructure adapter boundary during the cutover. */
export interface RunStore extends RunReadRepository, RunCommandRepository {}
