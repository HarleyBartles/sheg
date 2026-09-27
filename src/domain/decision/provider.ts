import type { DecisionRequest, DecisionResult } from './decision.js';

export type ProviderKind = 'jev' | 'laya';

export interface DecisionProvider {
  decide(request: DecisionRequest, maxAttempts: number): Promise<DecisionResult>;
}
