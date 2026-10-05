import { z } from 'zod';
import { decisionBatchRequestSchema, decisionBatchResultSchema, decisionFailureDetailForReason, decisionRequestSchema, decisionResultSchema, decisionValueSchema, decisionValueFromResult, providerExecutionEvidenceSchema, type DecisionBatchRequest, type DecisionBatchResult, type DecisionFailureDetail, type DecisionRequest, type DecisionResult } from './decision.js';
import type { ProviderKind } from './provider.js';

type ValidationOptions = {
  maxAttempts?: number;
  provider?: ProviderKind;
  model?: string;
  checkpoint?: string;
};

export class DecisionError extends Error {
  readonly reason: DecisionFailureDetail['reason'];
  constructor(message: string, options?: ErrorOptions & { reason?: DecisionFailureDetail['reason'] }) {
    super(message, options);
    this.name = 'DecisionError';
    this.reason = options?.reason ?? 'invalid_answer';
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
    throw new DecisionError(`Decision result is invalid: ${parsed.error.issues.map((issue) => issue.message).join(' ')}`, { cause: parsed.error, reason: 'malformed_answer' });
  }
  const decision = parsed.data;
  const normalizedRequest = parsedRequest.data;
  if (decision.type !== normalizedRequest.question.type) {
    throw new DecisionError(`Decision response type ${decision.type} does not match task type ${normalizedRequest.question.type}.`, { reason: 'answer_type_mismatch' });
  }
  if (decision.type === 'choice') {
    if (normalizedRequest.question.type !== 'choice') throw new DecisionError('Choice response does not match the task type.', { reason: 'answer_type_mismatch' });
    const optionIds = Object.keys(normalizedRequest.question.options);
    if (!optionIds.includes(decision.choice)) {
      throw new DecisionError(`Decision choice ${decision.choice} was not offered.`, { reason: 'unknown_option' });
    }
    validateDistribution(decision.probabilities, optionIds, 'Choice');
  } else if (decision.type === 'score') {
    if (normalizedRequest.question.type !== 'score') throw new DecisionError('Score response does not match the task type.', { reason: 'answer_type_mismatch' });
    const rubric = normalizedRequest.question.rubric;
    const levelIds = rubric.map((_level, index) => String(index));
    if (decision.score < 0 || decision.score > rubric.length - 1) {
      throw new DecisionError('Score result is outside the declared rubric range.', { reason: 'score_out_of_range' });
    }
    validateDistribution(decision.probabilities, levelIds, 'Score');
    for (const [index, meaning] of rubric.entries()) {
      if (decision.legend[String(index)] !== meaning) {
        throw new DecisionError(`Score legend does not match rubric level ${index}.`, { reason: 'score_legend_mismatch' });
      }
    }
  } else if (normalizedRequest.question.type !== 'noul') throw new DecisionError('Noul response does not match the task type.', { reason: 'answer_type_mismatch' });
  const maxAttempts = options.maxAttempts ?? 1;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || decision.attempts > maxAttempts) {
    throw new DecisionError(`Decision attempts exceed the configured limit of ${maxAttempts}.`);
  }
  for (const key of ['provider', 'model', 'checkpoint'] as const) {
    if (options[key] !== undefined && decision[key] !== options[key]) {
      throw new DecisionError(`Decision ${key} does not match the configured ${key}.`);
    }
  }
  return decision;
}

export function validateDecisionBatch(
  request: DecisionBatchRequest,
  result: unknown,
  options: ValidationOptions = {},
): DecisionBatchResult {
  const parsedRequest = decisionBatchRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new DecisionError(`Decision batch request is invalid: ${parsedRequest.error.issues.map((issue) => issue.message).join(' ')}`, { cause: parsedRequest.error });
  }
  const envelope = batchEnvelopeSchema.safeParse(result);
  if (!envelope.success) {
    throw new DecisionError(`Decision batch response envelope is invalid: ${envelope.error.issues.map((issue) => issue.message).join(' ')}`, { cause: envelope.error });
  }
  const execution = providerExecutionEvidenceSchema.parse(envelope.data.execution);
  for (const answer of envelope.data.answers) {
    if (!parsedRequest.data.questions.some(({ id }) => id === answer.questionId)) {
      throw new DecisionError(`Decision batch response contains unknown question ID ${answer.questionId}.`);
    }
  }

  const answers = parsedRequest.data.questions.map((question) => {
    const matches = envelope.data.answers.filter(({ questionId }) => questionId === question.id);
    if (matches.length > 1) return { questionId: question.id, failure: { code: 'duplicate_answer', message: 'The provider returned this question more than once.' } };
    const answer = matches[0];
    if (!answer) return { questionId: question.id, failure: { code: 'missing_answer', message: 'The provider did not return an answer for this question.' } };
    if (answer.failure) return { questionId: question.id, failure: answer.failure };
    const value = decisionValueSchema.safeParse(answer.value);
    if (!value.success) return { questionId: question.id, failure: { code: 'invalid_answer', message: 'The answer does not match a supported typed-answer shape.', detail: decisionFailureDetailForReason('malformed_answer') } };
    if (value.data.type !== question.type) return { questionId: question.id, failure: { code: 'answer_type_mismatch', message: 'The answer type does not match the question type.', detail: decisionFailureDetailForReason('answer_type_mismatch') } };
    if (question.type === 'choice' && (value.data.type !== 'choice' || !Object.hasOwn(question.options, value.data.choice))) {
      return { questionId: question.id, failure: { code: 'invalid_answer', message: 'The selected option was not offered by this question.', detail: decisionFailureDetailForReason('unknown_option') } };
    }
    try {
      const enriched = { ...value.data, ...execution };
      const checked = validateDecision({ state: parsedRequest.data.state, question, ...(question.type === 'choice' ? { optionIds: Object.keys(question.options) } : {}) } as DecisionRequest, enriched, options);
      return { questionId: question.id, value: decisionValueFromResult(checked) };
    } catch (error) {
      if (!(error instanceof DecisionError)) throw error;
      return { questionId: question.id, failure: decisionValidationFailure(error) };
    }
  });
  return decisionBatchResultSchema.parse({ answers, execution });
}

export function decisionValidationFailure(error: DecisionError): { code: string; message: string; detail: DecisionFailureDetail } {
  return decisionValidationFailureForReason(error.reason);
}

export function decisionValidationFailureForReason(reason: DecisionFailureDetail['reason']): { code: string; message: string; detail: DecisionFailureDetail } {
  const detail = decisionFailureDetailForReason(reason);
  return { code: detail.reason === 'answer_type_mismatch' ? 'answer_type_mismatch' : 'invalid_answer', message: decisionFailureMessage(detail), detail };
}

function decisionFailureMessage(detail: DecisionFailureDetail): string {
  switch (detail.reason) {
    case 'malformed_answer': return 'The answer does not match a supported typed-answer shape.';
    case 'answer_type_mismatch': return 'The answer type does not match the question type.';
    case 'unknown_option': return 'The selected option was not offered by this question.';
    case 'probability_keys': return 'The probability distribution must contain exactly the declared outcomes.';
    case 'probability_sum': return 'The probability distribution must sum to 1 within the accepted tolerance.';
    case 'score_out_of_range': return 'The score falls outside the declared rubric range.';
    case 'score_legend_mismatch': return 'The score legend does not match the declared rubric.';
    case 'invalid_answer': return 'The answer failed a typed-answer validation rule.';
  }
}

const batchEnvelopeSchema = z.object({
  answers: z.array(z.object({
    questionId: z.string().min(1),
    value: z.unknown().optional(),
    failure: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict().optional(),
  }).strict().superRefine((answer, context) => {
    if (('value' in answer) === Boolean(answer.failure)) context.addIssue({ code: 'custom', message: 'Each batch answer must contain exactly one value or failure.' });
  })),
  execution: providerExecutionEvidenceSchema,
}).strict();

function validateDistribution(distribution: Record<string, number>, expectedIds: readonly string[], label: string): void {
  const ids = Object.keys(distribution);
  if (ids.length !== expectedIds.length || expectedIds.some((id) => !Object.hasOwn(distribution, id))) {
    throw new DecisionError(`${label} probabilities must contain exactly one entry for every declared outcome.`, { reason: 'probability_keys' });
  }
  const total = Object.values(distribution).reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > probabilitySumTolerance) {
    throw new DecisionError(`${label} probabilities must sum to 1 within ${probabilitySumTolerance}.`, { reason: 'probability_sum' });
  }
}
