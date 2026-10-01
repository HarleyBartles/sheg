import { z } from 'zod';
import { decisionQuestionSchema } from '../decision/decision.js';
import { respondentProfileSchema } from '../respondents/profile.js';
import { providerConfigSchema } from '../../providers/config.js';
import { journeyDefinitionSchema, type JourneyDefinition } from '../study/arm.js';
import type { JourneyEvaluation, JourneyRespondentState } from './lifecycle.js';
import { decisionResultSchema } from '../decision/decision.js';

const materialItemSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  text: z.string().min(1),
}).strict();

export const inlineRunRequestSchema = z.object({
  kind: z.literal('poll'),
  label: z.string().min(1).max(120).optional(),
  respondents: z.array(respondentProfileSchema).min(1),
  material: z.array(materialItemSchema).min(1),
  questions: z.tuple([decisionQuestionSchema]),
  provider: providerConfigSchema,
  maxCalls: z.number().int().positive(),
}).strict().superRefine((request, context) => {
  const respondentIds = request.respondents.map(({ id }) => id);
  if (new Set(respondentIds).size !== respondentIds.length) {
    context.addIssue({ code: 'custom', path: ['respondents'], message: 'Respondent IDs must be unique within a run.' });
  }

  const materialIds = request.material.map(({ id }) => id);
  if (new Set(materialIds).size !== materialIds.length) {
    context.addIssue({ code: 'custom', path: ['material'], message: 'Material IDs must be unique within a run.' });
  }

  if (request.maxCalls < request.respondents.length) {
    context.addIssue({ code: 'custom', path: ['maxCalls'], message: 'maxCalls must allow at least one decision for each respondent.' });
  }
});

export const inlineJourneyRequestSchema = z.object({
  kind: z.literal('journey'),
  label: z.string().min(1).max(120).optional(),
  respondents: z.array(respondentProfileSchema).min(1),
  journey: journeyDefinitionSchema,
  provider: providerConfigSchema,
  maxCalls: z.number().int().positive(),
}).strict().superRefine((request, context) => {
  const respondentIds = request.respondents.map(({ id }) => id);
  if (new Set(respondentIds).size !== respondentIds.length) {
    context.addIssue({ code: 'custom', path: ['respondents'], message: 'Respondent IDs must be unique within a run.' });
  }
});

const evidenceAnswerCriterionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('choice'), choiceId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('score'), operator: z.enum(['eq', 'lt', 'lte', 'gt', 'gte']), value: z.number().finite() }).strict(),
  z.object({ type: z.literal('noul'), operator: z.enum(['eq', 'lt', 'lte', 'gt', 'gte']), value: z.number().finite().min(0).max(1) }).strict(),
]);

export const evidenceCriteriaSchema = z.object({
  respondentId: z.string().min(1).optional(),
  status: z.enum(['pending', 'answered', 'failed', 'unreached']).optional(),
  questionId: z.string().min(1).optional(),
  materialId: materialItemSchema.shape.id.optional(),
  answer: evidenceAnswerCriterionSchema.optional(),
  outcome: z.string().min(1).optional(),
}).strict();

const followOnReferenceSchema = z.object({ evaluationId: z.string().uuid(), contextId: z.string().uuid() }).strict();
const followOnSelectionSchema = z.union([
  z.object({ criteria: evidenceCriteriaSchema }).strict(),
  z.object({ references: z.array(followOnReferenceSchema).min(1).max(10_000) }).strict().superRefine((selection, context) => {
    if (new Set(selection.references.map(({ evaluationId }) => evaluationId)).size !== selection.references.length ||
        new Set(selection.references.map(({ contextId }) => contextId)).size !== selection.references.length) {
      context.addIssue({ code: 'custom', path: ['references'], message: 'Evaluation and context references must each be unique.' });
    }
  }),
]);

export const followOnRunRequestSchema = z.object({
  kind: z.literal('follow-on'),
  label: z.string().min(1).max(120).optional(),
  sourceRunId: z.string().uuid(),
  selection: followOnSelectionSchema,
  context: z.object({ mode: z.enum(['recorded', 'fresh-material', 'omit-history', 'continue']) }).strict(),
  material: z.array(materialItemSchema).min(1).optional(),
  questions: z.tuple([decisionQuestionSchema]),
  provider: providerConfigSchema,
  maxCalls: z.number().int().positive(),
}).strict().superRefine((request, context) => {
  if (request.context.mode === 'fresh-material' && !request.material) {
    context.addIssue({ code: 'custom', path: ['material'], message: 'Fresh-material context requires explicit material.' });
  }
  if (request.material && new Set(request.material.map(({ id }) => id)).size !== request.material.length) {
    context.addIssue({ code: 'custom', path: ['material'], message: 'Material IDs must be unique within a follow-on request.' });
  }
});

const runStatuses = ['prepared', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted'] as const;
export const runListQuerySchema = z.object({
  status: z.enum(runStatuses).optional(),
  label: z.string().min(1).optional(),
  createdAfter: z.string().datetime().optional(),
  createdBefore: z.string().datetime().optional(),
  materialId: materialItemSchema.shape.id.optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict().superRefine((query, context) => {
  if (query.createdAfter && query.createdBefore && Date.parse(query.createdAfter) > Date.parse(query.createdBefore)) {
    context.addIssue({ code: 'custom', path: ['createdBefore'], message: 'createdBefore must not precede createdAfter.' });
  }
});

export const runEvidenceQuerySchema = z.object({
  sourceRunId: z.string().uuid(),
  criteria: evidenceCriteriaSchema.default({}),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();

export const runEvidenceItemSchema = z.object({
    sourceRunId: z.string().uuid(),
    evaluationId: z.string().uuid(),
    contextId: z.string().uuid(),
    respondentId: z.string().min(1),
    questionId: z.string().min(1),
    status: z.enum(['pending', 'answered', 'failed', 'unreached']),
    result: decisionResultSchema.optional(),
    turnId: z.string().min(1).optional(),
    nodeId: z.string().min(1).optional(),
    occurrence: z.number().int().positive().optional(),
    outcome: z.string().optional(),
    provenance: z.object({ provider: z.enum(['jev', 'laya']), model: z.string().min(1), endpoint: z.string().optional(), compilerFingerprint: z.string().min(1), contextFingerprint: z.string().min(1) }).strict(),
  }).strict();

export const runEvidencePageSchema = z.object({
  items: z.array(runEvidenceItemSchema),
  totalMatches: z.number().int().nonnegative(),
  sourceRunId: z.string().uuid(),
  sourceStatus: z.enum(runStatuses),
  sourceComplete: z.boolean(),
  coverage: z.object({
    totalEvaluations: z.number().int().nonnegative(),
    completedEvaluations: z.number().int().nonnegative(),
    failedEvaluations: z.number().int().nonnegative(),
    respondents: z.object({ total: z.number().int().nonnegative(), active: z.number().int().nonnegative(), completed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), unreached: z.number().int().nonnegative() }).strict(),
  }).strict(),
  nextCursor: z.string().min(1).optional(),
}).strict();

export const runRequestSchema = z.union([inlineRunRequestSchema, inlineJourneyRequestSchema]);

export type InlineRunRequest = z.input<typeof inlineRunRequestSchema>;
export type ParsedInlineRunRequest = z.output<typeof inlineRunRequestSchema>;
export type InlineJourneyRequest = z.input<typeof inlineJourneyRequestSchema>;
export type ParsedInlineJourneyRequest = z.output<typeof inlineJourneyRequestSchema>;
export type EvidenceCriteria = z.infer<typeof evidenceCriteriaSchema>;
export type FollowOnRunRequest = z.input<typeof followOnRunRequestSchema>;
export type ParsedFollowOnRunRequest = z.output<typeof followOnRunRequestSchema>;
export type RunListQueryInput = z.infer<typeof runListQuerySchema>;
export type RunEvidenceQuery = z.infer<typeof runEvidenceQuerySchema>;
export type RunEvidenceItem = z.infer<typeof runEvidenceItemSchema>;
export type RunEvidencePage = z.infer<typeof runEvidencePageSchema>;
export type RunRequest = z.input<typeof runRequestSchema>;
export type ParsedRunRequest = z.output<typeof runRequestSchema>;
export type { JourneyDefinition };

export type FrozenEvaluation = {
  evaluationId: string;
  contextId: string;
  respondentId: string;
  questionId: string;
  packet: import('../decision/decision.js').DecisionRequest;
  packetFingerprint: string;
};

export type PreparedRun = {
  request: ParsedInlineRunRequest;
  requestFingerprint: string;
  compilerFingerprint: string;
  evaluations: FrozenEvaluation[];
};

export type PreparedJourneyRun = {
  request: ParsedInlineJourneyRequest;
  requestFingerprint: string;
  compilerFingerprint: string;
  evaluations: JourneyEvaluation[];
  respondents: JourneyRespondentState[];
};
