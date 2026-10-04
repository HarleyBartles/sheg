import { z } from 'zod';

const identifier = z.string().min(1);
const prose = z.string().min(1);
const choiceText = z.string().min(1).refine((value) => value.trim().length > 0, 'Choice text must not be blank.');
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
  options: z.record(identifier, choiceText).refine((value) => Object.keys(value).length > 0),
  materialOptions: z.record(identifier, identifier).optional(),
}).strict().superRefine((question, context) => {
  if (question.materialOptions) {
    const links = Object.entries(question.materialOptions);
    const linkedOptionIds = links.map(([optionId]) => optionId);
    const linkedMaterialIds = links.map(([, materialId]) => materialId);
    for (const optionId of linkedOptionIds) {
      if (!Object.hasOwn(question.options, optionId)) {
        context.addIssue({ code: 'custom', path: ['materialOptions', optionId], message: `Material link references unknown option ${optionId}.` });
      }
    }
    if (new Set(linkedMaterialIds).size !== linkedMaterialIds.length) {
      context.addIssue({ code: 'custom', path: ['materialOptions'], message: 'Each material may be linked from at most one option.' });
    }
  }
});
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

export const decisionQuestionSchema = z.union([choiceQuestionSchema, scoreQuestionSchema, noulQuestionSchema]);

export const decisionBatchRequestSchema = z.object({
  state: z.record(z.string(), z.unknown()),
  questions: z.array(decisionQuestionSchema).min(1),
}).strict().superRefine((request, context) => {
  if (new Set(request.questions.map(({ id }) => id)).size !== request.questions.length) {
    context.addIssue({ code: 'custom', path: ['questions'], message: 'Question IDs must be unique within a batch.' });
  }
});

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

export const providerExecutionEvidenceSchema = z.object({
  attempts: z.number().int().positive(),
  provider: z.enum(['jev', 'laya']),
  model: z.string().min(1),
  checkpoint: z.string().min(1).optional(),
  latencyMs: z.number().finite().nonnegative(),
  usage: z.object({ inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional() }).strict(),
  cost: costEvidenceSchema.optional(),
}).strict();

export const decisionFailureDetailSchema = z.object({
  reason: z.enum(['malformed_answer', 'answer_type_mismatch', 'unknown_option', 'probability_keys', 'probability_sum', 'score_out_of_range', 'score_legend_mismatch', 'invalid_answer']),
  field: z.enum(['answer', 'type', 'choice', 'probabilities', 'score', 'legend']),
  constraint: z.enum(['typed_answer_shape', 'match_question_type', 'offered_option', 'declared_outcomes', 'sum_to_one', 'declared_rubric_range', 'match_declared_rubric', 'typed_answer_contract']),
}).strict();
export type DecisionFailureReason = z.infer<typeof decisionFailureDetailSchema>['reason'];
export function decisionFailureDetailForReason(reason: DecisionFailureReason): DecisionFailureDetail {
  const rule = {
    malformed_answer: { field: 'answer', constraint: 'typed_answer_shape' },
    answer_type_mismatch: { field: 'type', constraint: 'match_question_type' },
    unknown_option: { field: 'choice', constraint: 'offered_option' },
    probability_keys: { field: 'probabilities', constraint: 'declared_outcomes' },
    probability_sum: { field: 'probabilities', constraint: 'sum_to_one' },
    score_out_of_range: { field: 'score', constraint: 'declared_rubric_range' },
    score_legend_mismatch: { field: 'legend', constraint: 'match_declared_rubric' },
    invalid_answer: { field: 'answer', constraint: 'typed_answer_contract' },
  }[reason];
  return { reason, ...rule } as DecisionFailureDetail;
}

export const decisionBatchResultSchema = z.object({
  answers: z.array(z.union([
    z.object({ questionId: identifier, value: decisionValueSchema }).strict(),
    z.object({ questionId: identifier, failure: z.object({ code: identifier, message: prose, detail: decisionFailureDetailSchema.optional() }).strict() }).strict(),
  ])),
  execution: providerExecutionEvidenceSchema,
}).strict().superRefine((result, context) => {
  if (new Set(result.answers.map(({ questionId }) => questionId)).size !== result.answers.length) {
    context.addIssue({ code: 'custom', path: ['answers'], message: 'Batch result question IDs must be unique.' });
  }
});

export type DecisionValue = z.infer<typeof decisionValueSchema>;
export type DecisionQuestion = z.infer<typeof decisionQuestionSchema>;
export type DecisionBatchRequest = z.infer<typeof decisionBatchRequestSchema>;
export type ProviderExecutionEvidence = z.infer<typeof providerExecutionEvidenceSchema>;
export type DecisionBatchResult = z.infer<typeof decisionBatchResultSchema>;
export type DecisionFailureDetail = z.infer<typeof decisionFailureDetailSchema>;
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;
export type DecisionResult = z.infer<typeof decisionResultSchema>;
