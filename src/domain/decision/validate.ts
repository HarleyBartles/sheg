import { decisionResultSchema, type DecisionRequest, type DecisionResult, type ValidationOptions } from './contract.js';

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
  const parsed = decisionResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new DecisionError(`Decision result is invalid: ${parsed.error.issues.map((issue) => issue.message).join(' ')}`, { cause: parsed.error });
  }
  const decision = parsed.data;
  const labels = [...request.labels];
  if (labels.length === 0 || new Set(labels).size !== labels.length ||
      labels.length !== Object.keys(request.question.criteria).length ||
      labels.some((label) => !(label in request.question.criteria))) {
    throw new DecisionError('Decision request labels must uniquely match the offered criteria.');
  }
  if (!labels.includes(decision.choice)) {
    throw new DecisionError(`Decision choice ${decision.choice} was not offered.`);
  }
  const probabilityLabels = Object.keys(decision.probabilities);
  if (probabilityLabels.length !== labels.length || labels.some((label) => !(label in decision.probabilities))) {
    throw new DecisionError('Decision probabilities must contain exactly one entry for every offered label.');
  }
  const probabilityTotal = Object.values(decision.probabilities).reduce((sum, value) => sum + value, 0);
  if (Math.abs(probabilityTotal - 1) > probabilitySumTolerance) {
    throw new DecisionError(`Decision probabilities must sum to 1 within ${probabilitySumTolerance}.`);
  }
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
  return {
    choice: decision.choice,
    probabilities: decision.probabilities,
    ...(decision.confidence === undefined ? {} : { confidence: decision.confidence }),
    attempts: decision.attempts,
    provider: decision.provider,
    model: decision.model,
    ...(decision.checkpoint === undefined ? {} : { checkpoint: decision.checkpoint }),
    latencyMs: decision.latencyMs,
    usage: decision.usage,
    chargeStatus: decision.chargeStatus,
    ...(decision.chargeUsd === undefined ? {} : { chargeUsd: decision.chargeUsd }),
  };
}
