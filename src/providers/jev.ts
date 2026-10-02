import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';
import { decisionBatchRequestSchema, decisionRequestSchema, type DecisionBatchRequest, type DecisionBatchResult, type DecisionQuestion, type DecisionRequest, type DecisionResult } from '../domain/decision/decision.js';
import type { DecisionProvider, ProviderContextFit } from '../domain/decision/provider.js';
import { DecisionError, validateDecision, validateDecisionBatch } from '../domain/decision/validate.js';
import { jevConfigSchema, type JevConfigInput, type JevConfig } from './jev/config.js';
import { jevMetadata } from './jev/model-metadata.js';
import { CredentialStoreError, WindowsCredentialStore } from '../infrastructure/credentials/windows.js';

export { jevConfigInputSchema, jevConfigSchema, type JevConfigInput, type JevConfig, type JevRoute } from './jev/config.js';

export class JevCallError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly contextFit?: ProviderContextFit,
    readonly decisionId?: string,
    readonly failureScope: 'evaluation' | 'run' = 'evaluation',
    readonly failureCode = 'provider_unavailable',
  ) {
    super(message);
    this.name = 'JevCallError';
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

const wireResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    cost: z.number().finite().nonnegative().optional(),
  }).passthrough(),
}).passthrough();

const retryableStatuses = new Set([429, 500, 502, 503, 524, 529]);
const TYPESAFE_CONTEXT_UNVERIFIED = 'typesafe-model-context-unverified';
const JEV_MEASUREMENT_METHOD = 'utf8-bytes-div-3+20%-reserve/v1';

function wireQuestion(question: DecisionQuestion): Record<string, unknown> {
  const criteria = question.type === 'choice' ? question.options : question.type === 'score' ? question.rubric : question.criteria;
  return { type: question.type, instructions: question.instructions, ...(criteria === undefined ? {} : { criteria }) };
}

function requestBody(request: DecisionRequest, model: string): Record<string, unknown> {
  return { model, state: request.state, questions: { [request.question.id]: wireQuestion(request.question) } };
}

function batchRequestBody(request: DecisionBatchRequest, model: string): Record<string, unknown> {
  return { model, state: request.state, questions: Object.fromEntries(request.questions.map((question) => [question.id, wireQuestion(question)])) };
}

function measureRequestBody(serialized: string, model: string, route: JevConfig['route']): ProviderContextFit {
  const bytes = Buffer.byteLength(serialized, 'utf8');
  const tokens = Math.ceil(bytes / 3);
  const contextLimit = jevMetadata(route, model)?.contextLimit ?? null;
  const headroomTokens = contextLimit === null ? null : Math.ceil(contextLimit * 0.2);
  const effectiveLimit = contextLimit === null ? null : contextLimit - Math.ceil(contextLimit * 0.2);
  const status = effectiveLimit === null ? 'unavailable' : tokens > effectiveLimit ? 'overflow' : 'fits';
  return {
    provider: 'jev', status,
    method: JEV_MEASUREMENT_METHOD, modelIdentity: model, tokenCount: 'estimated', tokens,
    contextLimit, headroomTokens, effectiveLimit,
    details: { serializedUtf8Bytes: bytes, bytesPerEstimatedToken: 3, reservePercent: 20, ...(contextLimit === null ? {} : { contextEvidenceDate: jevMetadata(route, model)?.contextEvidence?.checkedOn ?? 'unrecorded' }) },
    ...(status === 'unavailable' ? { reason: route === 'typesafe' ? TYPESAFE_CONTEXT_UNVERIFIED : 'model-context-unknown' } : status === 'overflow' ? { reason: 'estimated-context-over-limit' } : {}),
  };
}

export function measureJevContext(request: DecisionRequest, model: string, route: JevConfig['route'] = 'openrouter'): ProviderContextFit {
  return measureRequestBody(JSON.stringify(requestBody(request, model)), model, route);
}

export function measureJevBatchContext(request: DecisionBatchRequest, model: string, route: JevConfig['route'] = 'openrouter'): ProviderContextFit {
  return measureRequestBody(JSON.stringify(batchRequestBody(request, model)), model, route);
}

export class JevProvider implements DecisionProvider {
  private readonly config: JevConfig;
  private readonly credentialStore: Pick<WindowsCredentialStore, 'availability' | 'readForAuthentication'>;
  private readonly measureContext: (request: DecisionRequest, config: JevConfig) => ProviderContextFit;
  private readonly measureBatchContext: ((request: DecisionBatchRequest, config: JevConfig) => ProviderContextFit) | undefined;

  constructor(
    config: JevConfigInput,
    private readonly fetchRequest: typeof fetch = fetch,
    options: {
      credentialStore?: Pick<WindowsCredentialStore, 'availability' | 'readForAuthentication'>;
      measureContext?: (request: DecisionRequest, config: JevConfig) => ProviderContextFit;
      measureBatchContext?: (request: DecisionBatchRequest, config: JevConfig) => ProviderContextFit;
    } = {},
  ) {
    this.config = jevConfigSchema.parse(config);
    this.credentialStore = options.credentialStore ?? new WindowsCredentialStore();
    this.measureContext = options.measureContext ?? ((request, normalized) => measureJevContext(request, normalized.model, normalized.route));
    this.measureBatchContext = options.measureBatchContext;
  }

  async decide(request: DecisionRequest, maxAttempts: number): Promise<DecisionResult> {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new JevCallError('Jev call limit must be a positive integer.', 0);
    }
    const parsedRequest = decisionRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      throw new JevCallError('Jev decision request is invalid.', 0);
    }
    const fit = this.measure(parsedRequest.data);
    if (fit.status !== 'fits') throw new JevCallError(`unsupported-input: ${fit.reason ?? fit.status}.`, 0, fit, parsedRequest.data.question.id);
    let apiKey: string;
    try { apiKey = await this.credentialStore.readForAuthentication(this.config.route); }
    catch (error) {
      if (error instanceof CredentialStoreError) throw new JevCallError(error.message, 0, undefined, undefined, 'run', error.code);
      throw new JevCallError(`The ${this.config.route} secure credential is unavailable.`, 0, undefined, undefined, 'run', 'credential_unavailable');
    }

    const { question } = parsedRequest.data;
    const body = JSON.stringify(requestBody(parsedRequest.data, this.config.model));
    const startedAt = performance.now();
    let attempts = 0;

    while (attempts < maxAttempts) {
      attempts += 1;
      let response: Response;
      try {
        response = await this.fetchRequest(this.config.endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
      } catch {
        if (attempts < maxAttempts) {
          await wait(retryDelayMs(attempts));
          continue;
        }
        throw new JevCallError('Jev request failed at the transport boundary.', attempts);
      }

      if (!response.ok) {
        if (retryableStatuses.has(response.status) && attempts < maxAttempts) {
          await wait(retryDelayMs(attempts));
          continue;
        }
        throw new JevCallError(`Jev request failed with HTTP ${response.status}.`, attempts, undefined, undefined, response.status === 401 || response.status === 403 ? 'run' : 'evaluation');
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new JevCallError('Jev returned an unreadable response.', attempts);
      }

      const parsedResponse = wireResponseSchema.safeParse(payload);
      if (!parsedResponse.success) {
        throw new JevCallError('Jev response is missing required identity or usage fields.', attempts);
      }
      const answer = answerSchema.safeParse(parsedResponse.data.answers[question.id]);
      if (!answer.success) {
        throw new JevCallError(`Jev response does not contain a valid ${question.type} answer for ${question.id}.`, attempts);
      }
      const cost = parsedResponse.data.usage.cost;
      const inputTokens = parsedResponse.data.usage.input_tokens;
      const outputTokens = parsedResponse.data.usage.output_tokens;
      const metadata = jevMetadata(this.config.route, parsedResponse.data.model);
      const estimatedAmount = inputTokens !== undefined && outputTokens !== undefined && metadata?.inputUsdPerMillion !== undefined && metadata.outputUsdPerMillion !== undefined
        ? (inputTokens * metadata.inputUsdPerMillion + outputTokens * metadata.outputUsdPerMillion) / 1_000_000
        : undefined;

      const result: DecisionResult = {
        ...answer.data,
        attempts,
        provider: 'jev',
        model: parsedResponse.data.model,
        latencyMs: performance.now() - startedAt,
        usage: {
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
        },
        ...(cost !== undefined ? { cost: { amountUsd: cost, basis: 'provider-reported' as const } } : estimatedAmount === undefined ? {} : { cost: { amountUsd: estimatedAmount, basis: 'published-rate-estimate' as const } }),
      };

      try {
        return validateDecision(request, result, { maxAttempts, provider: 'jev' });
      } catch (error) {
        if (error instanceof DecisionError) {
          throw new JevCallError('Jev response failed decision validation.', attempts);
        }
        throw error;
      }
    }

    throw new JevCallError('Jev call limit reached without a response.', attempts);
  }

  measureBatch(request: DecisionBatchRequest): ProviderContextFit {
    const parsed = decisionBatchRequestSchema.safeParse(request);
    if (!parsed.success) return { ...missingMeasureFit(this.config, 'invalid-batch-request'), reason: 'invalid-batch-request' };
    return this.measureBatchContext?.(parsed.data, this.config) ?? measureJevBatchContext(parsed.data, this.config.model, this.config.route);
  }

  async decideBatch(request: DecisionBatchRequest, maxAttempts: number): Promise<DecisionBatchResult> {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new JevCallError('Jev call limit must be a positive integer.', 0);
    const parsedRequest = decisionBatchRequestSchema.safeParse(request);
    if (!parsedRequest.success) throw new JevCallError('Jev decision batch request is invalid.', 0);
    const normalizedRequest = parsedRequest.data;
    const fit = this.measureBatch(normalizedRequest);
    if (fit.status !== 'fits') throw new JevCallError(`unsupported-input: ${fit.reason ?? fit.status}.`, 0, fit);
    let apiKey: string;
    try { apiKey = await this.credentialStore.readForAuthentication(this.config.route); }
    catch (error) {
      if (error instanceof CredentialStoreError) throw new JevCallError(error.message, 0, undefined, undefined, 'run', error.code);
      throw new JevCallError(`The ${this.config.route} secure credential is unavailable.`, 0, undefined, undefined, 'run', 'credential_unavailable');
    }

    const body = JSON.stringify(batchRequestBody(normalizedRequest, this.config.model));
    const startedAt = performance.now();
    let attempts = 0;
    while (attempts < maxAttempts) {
      attempts += 1;
      let response: Response;
      try {
        response = await this.fetchRequest(this.config.endpoint, {
          method: 'POST', redirect: 'error',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body, signal: AbortSignal.timeout(this.config.timeoutMs),
        });
      } catch {
        if (attempts < maxAttempts) { await wait(retryDelayMs(attempts)); continue; }
        throw new JevCallError('Jev request failed at the transport boundary.', attempts);
      }
      if (!response.ok) {
        if (retryableStatuses.has(response.status) && attempts < maxAttempts) { await wait(retryDelayMs(attempts)); continue; }
        throw new JevCallError(`Jev request failed with HTTP ${response.status}.`, attempts, undefined, undefined, response.status === 401 || response.status === 403 ? 'run' : 'evaluation');
      }
      let payload: unknown;
      try { payload = await response.json(); }
      catch { throw new JevCallError('Jev returned an unreadable response.', attempts); }
      const parsedResponse = wireResponseSchema.safeParse(payload);
      if (!parsedResponse.success) throw new JevCallError('Jev response is missing required identity or usage fields.', attempts);

      const cost = parsedResponse.data.usage.cost;
      const inputTokens = parsedResponse.data.usage.input_tokens;
      const outputTokens = parsedResponse.data.usage.output_tokens;
      const metadata = jevMetadata(this.config.route, parsedResponse.data.model);
      const estimatedAmount = inputTokens !== undefined && outputTokens !== undefined && metadata?.inputUsdPerMillion !== undefined && metadata.outputUsdPerMillion !== undefined
        ? (inputTokens * metadata.inputUsdPerMillion + outputTokens * metadata.outputUsdPerMillion) / 1_000_000
        : undefined;
      const answers = Object.entries(parsedResponse.data.answers).map(([questionId, rawValue]) => {
        const answer = answerSchema.safeParse(rawValue);
        return { questionId, value: answer.success ? toDecisionValue(answer.data) : rawValue };
      });
      const execution = {
        attempts, provider: 'jev' as const, model: parsedResponse.data.model,
        latencyMs: performance.now() - startedAt,
        usage: { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) },
        ...(cost !== undefined ? { cost: { amountUsd: cost, basis: 'provider-reported' as const } } : estimatedAmount === undefined ? {} : { cost: { amountUsd: estimatedAmount, basis: 'published-rate-estimate' as const } }),
      };
      try {
        return validateDecisionBatch(normalizedRequest, { answers, execution }, { maxAttempts, provider: 'jev' });
      } catch (error) {
        if (error instanceof DecisionError) throw new JevCallError('Jev response failed batch decision validation.', attempts);
        throw error;
      }
    }
    throw new JevCallError('Jev call limit reached without a response.', attempts);
  }

  measure(request: DecisionRequest): ProviderContextFit {
    return this.measureContext(request, this.config);
  }
}

function toDecisionValue(answer: z.infer<typeof answerSchema>) {
  if (answer.type === 'choice') return { type: 'choice' as const, choice: answer.choice, probabilities: answer.probabilities, ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }) };
  if (answer.type === 'score') return { type: 'score' as const, score: answer.score, legend: answer.legend, probabilities: answer.probabilities, ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }) };
  return { type: 'noul' as const, noul: answer.noul };
}

function missingMeasureFit(config: JevConfig, reason: string): ProviderContextFit {
  return { provider: 'jev', status: 'unavailable', method: 'unavailable', modelIdentity: config.model, tokenCount: 'estimated', tokens: 0, contextLimit: null, headroomTokens: null, effectiveLimit: null, details: {}, reason };
}

function retryDelayMs(attempt: number): number {
  return Math.min(50 * 2 ** (attempt - 1), 1_000);
}
