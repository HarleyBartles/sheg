import type { DecisionResult, DecisionValue } from '../decision/decision.js';
import type { ProviderContextFit } from '../decision/provider.js';
import type { EvidenceCriteria, FrozenEvaluation, RunEvidenceItem, RunEvidencePage, RunEvidenceQuery, RunListQueryInput } from './request.js';
import type { PromptHistoryEvent } from '../decision/prompt.js';
import type { PromptState } from '../decision/prompt.js';
import type { DecisionRequest } from '../decision/decision.js';

export type RunStatus = 'prepared' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted';

export type RunProblem = { code: string; respondentId?: string; nodeId?: string; pathId?: string; message: string };

export type JourneyEvaluation = Omit<FrozenEvaluation, 'packet'> & { packet: DecisionRequest & { state: PromptState } } & {
  turnId: string;
  nodeId: string;
  pathId: string;
  occurrence: number;
  ordinal: number;
};

export type JourneyRespondentState = {
  respondentId: string;
  status: 'active' | 'completed' | 'failed' | 'unreached';
  currentNodeId: string | null;
  currentTurnId: string | null;
  currentContextId: string | null;
  revision: number;
  events: PromptHistoryEvent[];
  route: Array<{ nodeId: string; response: DecisionValue; toNodeId: string }>;
  outcome?: string;
};

export type JourneyEvaluationRecord = JourneyEvaluation & {
  status: 'pending' | 'answered' | 'failed' | 'unreached';
  result?: DecisionResult;
  execution?: import('../decision/decision.js').ProviderExecutionEvidence;
  failure?: { code: string; message: string };
};

export type JourneyRunRecord = {
  request: import('./request.js').ParsedInlineJourneyRequest;
  requestFingerprint: string;
  compilerFingerprint: string;
  evaluations: JourneyEvaluationRecord[];
  respondents: JourneyRespondentState[];
};

export type Inspection = {
  valid: boolean;
  respondentCount: number;
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
  failure?: { code: string; message: string };
};

export type AnswerRow = {
  evaluationId: string;
  contextId: string;
  respondentId: string;
  questionId: string;
  status: 'pending' | 'answered' | 'failed' | 'unreached';
  result?: DecisionResult;
  execution?: import('../decision/decision.js').ProviderExecutionEvidence;
  failure?: { code: string; message: string };
};

export type Page<T> = { items: T[]; nextCursor?: string };
export type { EvidenceCriteria, RunEvidenceItem, RunEvidencePage, RunEvidenceQuery, RunListQueryInput };

export type WorkerClaim = { runId: string; ownerToken: string };

export type AttemptReservation = { attemptId: string; evaluation: FrozenEvaluation };
