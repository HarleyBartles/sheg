import { z } from 'zod';
import { decisionRequestSchema, type DecisionFailureDetail, type DecisionRequest, type DecisionResult } from '../domain/decision/decision.js';
import type { DecisionProvider, ProviderContextFit } from '../domain/decision/provider.js';
import { DecisionError, decisionValidationFailure, validateDecision } from '../domain/decision/validate.js';
import { measureLayaContext } from './laya/context-fit.js';
export { measureLayaContext } from './laya/context-fit.js';

export type LayaConfig = {
  kind: 'laya';
  baseUrl: string;
  checkpoint: string;
  contextLimit: number;
  headLimit: number;
  tokenizerJsonPath: string;
  tokenizerSha256: string;
  precision?: string;
  timeoutMs: number;
};

export type FitMeasurer = (request: DecisionRequest, config: LayaConfig) => Promise<ProviderContextFit>;
export type FitResult = ProviderContextFit;
const MAX_LAYA_SCORE_LEVELS = 32;

export class LayaCallError extends Error {
  constructor(message: string, readonly attempts: number, readonly contextFit?: ProviderContextFit, readonly decisionId?: string, readonly failureScope: 'evaluation' | 'run' = 'evaluation', readonly validationFailure?: { code: string; message: string; detail: DecisionFailureDetail }) {
    super(message);
    this.name = 'LayaCallError';
  }
}

const choiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string().min(1),
  probabilities: z.record(z.string(), z.number().finite().min(0).max(1)),
  confidence: z.number().finite().min(0).max(1).optional(),
}).passthrough();
const scoreAnswerSchema = z.object({ type: z.literal('score'), score: z.number().finite(), legend: z.record(z.string(), z.string()), probabilities: z.record(z.string(), z.number().finite().min(0).max(1)), confidence: z.number().finite().min(0).max(1).optional() }).passthrough();
const noulAnswerSchema = z.object({ type: z.literal('noul'), noul: z.number().finite().min(0).max(1) }).passthrough();
const answerSchema = z.discriminatedUnion('type', [choiceAnswerSchema, scoreAnswerSchema, noulAnswerSchema]);

function wireQuestion(question: DecisionRequest['question']): Record<string, unknown> {
  const criteria = question.type === 'choice' ? question.options : question.type === 'score' ? question.rubric : question.criteria;
  return { type: question.type, instructions: question.instructions, ...(criteria === undefined ? {} : { criteria }) };
}

const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
  }).passthrough(),
  routing: z.object({ model: z.string().min(1) }).passthrough(),
}).passthrough();

export type LayaProviderOptions = {
  fetchRequest?: typeof fetch;
  measureFit?: FitMeasurer;
};

export async function checkLayaFit(
  request: DecisionRequest,
  config: LayaConfig,
  measureFit?: FitMeasurer,
): Promise<FitResult> {
  if (request.question.type === 'score' && request.question.rubric.length > MAX_LAYA_SCORE_LEVELS) {
    return { provider: 'laya', status: 'overflow', method: 'laya-score-rubric-limit/v1', modelIdentity: config.checkpoint, tokenCount: 'measured', tokens: request.question.rubric.length, contextLimit: config.contextLimit, headroomTokens: 0, effectiveLimit: MAX_LAYA_SCORE_LEVELS, details: { scoreRubricLevels: request.question.rubric.length, maximumScoreRubricLevels: MAX_LAYA_SCORE_LEVELS }, reason: `score-rubric-exceeds-${MAX_LAYA_SCORE_LEVELS}-levels` };
  }
  let measurement: ProviderContextFit;
  try {
    measurement = await (measureFit ?? measureLayaContext)(request, config);
  } catch {
    return { provider: 'laya', status: 'unavailable', method: 'laya-context-fit/v1', modelIdentity: config.checkpoint, tokenCount: 'measured', tokens: 0, contextLimit: config.contextLimit, headroomTokens: 0, effectiveLimit: config.contextLimit, details: {}, reason: 'context-unmeasurable' };
  }
  if (measurement.provider !== 'laya' || measurement.modelIdentity !== config.checkpoint || measurement.contextLimit !== config.contextLimit ||
      measurement.details.tokenizerSha256 !== config.tokenizerSha256.toLowerCase()) {
    return { ...measurement, status: 'unavailable', reason: 'checkpoint-or-tokenizer-mismatch' };
  }
  return measurement;
}

export class LayaProvider implements DecisionProvider {
  private readonly fetchRequest: typeof fetch;

  constructor(private readonly config: LayaConfig, private readonly options: LayaProviderOptions = {}) {
    if (config.kind !== 'laya' || !config.baseUrl || !config.checkpoint || !config.tokenizerJsonPath || !/^[a-f\d]{64}$/i.test(config.tokenizerSha256) ||
        !Number.isInteger(config.contextLimit) || config.contextLimit < 1 ||
        !Number.isInteger(config.headLimit) || config.headLimit < 1 ||
        !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 ||
        (config.precision !== undefined && !config.precision)) {
      throw new TypeError('Laya configuration requires a base URL, checkpoint, positive context limit, and positive timeout.');
    }
    this.fetchRequest = options.fetchRequest ?? fetch;
  }

  async measure(request: DecisionRequest): Promise<ProviderContextFit> {
    return checkLayaFit(request, this.config, this.options.measureFit);
  }

  async decide(request: DecisionRequest, maxAttempts: number): Promise<DecisionResult> {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new LayaCallError('Laya call limit must be a positive integer.', 0);
    }
    const parsedRequest = decisionRequestSchema.safeParse(request);
    if (!parsedRequest.success) throw new LayaCallError('Laya decision request is invalid.', 0);
    const fit = await this.measure(parsedRequest.data);
    if (fit.status !== 'fits') {
      throw new LayaCallError(`unsupported-input: ${fit.reason ?? fit.status}.`, 0, fit, parsedRequest.data.question.id);
    }

    const { question } = parsedRequest.data;
    const endpoint = new URL('/v1/systemone', ensureTrailingSlash(this.config.baseUrl)).toString();
    const startedAt = performance.now();
    let response: Response;
    try {
      response = await this.fetchRequest(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.checkpoint,
          state: parsedRequest.data.state,
          questions: {
            [question.id]: wireQuestion(question),
          },
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch {
      throw new LayaCallError('Laya local service request failed.', 1);
    }
    if (!response.ok) throw new LayaCallError(`Laya local service returned HTTP ${response.status}.`, 1, undefined, undefined, response.status === 401 || response.status === 403 ? 'run' : 'evaluation');

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LayaCallError('Laya local service returned unreadable JSON.', 1);
    }
    const parsedResponse = responseSchema.safeParse(payload);
    if (!parsedResponse.success) {
      throw new LayaCallError('Laya response is missing model, answer, usage, or checkpoint routing metadata.', 1);
    }
    if (parsedResponse.data.routing.model !== this.config.checkpoint) {
      throw new LayaCallError('Laya routed the request to a checkpoint other than the configured checkpoint.', 1);
    }
    const answer = answerSchema.safeParse(parsedResponse.data.answers[question.id]);
    if (!answer.success) throw new LayaCallError(`Laya returned an invalid ${question.type} answer for ${question.id}.`, 1);

    const result: DecisionResult = {
      ...answer.data,
      attempts: 1,
      provider: 'laya',
      model: parsedResponse.data.model,
      checkpoint: parsedResponse.data.routing.model,
      latencyMs: performance.now() - startedAt,
      usage: {
        ...(parsedResponse.data.usage.input_tokens === undefined ? {} : { inputTokens: parsedResponse.data.usage.input_tokens }),
        ...(parsedResponse.data.usage.output_tokens === undefined ? {} : { outputTokens: parsedResponse.data.usage.output_tokens }),
      },
    };
    try {
      return validateDecision(request, result, { maxAttempts, provider: 'laya', checkpoint: this.config.checkpoint });
    } catch (error) {
      if (error instanceof DecisionError) {
        throw new LayaCallError('Laya response failed decision validation.', 1, undefined, undefined, 'evaluation', decisionValidationFailure(error));
      }
      throw error;
    }
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
