import type { DecisionRequest, DecisionResult } from './decision.js';

export type ProviderKind = 'jev' | 'laya';

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
}
