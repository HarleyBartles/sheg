import { z } from 'zod';

const identifier = z.string().min(1);
const prose = z.string().min(1);
const probability = z.number().finite().min(0).max(1);
const probabilities = z.record(z.string(), probability);
export const costEvidenceSchema = z.object({
  amountUsd: z.number().finite().nonnegative(),
  basis: z.enum(['provider-reported', 'published-rate-estimate']),
}).strict();
export type CostEvidence = z.infer<typeof costEvidenceSchema>;
const metadata = z.object({
  attempts: z.number().int().positive(),
  provider: z.enum(['jev', 'laya']),
  model: z.string().min(1),
  checkpoint: z.string().min(1).optional(),
  latencyMs: z.number().finite().nonnegative(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
  }).strict(),
  cost: costEvidenceSchema.optional(),
}).strict();

const choiceQuestionSchema = z.object({
  type: z.literal('choice'),
  id: identifier,
  instructions: prose,
  options: z.record(identifier, prose).refine((value) => Object.keys(value).length > 0),
}).strict();
const scoreQuestionSchema = z.object({
  type: z.literal('score'),
  id: identifier,
  instructions: prose,
  rubric: z.array(prose).min(2),
}).strict();
const noulQuestionSchema = z.object({
  type: z.literal('noul'),
  id: identifier,
  instructions: prose,
  criteria: z.object({ true: prose.optional(), false: prose.optional() }).strict().optional(),
}).strict();

const requestStateSchema = z.object({ state: z.record(z.string(), z.unknown()) }).strict();
const choiceRequestSchema = requestStateSchema.extend({
  question: choiceQuestionSchema,
  optionIds: z.array(identifier).min(1),
}).strict().superRefine((request, context) => {
  const options = Object.keys(request.question.options);
  if (new Set(request.optionIds).size !== request.optionIds.length ||
      request.optionIds.length !== options.length ||
      request.optionIds.some((id) => !options.includes(id))) {
    context.addIssue({ code: 'custom', path: ['optionIds'], message: 'Request option IDs must uniquely match the offered options.' });
  }
});
const scoreRequestSchema = requestStateSchema.extend({ question: scoreQuestionSchema }).strict();
const noulRequestSchema = requestStateSchema.extend({ question: noulQuestionSchema }).strict();

export const decisionRequestSchema = z.union([choiceRequestSchema, scoreRequestSchema, noulRequestSchema]);

const choiceResultSchema = z.object({
  type: z.literal('choice').default('choice'),
  choice: identifier,
  probabilities,
  confidence: probability.optional(),
}).extend(metadata.shape).strict();
const scoreResultSchema = z.object({
  type: z.literal('score'),
  score: z.number().finite(),
  legend: z.record(z.string().regex(/^\d+$/), prose),
  probabilities: z.record(z.string().regex(/^\d+$/), probability),
  confidence: probability.optional(),
}).extend(metadata.shape).strict();
const noulResultSchema = z.object({ type: z.literal('noul'), noul: probability }).extend(metadata.shape).strict();

export const decisionResultSchema = z.discriminatedUnion('type', [choiceResultSchema, scoreResultSchema, noulResultSchema]);

export const decisionValueSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('choice'), choice: identifier, probabilities: probabilities.optional(), confidence: probability.optional() }).strict(),
  z.object({ type: z.literal('score'), score: z.number().finite(), legend: z.record(z.string().regex(/^\d+$/), prose), probabilities: z.record(z.string().regex(/^\d+$/), probability), confidence: probability.optional() }).strict(),
  z.object({ type: z.literal('noul'), noul: probability }).strict(),
]);

export type DecisionValue = z.infer<typeof decisionValueSchema>;
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;
export type DecisionResult = z.infer<typeof decisionResultSchema>;
