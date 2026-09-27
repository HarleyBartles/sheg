import { z } from 'zod';
import { decisionRequestSchema, type DecisionRequest, type DecisionResult } from '../domain/decision/decision.js';
import type { DecisionProvider } from '../domain/decision/provider.js';
import { DecisionError, validateDecision } from '../domain/decision/validate.js';

export type LayaConfig = {
  kind: 'laya';
  baseUrl: string;
  checkpoint: string;
  contextLimit: number;
  precision?: string;
  timeoutMs: number;
};

export type FitMeasurement = { checkpoint: string; tokens: number; limit: number };
export type FitMeasurer = (request: DecisionRequest, config: LayaConfig) => Promise<FitMeasurement>;
export type FitResult =
  | { status: 'fits'; tokens: number; limit: number }
  | { status: 'unsupported-input'; reason: 'context-unmeasurable' | 'checkpoint-mismatch' }
  | { status: 'unsupported-input'; reason: 'context-over-limit'; tokens: number; limit: number };

export class LayaCallError extends Error {
  constructor(message: string, readonly attempts: number, readonly chargeStatus: 'not_billed' | 'unknown') {
    super(message);
    this.name = 'LayaCallError';
  }
}

const answerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string().min(1),
  probabilities: z.record(z.string(), z.number().finite().min(0).max(1)),
  confidence: z.number().finite().min(0).max(1).optional(),
}).passthrough();

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
  if (!measureFit) return { status: 'unsupported-input', reason: 'context-unmeasurable' };
  let measurement: FitMeasurement;
  try {
    measurement = await measureFit(request, config);
  } catch {
    return { status: 'unsupported-input', reason: 'context-unmeasurable' };
  }
  if (measurement.checkpoint !== config.checkpoint || measurement.limit !== config.contextLimit ||
      !Number.isInteger(measurement.tokens) || measurement.tokens < 0 ||
      !Number.isInteger(measurement.limit) || measurement.limit < 1) {
    return { status: 'unsupported-input', reason: 'checkpoint-mismatch' };
  }
  if (measurement.tokens > measurement.limit) {
    return { status: 'unsupported-input', reason: 'context-over-limit', tokens: measurement.tokens, limit: measurement.limit };
  }
  return { status: 'fits', tokens: measurement.tokens, limit: measurement.limit };
}

export class LayaProvider implements DecisionProvider {
  private readonly fetchRequest: typeof fetch;

  constructor(private readonly config: LayaConfig, private readonly options: LayaProviderOptions = {}) {
    if (config.kind !== 'laya' || !config.baseUrl || !config.checkpoint ||
        !Number.isInteger(config.contextLimit) || config.contextLimit < 1 ||
        !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 ||
        (config.precision !== undefined && !config.precision)) {
      throw new TypeError('Laya configuration requires a base URL, checkpoint, positive context limit, and positive timeout.');
    }
    this.fetchRequest = options.fetchRequest ?? fetch;
  }

  async decide(request: DecisionRequest, maxAttempts: number): Promise<DecisionResult> {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new LayaCallError('Laya call limit must be a positive integer.', 0, 'not_billed');
    }
    const parsedRequest = decisionRequestSchema.safeParse(request);
    if (!parsedRequest.success) throw new LayaCallError('Laya decision request is invalid.', 0, 'not_billed');

    const fit = await checkLayaFit(parsedRequest.data, this.config, this.options.measureFit);
    if (fit.status !== 'fits') {
      throw new LayaCallError(`Laya input is unsupported: ${fit.reason}.`, 0, 'not_billed');
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
            [question.id]: { type: 'choice', instructions: question.instructions, criteria: question.options },
          },
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch {
      throw new LayaCallError('Laya local service request failed.', 1, 'unknown');
    }
    if (!response.ok) throw new LayaCallError(`Laya local service returned HTTP ${response.status}.`, 1, 'not_billed');

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LayaCallError('Laya local service returned unreadable JSON.', 1, 'not_billed');
    }
    const parsedResponse = responseSchema.safeParse(payload);
    if (!parsedResponse.success) {
      throw new LayaCallError('Laya response is missing model, answer, usage, or checkpoint routing metadata.', 1, 'not_billed');
    }
    if (parsedResponse.data.routing.model !== this.config.checkpoint) {
      throw new LayaCallError('Laya routed the request to a checkpoint other than the configured checkpoint.', 1, 'not_billed');
    }
    const answer = answerSchema.safeParse(parsedResponse.data.answers[question.id]);
    if (!answer.success) throw new LayaCallError(`Laya returned an invalid choice answer for ${question.id}.`, 1, 'not_billed');

    const result: DecisionResult = {
      choice: answer.data.choice,
      probabilities: answer.data.probabilities,
      ...(answer.data.confidence === undefined ? {} : { confidence: answer.data.confidence }),
      attempts: 1,
      provider: 'laya',
      model: parsedResponse.data.model,
      checkpoint: parsedResponse.data.routing.model,
      latencyMs: performance.now() - startedAt,
      usage: {
        ...(parsedResponse.data.usage.input_tokens === undefined ? {} : { inputTokens: parsedResponse.data.usage.input_tokens }),
        ...(parsedResponse.data.usage.output_tokens === undefined ? {} : { outputTokens: parsedResponse.data.usage.output_tokens }),
      },
      chargeStatus: 'not_billed',
    };
    try {
      return validateDecision(request, result, { maxAttempts, provider: 'laya', checkpoint: this.config.checkpoint });
    } catch (error) {
      if (error instanceof DecisionError) {
        throw new LayaCallError('Laya response failed decision validation.', 1, 'not_billed');
      }
      throw error;
    }
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
