import { decisionBatchRequestSchema, decisionRequestSchema, type DecisionBatchRequest, type DecisionBatchResult, type DecisionRequest, type DecisionResult } from '../domain/decision/decision.js';
import { ProviderCallError } from '../domain/decision/provider-failure.js';
import type { DecisionProvider, ProviderContextFit } from '../domain/decision/provider.js';
import { DecisionError, decisionValidationFailure, validateDecision, validateDecisionBatch } from '../domain/decision/validate.js';
import { WindowsCredentialStore } from '../infrastructure/credentials/windows.js';
import { clefConfigSchema, type ClefConfigInput, type ClefImageResolver } from './clef/config.js';
import { compileClefRequest, ClefCompilationError } from './clef/compiler.js';
import { measureClefBatchFit, measureClefContextFit } from './clef/fit.js';
import { executeClefTransport } from './clef/transport.js';

export type ClefProviderOptions = {
  credentialStore?: Pick<WindowsCredentialStore, 'readForAuthentication'>;
  imageResolver?: ClefImageResolver;
};

export class ClefProvider implements DecisionProvider {
  private readonly config: ReturnType<typeof clefConfigSchema.parse>;
  private readonly credentialStore: Pick<WindowsCredentialStore, 'readForAuthentication'>;
  private readonly imageResolver: ClefImageResolver | undefined;

  constructor(config: ClefConfigInput, private readonly fetchRequest: typeof fetch = fetch, options: ClefProviderOptions = {}) {
    this.config = clefConfigSchema.parse(config);
    this.credentialStore = options.credentialStore ?? new WindowsCredentialStore();
    this.imageResolver = options.imageResolver;
  }

  measure(request: DecisionRequest): ProviderContextFit {
    return measureClefContextFit(request, this.config, this.imageResolver);
  }

  measureBatch(request: DecisionBatchRequest): ProviderContextFit {
    return measureClefBatchFit(request, this.config, this.imageResolver);
  }

  async decide(request: DecisionRequest, maxAttempts: number): Promise<DecisionResult> {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new ProviderCallError('Clef call limit must be a positive integer.', { attempts: 0 });
    const parsed = decisionRequestSchema.safeParse(request);
    if (!parsed.success) throw new ProviderCallError('Clef decision request is invalid.', { attempts: 0, scope: 'evaluation', category: 'admission' });
    const fit = this.measure(parsed.data);
    if (fit.status !== 'fits') throw new ProviderCallError(`unsupported-input: ${fit.reason ?? fit.status}.`, { attempts: 0, scope: 'evaluation', contextFit: fit, category: 'admission' });
    const result = await this.decideBatch({ state: parsed.data.state, questions: [parsed.data.question], ...(parsed.data.visualMaterials ? { visualMaterials: parsed.data.visualMaterials } : {}) }, maxAttempts);
    const answer = result.answers[0];
    if (!answer || !('value' in answer)) {
      const failure = answer && 'failure' in answer ? answer.failure : undefined;
      const detail = failure && 'detail' in failure ? failure.detail : undefined;
      throw new ProviderCallError('Clef answer failed typed validation.', { attempts: result.execution.attempts, scope: 'evaluation', code: failure?.code ?? 'invalid_answer', category: 'answer',
        ...(detail ? { validationFailure: { code: failure!.code, message: failure!.message, detail } } : {}) });
    }
    const enriched = { ...answer.value, ...result.execution };
    try { return validateDecision(parsed.data, enriched, { maxAttempts, provider: 'clef', model: this.config.model }); }
    catch (error) {
      if (error instanceof DecisionError) throw new ProviderCallError('Clef answer failed typed validation.', { attempts: result.execution.attempts, scope: 'evaluation', code: 'invalid_answer', category: 'answer', validationFailure: decisionValidationFailure(error) });
      throw error;
    }
  }

  async decideBatch(request: DecisionBatchRequest, maxAttempts: number): Promise<DecisionBatchResult> {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new ProviderCallError('Clef call limit must be a positive integer.', { attempts: 0 });
    const parsed = decisionBatchRequestSchema.safeParse(request);
    if (!parsed.success) throw new ProviderCallError('Clef decision batch request is invalid.', { attempts: 0, scope: 'evaluation', category: 'admission' });
    const fit = this.measureBatch(parsed.data);
    if (fit.status !== 'fits') throw new ProviderCallError(`unsupported-input: ${fit.reason ?? fit.status}.`, { attempts: 0, scope: 'evaluation', contextFit: fit, category: 'admission' });
    let compiled;
    try { compiled = compileClefRequest(parsed.data, this.config, this.imageResolver); }
    catch (error) {
      const reason = error instanceof ClefCompilationError ? error.reason : 'request-projection-unavailable';
      throw new ProviderCallError(`unsupported-input: ${reason}.`, { attempts: 0, scope: 'evaluation', contextFit: fit, category: 'admission' });
    }
    const { response, execution } = await executeClefTransport({ config: this.config, credentialStore: this.credentialStore, fetchRequest: this.fetchRequest, body: compiled.body, maxAttempts });
    if (response.model !== this.config.model) throw new ProviderCallError('Clef served a model other than the configured selector.', { attempts: execution.attempts, scope: 'run', category: 'execution' });
    const questionById = new Map(parsed.data.questions.map((question) => [question.id, question]));
    for (const id of Object.keys(response.answers)) if (!questionById.has(id)) throw new ProviderCallError('Clef response contains an unknown question ID.', { attempts: execution.attempts, scope: 'run', category: 'execution' });
    const answers = Object.entries(response.answers).map(([questionId, raw]) => ({ questionId, value: normalizeAnswer(questionById.get(questionId)!, raw) }));
    try { return validateDecisionBatch(parsed.data, { answers, execution }, { maxAttempts, provider: 'clef', model: this.config.model }); }
    catch (error) {
      if (error instanceof DecisionError) throw new ProviderCallError('Clef response execution could not be validated.', { attempts: execution.attempts, scope: 'run', category: 'execution' });
      throw error;
    }
  }
}

function normalizeAnswer(question: DecisionBatchRequest['questions'][number], raw: unknown): unknown {
  if (question.type !== 'score' || typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const answer = raw as Record<string, unknown>;
  if (answer.type !== 'score' || !('probabilities' in answer) || typeof answer.probabilities !== 'object' || answer.probabilities === null || Array.isArray(answer.probabilities)) return raw;
  const rubric = question.rubric;
  return { ...answer, legend: Object.fromEntries(rubric.map((label, index) => [String(index), label])) };
}

export { clefConfigSchema, clefEndpoint, type ClefConfig, type ClefConfigInput, type ClefImageResolver } from './clef/config.js';
export { compileClefRequest } from './clef/compiler.js';
export { measureClefBatchFit, measureClefContextFit } from './clef/fit.js';
