import type { DecisionRequest, DecisionResult } from '../../src/domain/decision/decision.js';
import type { DecisionProvider, ProviderContextFit } from '../../src/domain/decision/provider.js';
import type { ProviderConfigInput } from '../../src/providers/config.js';

export const controlledRecoveryProviderName = 'partial-journey-recovery';

export function assertControlledRecoveryEnvironment(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'test' || env.SHEG_TEST_PROVIDER !== controlledRecoveryProviderName) throw new Error('Controlled recovery MCP requires its explicit isolated test environment.');
}

export function createControlledRecoveryProvider(config: ProviderConfigInput): DecisionProvider {
  if (config.kind !== 'jev' || (config.route ?? 'openrouter') !== 'typesafe' || config.model !== 'jev-latest') throw new Error('Controlled recovery provider only accepts its frozen TypeSafe fixture request.');
  return {
    measure(): ProviderContextFit {
      return { provider: 'jev', status: 'fits', method: 'controlled-workflow-test', modelIdentity: 'controlled/partial-journey-recovery', tokenCount: 'estimated', tokens: 1, contextLimit: 32_000, headroomTokens: 0, effectiveLimit: 32_000, details: {} };
    },
    async decide(request: DecisionRequest): Promise<DecisionResult> {
      if (request.question.type !== 'score' || request.question.id !== 'clarity') throw new Error('Controlled recovery provider received an unexpected turn.');
      const lastIndex = request.question.rubric.length - 1;
      const probabilities = Object.fromEntries(request.question.rubric.map((_, index) => [String(index), index === lastIndex ? 1 : 0]));
      const legend = Object.fromEntries(request.question.rubric.map((value, index) => [String(index), value]));
      return { type: 'score', score: lastIndex, legend, probabilities, attempts: 1, provider: 'jev', model: 'controlled/partial-journey-recovery', latencyMs: 0, usage: {} };
    },
  };
}
