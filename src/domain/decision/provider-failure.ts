import { z } from 'zod';
import type { ProviderContextFit } from './provider.js';
import type { DecisionFailureDetail } from './decision.js';

export const providerContextFitSchema = z.object({
  provider: z.enum(['jev', 'laya']), status: z.enum(['fits', 'overflow', 'unavailable']),
  method: z.string().min(1), modelIdentity: z.string().min(1), tokenCount: z.enum(['measured', 'estimated']),
  tokens: z.number().finite().nonnegative(), contextLimit: z.number().finite().nonnegative().nullable(),
  headroomTokens: z.number().finite().nullable(), effectiveLimit: z.number().finite().nonnegative().nullable(),
  details: z.record(z.string(), z.union([z.number().finite(), z.string()])), reason: z.string().optional(),
}).strict();

export const providerFailureEvidenceSchema = z.object({
  category: z.enum(['admission', 'credential', 'transport', 'http', 'envelope', 'answer', 'execution']),
  attempts: z.number().int().nonnegative(), scope: z.enum(['evaluation', 'run']),
  httpStatus: z.number().int().min(100).max(599).optional(), contextFit: providerContextFitSchema.optional(),
}).strict();
export type ProviderFailureEvidence = z.infer<typeof providerFailureEvidenceSchema>;
export type ProviderFailureOptions = {
  attempts: number; scope?: 'evaluation' | 'run'; code?: string;
  category?: ProviderFailureEvidence['category']; httpStatus?: number; contextFit?: ProviderContextFit;
  validationFailure?: { code: string; message: string; detail: DecisionFailureDetail };
};

// Adapter diagnostics stay on the error. Only this bounded contract is persisted or returned.
export class ProviderCallError extends Error {
  readonly attempts: number;
  readonly failureScope: 'evaluation' | 'run';
  readonly failureCode: string;
  readonly contextFit: ProviderContextFit | undefined;
  readonly validationFailure: ProviderFailureOptions['validationFailure'];
  readonly evidence: ProviderFailureEvidence;

  constructor(message: string, options: ProviderFailureOptions) {
    super(message);
    this.name = 'ProviderCallError';
    this.attempts = options.attempts;
    this.failureScope = options.scope ?? 'evaluation';
    this.failureCode = options.code ?? 'provider_unavailable';
    this.contextFit = options.contextFit;
    this.validationFailure = options.validationFailure;
    this.evidence = providerFailureEvidenceSchema.parse({
      category: options.category ?? (options.contextFit ? 'admission' : options.validationFailure ? 'answer' : options.code?.startsWith('credential_') ? 'credential' : 'execution'),
      attempts: options.attempts, scope: this.failureScope,
      ...(options.contextFit ? { contextFit: options.contextFit } : {}),
      ...(options.httpStatus === undefined ? {} : { httpStatus: options.httpStatus }),
    });
  }
}
