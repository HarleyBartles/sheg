import type { DecisionRequest, DecisionResult } from '../domain/decision/decision.js';
import type { DecisionProvider, ProviderContextFit } from '../domain/decision/provider.js';

export const controlledWorkflowProviderName = 'partial-journey-recovery';

export function isControlledWorkflowTestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'test' && env.SHEG_TEST_PROVIDER === controlledWorkflowProviderName;
}

export function createControlledWorkflowProvider(): DecisionProvider {
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
