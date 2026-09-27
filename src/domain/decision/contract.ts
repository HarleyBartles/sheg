import { z } from 'zod';

export type ProviderKind = 'jev' | 'laya';
export type ChargeStatus = 'billed' | 'not_billed' | 'unknown';

export const decisionRequestSchema = z.object({
  state: z.record(z.string(), z.unknown()),
  question: z.object({
    id: z.string().min(1),
    instructions: z.string().min(1),
    criteria: z.record(z.string().min(1), z.string().min(1)),
  }).strict(),
  labels: z.array(z.string().min(1)).min(1),
}).strict().superRefine((request, context) => {
  if (new Set(request.labels).size !== request.labels.length ||
      request.labels.length !== Object.keys(request.question.criteria).length ||
      request.labels.some((label) => !(label in request.question.criteria))) {
    context.addIssue({ code: 'custom', path: ['labels'], message: 'Request labels must uniquely match the offered criteria.' });
  }
});

export const decisionResultSchema = z.object({
  choice: z.string().min(1),
  probabilities: z.record(z.string(), z.number().finite().min(0).max(1)),
  confidence: z.number().finite().min(0).max(1).optional(),
  attempts: z.number().int().positive(),
  provider: z.enum(['jev', 'laya']),
  model: z.string().min(1),
  checkpoint: z.string().min(1).optional(),
  latencyMs: z.number().finite().nonnegative(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
  }).strict(),
  chargeStatus: z.enum(['billed', 'not_billed', 'unknown']),
  chargeUsd: z.number().finite().nonnegative().optional(),
}).strict();

export type DecisionRequest = z.infer<typeof decisionRequestSchema>;
export type DecisionResult = z.infer<typeof decisionResultSchema>;

export type ValidationOptions = {
  maxAttempts?: number;
  provider?: ProviderKind;
  model?: string;
  checkpoint?: string;
};

export interface DecisionProvider {
  decide(request: DecisionRequest, maxAttempts: number): Promise<DecisionResult>;
}
