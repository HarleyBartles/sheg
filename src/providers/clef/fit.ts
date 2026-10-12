import type { DecisionBatchRequest, DecisionRequest } from '../../domain/decision/decision.js';
import type { ProviderContextFit } from '../../domain/decision/provider.js';
import { clefConfigSchema, type ClefConfigInput, type ClefImageResolver } from './config.js';
import { CLEF_SAFE_CONTEXT_TOKENS, compileClefRequest, ClefCompilationError } from './compiler.js';

export const CLEF_MEASUREMENT_METHOD = 'utf8-bytes-div-3+1027-per-image+20%-reserve/v1';

function unavailable(config: ReturnType<typeof clefConfigSchema.parse>, reason: string): ProviderContextFit {
  return { provider: 'clef', status: 'unavailable', method: CLEF_MEASUREMENT_METHOD, modelIdentity: config.model, tokenCount: 'estimated', tokens: 0,
    contextLimit: 65_536, headroomTokens: 14_336, effectiveLimit: CLEF_SAFE_CONTEXT_TOKENS, details: {}, reason };
}

export function measureClefBatchFit(request: DecisionBatchRequest, configInput: ClefConfigInput, imageResolver?: ClefImageResolver): ProviderContextFit {
  const config = clefConfigSchema.parse(configInput);
  try {
    const compiled = compileClefRequest(request, config, imageResolver);
    const tokens = compiled.textEstimate + compiled.imageTokenAllowance;
    return { provider: 'clef', status: 'fits', method: CLEF_MEASUREMENT_METHOD, modelIdentity: config.model, tokenCount: 'estimated', tokens,
      contextLimit: 65_536, headroomTokens: 14_336, effectiveLimit: CLEF_SAFE_CONTEXT_TOKENS,
      details: { textProjectionUtf8Bytes: Buffer.byteLength(compiled.nonImageProjection, 'utf8'), bytesPerEstimatedToken: 3, reservePercent: 20,
        imageCount: compiled.imageCount, imageBytes: compiled.imageBytes, imageTokenAllowance: compiled.imageTokenAllowance,
        estimatedTokens: compiled.textEstimate, totalEstimatedTokens: tokens, effectiveLimitTokens: CLEF_SAFE_CONTEXT_TOKENS,
        serializedBodyBytes: compiled.bodyBytes, finalJsonBodyBytes: compiled.bodyBytes, altTextInPixelProjection: 0 } };
  } catch (error) {
    if (!(error instanceof ClefCompilationError)) return unavailable(config, 'request-projection-unavailable');
    const status = error.status;
    const fit = unavailable(config, error.reason);
    return { ...fit, status, tokens: status === 'overflow' && error.reason === 'estimated-context-over-limit' ? CLEF_SAFE_CONTEXT_TOKENS + 1 : 0,
      details: { effectiveLimitTokens: CLEF_SAFE_CONTEXT_TOKENS, ...fit.details } };
  }
}

export function measureClefContextFit(request: DecisionRequest, config: ClefConfigInput, imageResolver?: ClefImageResolver): ProviderContextFit {
  return measureClefBatchFit({ state: request.state, questions: [request.question], ...(request.visualMaterials ? { visualMaterials: request.visualMaterials } : {}) }, config, imageResolver);
}
