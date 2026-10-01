import type { DecisionResult } from '../decision/decision.js';
import type { ProviderContextFit } from '../decision/provider.js';
import type { FrozenEvaluation } from './request.js';

export type RunStatus = 'prepared' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted';

export type RunProblem = { code: string; respondentId?: string; message: string };

export type Inspection = {
  valid: boolean;
  respondentCount: number;
  minimumCalls: number;
  problems: RunProblem[];
  fits: Array<{ respondentId: string; fit: ProviderContextFit }>;
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
  status: 'pending' | 'answered' | 'failed';
  result?: DecisionResult;
  failure?: { code: string; message: string };
};

export type Page<T> = { items: T[]; nextCursor?: string };

export type WorkerClaim = { runId: string; ownerToken: string };

export type AttemptReservation = { attemptId: string; evaluation: FrozenEvaluation };
