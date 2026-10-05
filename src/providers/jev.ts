import { ProviderCallError, type ProviderFailureOptions } from '../domain/decision/provider-failure.js';
import { decisionBatchRequestSchema, decisionRequestSchema, decisionValueFromResult, type DecisionBatchRequest, type DecisionBatchResult, type DecisionRequest, type DecisionResult } from '../domain/decision/decision.js';
import type { DecisionProvider, ProviderContextFit } from '../domain/decision/provider.js';
import { DecisionError, decisionValidationFailure, decisionValidationFailureForReason, validateDecision, validateDecisionBatch } from '../domain/decision/validate.js';
import { jevConfigSchema, type JevConfigInput, type JevConfig } from './jev/config.js';
import { jevMetadata } from './jev/model-metadata.js';
import { WindowsCredentialStore } from '../infrastructure/credentials/windows.js';
import { executeJevTransport, JevTransportError } from './jev/transport.js';
import { systemOneAnswerSchema, systemOneQuestion } from './system-one-contract.js';

export { jevConfigInputSchema, jevConfigSchema, type JevConfigInput, type JevConfig, type JevRoute } from './jev/config.js';

export class JevCallError extends ProviderCallError {
  readonly decisionId: string | undefined;

  constructor(message: string, options: ProviderFailureOptions & { decisionId?: string }) {
    super(message, options);
    this.decisionId = options.decisionId;
    this.name = 'JevCallError';
  }
}

const TYPESAFE_CONTEXT_UNVERIFIED = 'typesafe-model-context-unverified';
const JEV_MEASUREMENT_METHOD = 'utf8-bytes-div-3+20%-reserve/v1';

function requestBody(request: DecisionRequest, model: string): Record<string, unknown> {
  return { model, state: request.state, questions: { [request.question.id]: systemOneQuestion(request.question) } };
}

function batchRequestBody(request: DecisionBatchRequest, model: string): Record<string, unknown> {
  return { model, state: request.state, questions: Object.fromEntries(request.questions.map((question) => [question.id, systemOneQuestion(question)])) };
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
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new JevCallError('Jev call limit must be a positive integer.', { attempts: 0 });
    const parsedRequest = decisionRequestSchema.safeParse(request);
    if (!parsedRequest.success) throw new JevCallError('Jev decision request is invalid.', { attempts: 0 });
    const fit = this.measure(parsedRequest.data);
    if (fit.status !== 'fits') throw new JevCallError(`unsupported-input: ${fit.reason ?? fit.status}.`, { attempts: 0, contextFit: fit, decisionId: parsedRequest.data.question.id });
    const { question } = parsedRequest.data;
    const { response, execution } = await this.execute(JSON.stringify(requestBody(parsedRequest.data, this.config.model)), maxAttempts);
    const answer = systemOneAnswerSchema.safeParse(response.answers[question.id]);
    if (!answer.success) {
      throw new JevCallError(`Jev response does not contain a valid ${question.type} answer for ${question.id}.`, { attempts: execution.attempts, decisionId: question.id, code: 'decision_failed', validationFailure: decisionValidationFailureForReason('malformed_answer') });
    }
    const result: DecisionResult = { ...answer.data, ...execution };
    try {
      return validateDecision(request, result, { maxAttempts, provider: 'jev' });
    } catch (error) {
      if (error instanceof DecisionError) {
        throw new JevCallError('Jev response failed decision validation.', { attempts: execution.attempts, code: 'decision_failed', validationFailure: decisionValidationFailure(error) });
      }
      throw error;
    }
  }
  measureBatch(request: DecisionBatchRequest): ProviderContextFit {
    const parsed = decisionBatchRequestSchema.safeParse(request);
    if (!parsed.success) return { ...missingMeasureFit(this.config, 'invalid-batch-request'), reason: 'invalid-batch-request' };
    return this.measureBatchContext?.(parsed.data, this.config) ?? measureJevBatchContext(parsed.data, this.config.model, this.config.route);
  }

  async decideBatch(request: DecisionBatchRequest, maxAttempts: number): Promise<DecisionBatchResult> {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new JevCallError('Jev call limit must be a positive integer.', { attempts: 0 });
    const parsedRequest = decisionBatchRequestSchema.safeParse(request);
    if (!parsedRequest.success) throw new JevCallError('Jev decision batch request is invalid.', { attempts: 0 });
    const normalizedRequest = parsedRequest.data;
    const fit = this.measureBatch(normalizedRequest);
    if (fit.status !== 'fits') throw new JevCallError(`unsupported-input: ${fit.reason ?? fit.status}.`, { attempts: 0, contextFit: fit });
    const { response, execution } = await this.execute(JSON.stringify(batchRequestBody(normalizedRequest, this.config.model)), maxAttempts);
    const answers = Object.entries(response.answers).map(([questionId, rawValue]) => {
      const answer = systemOneAnswerSchema.safeParse(rawValue);
      return { questionId, value: answer.success ? decisionValueFromResult(answer.data) : rawValue };
    });
    try {
      return validateDecisionBatch(normalizedRequest, { answers, execution }, { maxAttempts, provider: 'jev' });
    } catch (error) {
      if (error instanceof DecisionError) throw new JevCallError('Jev response failed batch decision validation.', { attempts: execution.attempts, code: 'decision_failed', validationFailure: decisionValidationFailure(error) });
      throw error;
    }
  }
  private async execute(body: string, maxAttempts: number) {
    try {
      return await executeJevTransport({ config: this.config, credentialStore: this.credentialStore, fetchRequest: this.fetchRequest, body, maxAttempts });
    } catch (error) {
      if (error instanceof JevTransportError) {
        throw new JevCallError(error.message, { attempts: error.attempts, scope: error.scope, code: error.code, category: error.category,
          ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }) });
      }
      throw error;
    }
  }
  measure(request: DecisionRequest): ProviderContextFit {
    return this.measureContext(request, this.config);
  }
}

function missingMeasureFit(config: JevConfig, reason: string): ProviderContextFit {
  return { provider: 'jev', status: 'unavailable', method: 'unavailable', modelIdentity: config.model, tokenCount: 'estimated', tokens: 0, contextLimit: null, headroomTokens: null, effectiveLimit: null, details: {}, reason };
}

