import { z } from 'zod';
import type { ProviderFailureEvidence } from '../decision/provider-failure.js';
import { decisionValueSchema, type DecisionFailureDetail, type DecisionResult } from '../decision/decision.js';
import type { ProviderContextFit } from '../decision/provider.js';
import type { EvidenceCriteria, FollowOnSelectionExclusion, FrozenEvaluation, RunEvidenceItem, RunEvidencePage, RunEvidenceQuery, RunListQueryInput, SelectionCoverage } from './request.js';
import { promptHistoryEventSchema, type PromptHistoryEvent } from '../decision/prompt.js';
import type { PromptState } from '../decision/prompt.js';
import type { DecisionRequest } from '../decision/decision.js';
import type { RespondentProfile } from '../respondents/profile.js';

export const runStatuses = ['prepared', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted'] as const;
export const runStatusSchema = z.enum(runStatuses);
export type RunStatus = z.infer<typeof runStatusSchema>;
export const evaluationStatuses = ['pending', 'answered', 'failed', 'unreached'] as const;
export const evaluationStatusSchema = z.enum(evaluationStatuses);
export const journeyRespondentStatuses = ['active', 'completed', 'failed', 'unreached'] as const;
export const journeyRespondentStatusSchema = z.enum(journeyRespondentStatuses);
export const attemptStatuses = ['reserved', 'answered', 'failed', 'uncertain'] as const;
export const attemptStatusSchema = z.enum(attemptStatuses);
export const runLifecycleStates = ['active', 'stopped', 'complete'] as const;
export const runLifecycleStateSchema = z.enum(runLifecycleStates);
export const resumeRefusalReasons = ['already_active', 'already_completed', 'cancelled', 'unsupported_status', 'partial_journey', 'cancellation_requested', 'attempt_unresolved', 'call_allowance_exhausted', 'no_unfinished_work'] as const;
export const resumeRefusalReasonSchema = z.enum(resumeRefusalReasons);

export type ResumeRefusalReason = z.infer<typeof resumeRefusalReasonSchema>;
export type RunLifecycle = {
  state: z.infer<typeof runLifecycleStateSchema>;
  resume: { eligible: true } | { eligible: false; reason: ResumeRefusalReason };
};

export type RunLifecycleFacts = {
  status: RunStatus;
  kind: 'poll' | 'journey' | 'follow-on';
  failureScope?: 'evaluation' | 'run';
  cancelRequested: boolean;
  usedCalls: number;
  reservedCalls: number;
  maxCalls: number;
  hasPendingEvaluations: boolean;
  hasFailedEvaluations: boolean;
  canRetrySharedFailure: boolean;
  hasRetryableJourneyFailure: boolean;
};

export function deriveRunLifecycle(facts: RunLifecycleFacts): RunLifecycle {
  const state: RunLifecycle['state'] = facts.status === 'completed' ? 'complete'
    : facts.status === 'prepared' || facts.status === 'running' ? 'active' : 'stopped';
  const refuse = (reason: ResumeRefusalReason): RunLifecycle => ({ state, resume: { eligible: false, reason } });
  if (facts.status === 'prepared' || facts.status === 'running') return refuse('already_active');
  if (facts.status === 'completed') return refuse('already_completed');
  if (facts.status === 'cancelled') return refuse('cancelled');
  if (facts.status !== 'interrupted' && facts.status !== 'failed' && facts.status !== 'partial') return refuse('unsupported_status');
  if (facts.cancelRequested) return refuse('cancellation_requested');
  if (facts.reservedCalls > 0) return refuse('attempt_unresolved');
  if (facts.usedCalls >= facts.maxCalls) return refuse('call_allowance_exhausted');
  if (facts.status === 'partial' && facts.kind === 'journey' && !facts.hasRetryableJourneyFailure) return refuse('partial_journey');
  const hasResumableWork = facts.status === 'interrupted' && (facts.hasPendingEvaluations || facts.canRetrySharedFailure) ||
    facts.status === 'partial' && (facts.kind === 'journey' ? facts.hasRetryableJourneyFailure : facts.hasFailedEvaluations) ||
    facts.status === 'failed' && facts.failureScope === 'run' && (facts.hasPendingEvaluations || facts.canRetrySharedFailure);
  if (!hasResumableWork) return refuse('no_unfinished_work');
  return { state, resume: { eligible: true } };
}

export function resumeRefusalMessage(reason: ResumeRefusalReason): string {
  switch (reason) {
    case 'already_active': return 'A run that is already active does not need to be resumed.';
    case 'already_completed': return 'A completed run cannot be resumed.';
    case 'cancelled': return 'A cancelled run cannot be resumed.';
    case 'unsupported_status': return 'This run state cannot be resumed.';
    case 'partial_journey': return 'A partial journey run cannot be resumed from this state.';
    case 'cancellation_requested': return 'A run with a cancellation request cannot be resumed.';
    case 'attempt_unresolved': return 'A run with an unresolved provider attempt cannot be resumed.';
    case 'call_allowance_exhausted': return 'This run has no remaining provider-call allowance.';
    case 'no_unfinished_work': return 'This run has no resumable unfinished work.';
  }
}

export type RunProblem = { code: string; respondentId?: string; nodeId?: string; pathId?: string; message: string };
export type EvaluationFailure = { code: string; message: string; detail?: DecisionFailureDetail; providerFailure?: ProviderFailureEvidence };

export type JourneyEvaluation = Omit<FrozenEvaluation, 'packet'> & { packet: DecisionRequest & { state: PromptState } } & {
  turnId: string;
  nodeId: string;
  pathId: string;
  occurrence: number;
  ordinal: number;
};

export const journeyRouteEntrySchema = z.object({
  nodeId: z.string().min(1),
  response: decisionValueSchema,
  toNodeId: z.string().min(1),
}).strict();
export type JourneyRouteEntry = z.infer<typeof journeyRouteEntrySchema>;
export const journeyEventsSchema = z.array(promptHistoryEventSchema);
export const journeyRouteSchema = z.array(journeyRouteEntrySchema);

export type JourneyRespondentState = {
  respondentId: string;
  status: z.infer<typeof journeyRespondentStatusSchema>;
  currentNodeId: string | null;
  currentTurnId: string | null;
  currentContextId: string | null;
  revision: number;
  events: PromptHistoryEvent[];
  route: JourneyRouteEntry[];
  outcome?: string;
};

export type JourneyEvaluationRecord = JourneyEvaluation & {
  status: z.infer<typeof evaluationStatusSchema>;
  result?: DecisionResult;
  execution?: import('../decision/decision.js').ProviderExecutionEvidence;
  failure?: EvaluationFailure;
};

export type JourneyRunRecord = {
  request: import('./request.js').ParsedInlineJourneyRequest;
  requestFingerprint: string;
  compilerFingerprint: string;
  evaluations: JourneyEvaluationRecord[];
  respondents: JourneyRespondentState[];
};

export type JourneyWorkerTurn = {
  evaluation: JourneyEvaluation;
  respondent: JourneyRespondentState;
  profile: RespondentProfile;
  nextOrdinal: number;
};

export type Inspection = {
  valid: boolean;
  respondentCount: number;
  selectionCoverage?: SelectionCoverage;
  selectionExclusions?: FollowOnSelectionExclusion[];
  minimumCalls: number;
  maximumCalls?: number;
  problems: RunProblem[];
  warnings?: RunProblem[];
  fits: Array<{ respondentId: string; groupId?: string; contextId?: string; questionIds?: string[]; nodeId?: string; pathId?: string; packetId?: string; fit: ProviderContextFit }>;
};

export type RunStatusView = {
  runId: string;
  status: RunStatus;
  createdAt: string;
  completedEvaluations: number;
  failedEvaluations: number;
  totalEvaluations: number;
  usedCalls: number;
  reservedCalls: number;
  maxCalls: number;
  cancelRequested: boolean;
  lifecycle: RunLifecycle;
  failure?: EvaluationFailure;
};

export type AnswerRow = {
  evaluationId: string;
  contextId: string;
  respondentId: string;
  questionId: string;
  status: 'pending' | 'answered' | 'failed' | 'unreached';
  result?: DecisionResult;
  execution?: import('../decision/decision.js').ProviderExecutionEvidence;
  failure?: EvaluationFailure;
};

export type RunContextDetail = {
  runId: string;
  evaluationId: string;
  contextId: string;
  respondentId: string;
  questionId: string;
  status: AnswerRow['status'];
  packet: DecisionRequest;
  provenance: { compilerFingerprint: string; packetFingerprint: string; contextFingerprint: string };
};

export type RunAttempt = {
  attemptId: string;
  groupId: string;
  evaluationIds: string[];
  status: z.infer<typeof attemptStatusSchema>;
  startedAt: string;
  settledAt?: string;
  failure?: { code: string; message: string; scope?: 'evaluation' | 'run' };
  evaluationFailures?: Array<{ evaluationId: string; questionId: string; failure: EvaluationFailure }>;
  execution?: import('../decision/decision.js').ProviderExecutionEvidence;
};

export type Page<T> = { items: T[]; nextCursor?: string };
export type { EvidenceCriteria, RunEvidenceItem, RunEvidencePage, RunEvidenceQuery, RunListQueryInput };

export type WorkerClaim = { runId: string; ownerToken: string };

export type AttemptReservation = { attemptId: string; evaluation: FrozenEvaluation };
