import { decisionRequestSchema, decisionResultSchema, type DecisionRequest, type DecisionResult } from './decision.js';
import type { ProviderKind } from './provider.js';

type ValidationOptions = {
  maxAttempts?: number;
  provider?: ProviderKind;
  model?: string;
  checkpoint?: string;
};

export class DecisionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DecisionError';
  }
}

const probabilitySumTolerance = 0.01;

export function validateDecision(
  request: DecisionRequest,
  result: unknown,
  options: ValidationOptions = {},
): DecisionResult {
  const parsedRequest = decisionRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new DecisionError(`Decision request is invalid: ${parsedRequest.error.issues.map((issue) => issue.message).join(' ')}`, { cause: parsedRequest.error });
  }
  const parsed = decisionResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new DecisionError(`Decision result is invalid: ${parsed.error.issues.map((issue) => issue.message).join(' ')}`, { cause: parsed.error });
  }
  const decision = parsed.data;
  const normalizedRequest = parsedRequest.data;
  if (decision.type !== normalizedRequest.question.type) {
    throw new DecisionError(`Decision response type ${decision.type} does not match task type ${normalizedRequest.question.type}.`);
  }
  if (decision.type === 'choice') {
    if (normalizedRequest.question.type !== 'choice') throw new DecisionError('Choice response does not match the task type.');
    const optionIds = Object.keys(normalizedRequest.question.options);
    if (!optionIds.includes(decision.choice)) {
      throw new DecisionError(`Decision choice ${decision.choice} was not offered.`);
    }
    validateDistribution(decision.probabilities, optionIds, 'Choice');
  } else if (decision.type === 'score') {
    if (normalizedRequest.question.type !== 'score') throw new DecisionError('Score response does not match the task type.');
    const rubric = normalizedRequest.question.rubric;
    const levelIds = rubric.map((_level, index) => String(index));
    if (decision.score < 0 || decision.score > rubric.length - 1) {
      throw new DecisionError('Score result is outside the declared rubric range.');
    }
    validateDistribution(decision.probabilities, levelIds, 'Score');
    for (const [index, meaning] of rubric.entries()) {
      if (decision.legend[String(index)] !== meaning) {
        throw new DecisionError(`Score legend does not match rubric level ${index}.`);
      }
    }
  } else if (normalizedRequest.question.type !== 'noul') throw new DecisionError('Noul response does not match the task type.');
  const maxAttempts = options.maxAttempts ?? 1;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || decision.attempts > maxAttempts) {
    throw new DecisionError(`Decision attempts exceed the configured limit of ${maxAttempts}.`);
  }
  for (const key of ['provider', 'model', 'checkpoint'] as const) {
    if (options[key] !== undefined && decision[key] !== options[key]) {
      throw new DecisionError(`Decision ${key} does not match the configured ${key}.`);
    }
  }
  if (decision.chargeStatus === 'billed' && decision.chargeUsd === undefined) {
    throw new DecisionError('Billed decision is missing cost evidence.');
  }
  if (decision.chargeStatus !== 'billed' && decision.chargeUsd !== undefined) {
    throw new DecisionError('Charge amount is present without billed status evidence.');
  }
  return decision;
}

function validateDistribution(distribution: Record<string, number>, expectedIds: readonly string[], label: string): void {
  const ids = Object.keys(distribution);
  if (ids.length !== expectedIds.length || expectedIds.some((id) => !Object.hasOwn(distribution, id))) {
    throw new DecisionError(`${label} probabilities must contain exactly one entry for every declared outcome.`);
  }
  const total = Object.values(distribution).reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > probabilitySumTolerance) {
    throw new DecisionError(`${label} probabilities must sum to 1 within ${probabilitySumTolerance}.`);
  }
}
