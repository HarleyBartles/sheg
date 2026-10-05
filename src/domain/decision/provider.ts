import { z } from 'zod';
import type { DecisionBatchRequest, DecisionBatchResult, DecisionRequest, DecisionResult } from './decision.js';

export const providerKinds = ['jev', 'laya'] as const;
export const providerKindSchema = z.enum(providerKinds);
export type ProviderKind = z.infer<typeof providerKindSchema>;
export const providerContextFitStatuses = ['fits', 'overflow', 'unavailable'] as const;
export const providerContextFitStatusSchema = z.enum(providerContextFitStatuses);
export const providerTokenCountKinds = ['measured', 'estimated'] as const;
export const providerTokenCountKindSchema = z.enum(providerTokenCountKinds);

export type ProviderContextFit = {
  provider: ProviderKind;
  status: 'fits' | 'overflow' | 'unavailable';
  method: string;
  modelIdentity: string;
  tokenCount: 'measured' | 'estimated';
  tokens: number;
  contextLimit: number | null;
  headroomTokens: number | null;
  effectiveLimit: number | null;
  details: Record<string, number | string>;
  reason?: string;
};

export interface DecisionProvider {
  measure?(request: DecisionRequest): ProviderContextFit | Promise<ProviderContextFit>;
  decide(request: DecisionRequest, maxAttempts: number): Promise<DecisionResult>;
  measureBatch?(request: DecisionBatchRequest): ProviderContextFit | Promise<ProviderContextFit>;
  decideBatch?(request: DecisionBatchRequest, maxAttempts: number): Promise<DecisionBatchResult>;
}
