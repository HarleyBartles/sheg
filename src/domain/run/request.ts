import { providerFailureEvidenceSchema } from '../decision/provider-failure.js';
import { z } from 'zod';
import { decisionFailureDetailSchema, decisionQuestionSchema } from '../decision/decision.js';
import { respondentProfileSchema } from '../respondents/profile.js';
import { providerConfigSchema } from '../../providers/config.js';
import { journeyDefinitionSchema, type JourneyDefinition } from '../study/arm.js';
import type { JourneyEvaluation, JourneyRespondentState } from './lifecycle.js';
import { decisionResultSchema } from '../decision/decision.js';
import { providerExecutionEvidenceSchema } from '../decision/decision.js';
import { stimulusItemSchema } from '../study/stimulus.js';

export const materialItemSchema = stimulusItemSchema;
export type RunMaterialItem = z.infer<typeof materialItemSchema>;

function validateMaterialChoices(questions: readonly { type?: string | undefined; id: string; options?: Record<string, string> | undefined; materialOptions?: Record<string, string> | undefined }[], material: readonly z.infer<typeof materialItemSchema>[], context: z.RefinementCtx): void {
  const materials = new Map(material.map((item) => [item.id, item]));
  questions.forEach((question, questionIndex) => {
    if (question.type !== undefined && question.type !== 'choice' || !question.materialOptions || !question.options) return;
    for (const [optionId, materialId] of Object.entries(question.materialOptions)) {
      const issuePath = ['questions', questionIndex, 'materialOptions', optionId];
      const candidate = materials.get(materialId);
      if (!candidate) {
        context.addIssue({ code: 'custom', path: issuePath, message: `Choice option ${optionId} references unknown material ${materialId}.` });
        continue;
      }
      if (candidate.sourceId === undefined || candidate.sourceSha256 === undefined) {
        context.addIssue({ code: 'custom', path: issuePath, message: `Material ${materialId} requires source identity and digest before it can be linked.` });
      }
      if (question.options[optionId] !== candidate.text) {
        context.addIssue({ code: 'custom', path: ['questions', questionIndex, 'options', optionId], message: `Choice option ${optionId} must equal the exact text of material ${materialId}.` });
      }
    }
  });
}

export const inlineRunRequestSchema = z.object({
  kind: z.literal('poll'),
  label: z.string().min(1).max(120).optional(),
  respondents: z.array(respondentProfileSchema).min(1),
  material: z.array(materialItemSchema).min(1),
  questions: z.array(decisionQuestionSchema).min(1),
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

  const questionIds = request.questions.map(({ id }) => id);
  if (new Set(questionIds).size !== questionIds.length) {
    context.addIssue({ code: 'custom', path: ['questions'], message: 'Question IDs must be unique within a run.' });
  }
  validateMaterialChoices(request.questions, request.material, context);
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
    if (new Set(selection.references.map(({ evaluationId }) => evaluationId)).size !== selection.references.length) {
      context.addIssue({ code: 'custom', path: ['references'], message: 'Evaluation references must be unique.' });
    }
  }),
]);

const followOnContextSchema = z.object({
  mode: z.enum(['recorded', 'fresh-material', 'omit-history', 'continue']),
  materialIds: z.array(materialItemSchema.shape.id).min(1).optional(),
  includeSelectedMaterial: z.boolean().optional(),
}).strict().superRefine((contextInput, context) => {
  if (contextInput.materialIds && new Set(contextInput.materialIds).size !== contextInput.materialIds.length) {
    context.addIssue({ code: 'custom', path: ['materialIds'], message: 'Material references must be unique and ordered.' });
  }
  if (contextInput.mode === 'recorded' && contextInput.materialIds) {
    context.addIssue({ code: 'custom', path: ['materialIds'], message: 'Recorded context does not allow material changes.' });
  }
  if (contextInput.includeSelectedMaterial && contextInput.mode !== 'fresh-material' && contextInput.mode !== 'omit-history') {
    context.addIssue({ code: 'custom', path: ['includeSelectedMaterial'], message: 'Selected Choice material requires fresh-material or omit-history context.' });
  }
});

export const followOnRunRequestSchema = z.object({
  kind: z.literal('follow-on'),
  label: z.string().min(1).max(120).optional(),
  sourceRunId: z.string().uuid(),
  selection: followOnSelectionSchema,
  context: followOnContextSchema,
  material: z.array(materialItemSchema).min(1).optional(),
  questions: z.array(decisionQuestionSchema).min(1),
  provider: providerConfigSchema,
  maxCalls: z.number().int().positive(),
}).strict().superRefine((request, context) => {
  const questionIds = request.questions.map(({ id }) => id);
  if (new Set(questionIds).size !== questionIds.length) {
    context.addIssue({ code: 'custom', path: ['questions'], message: 'Question IDs must be unique within a run.' });
  }
  if (request.context.includeSelectedMaterial && 'criteria' in request.selection) {
    if (!request.selection.criteria.questionId) {
      context.addIssue({ code: 'custom', path: ['selection', 'criteria', 'questionId'], message: 'Selected-material criteria must identify the source Choice question.' });
    }
    if (request.selection.criteria.answer) {
      context.addIssue({ code: 'custom', path: ['selection', 'criteria', 'answer'], message: 'Selected-material criteria must include all answers to report mapped and unmapped selections.' });
    }
  }
  const hasMaterial = Boolean(request.context.includeSelectedMaterial || request.material?.length || request.context.materialIds?.length);
  if ((request.context.mode === 'fresh-material' || request.context.mode === 'omit-history') && !hasMaterial) {
    context.addIssue({ code: 'custom', path: ['context', 'materialIds'], message: `${request.context.mode} context requires explicit material or material references.` });
  }
  if (request.material && new Set(request.material.map(({ id }) => id)).size !== request.material.length) {
    context.addIssue({ code: 'custom', path: ['material'], message: 'Material IDs must be unique within a follow-on request.' });
  }
  if (request.material && request.context.materialIds && request.material.some(({ id }) => request.context.materialIds?.includes(id))) {
    context.addIssue({ code: 'custom', path: ['material'], message: 'Inline material IDs must not duplicate selected source material IDs.' });
  }
  if (request.context.mode === 'recorded' && request.material) {
    context.addIssue({ code: 'custom', path: ['material'], message: 'Recorded context does not allow material changes.' });
  }
});

const runStatuses = ['prepared', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted'] as const;
const sourceEvaluationStatuses = ['pending', 'answered', 'failed', 'unreached'] as const;
const followOnExclusionSchema = z.object({
  sourceEvaluationId: z.string().uuid(),
  sourceContextId: z.string().uuid(),
  respondentId: z.string().min(1),
  status: z.enum(sourceEvaluationStatuses),
  reason: z.enum(['pending', 'failed', 'unreached', 'nonChoice', 'unmappedChoice']),
  choiceId: z.string().min(1).optional(),
  choiceMeaning: z.string().min(1).optional(),
}).strict();
export type FollowOnSelectionExclusion = z.infer<typeof followOnExclusionSchema>;

export const selectionCoverageSchema = z.object({
  matched: z.number().int().nonnegative(),
  eligible: z.number().int().nonnegative(),
  excluded: z.object({
    pending: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    unreached: z.number().int().nonnegative(),
    nonChoice: z.number().int().nonnegative(),
    unmappedChoice: z.number().int().nonnegative(),
  }).strict(),
}).strict().superRefine((coverage, context) => {
  const excludedCount = Object.values(coverage.excluded).reduce((sum, count) => sum + count, 0);
  if (coverage.eligible > coverage.matched || coverage.eligible + excludedCount !== coverage.matched) {
    context.addIssue({ code: 'custom', path: ['excluded'], message: 'Eligible and excluded counts must account for every matched source evaluation.' });
  }
});
export type SelectionCoverage = z.infer<typeof selectionCoverageSchema>;
const selectedMaterialEvidenceSchema = z.object({
  materialId: materialItemSchema.shape.id,
  text: materialItemSchema.shape.text,
  sourceId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  sourceSha256: z.string().regex(/^[a-f\d]{64}$/i),
  textSha256: z.string().regex(/^[a-f\d]{64}$/i),
}).strict();

export const followOnLineageSchema = z.object({
  sourceRunId: z.string().uuid(),
  sourceStatusAtAcceptance: z.enum(runStatuses),
  sourceCompleteAtAcceptance: z.boolean(),
  sourceVersion: z.object({ status: z.enum(runStatuses), usedCalls: z.number().int().nonnegative(), reservedCalls: z.number().int().nonnegative(), maxOrdinal: z.number().int().min(-1) }).strict(),
  sourceAvailable: z.boolean().optional(),
  sourceRecordState: z.enum(['live', 'historical']).optional(),
  selectionCoverage: selectionCoverageSchema.optional(),
  excludedSelections: z.array(followOnExclusionSchema).default([]),
  selections: z.array(z.object({ sourceEvaluationId: z.string().uuid(), sourceContextId: z.string().uuid(), respondentId: z.string().min(1), evaluationId: z.string().uuid(), contextId: z.string().uuid(),
    selectedMaterial: selectedMaterialEvidenceSchema.optional(),
  }).strict()),
  materialSnapshots: z.array(z.object({ contextId: z.string().uuid(), respondentId: z.string().min(1), materials: z.array(materialItemSchema) }).strict()).default([]),
}).strict();

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
    failure: z.object({ code: z.string().min(1), message: z.string().min(1), detail: decisionFailureDetailSchema.optional(), providerFailure: providerFailureEvidenceSchema.optional() }).strict().optional(),
    selectedMaterial: selectedMaterialEvidenceSchema.optional(),
    execution: providerExecutionEvidenceSchema.optional(),
    turnId: z.string().min(1).optional(),
    nodeId: z.string().min(1).optional(),
    occurrence: z.number().int().positive().optional(),
    outcome: z.string().optional(),
    provenance: z.object({ provider: z.enum(['jev', 'laya']), model: z.string().min(1), endpoint: z.string().optional(), compilerFingerprint: z.string().min(1), contextFingerprint: z.string().min(1) }).strict(),
  }).strict();

export const runLifecycleSchema = z.object({
  state: z.enum(['active', 'stopped', 'complete']),
  resume: z.discriminatedUnion('eligible', [
    z.object({ eligible: z.literal(true) }).strict(),
    z.object({ eligible: z.literal(false), reason: z.enum(['already_active', 'already_completed', 'cancelled', 'unsupported_status', 'partial_journey', 'cancellation_requested', 'attempt_unresolved', 'call_allowance_exhausted', 'no_unfinished_work']) }).strict(),
  ]),
}).strict();

export const runEvidencePageSchema = z.object({
  items: z.array(runEvidenceItemSchema),
  totalMatches: z.number().int().nonnegative(),
  sourceRunId: z.string().uuid(),
  sourceStatus: z.enum(runStatuses),
  sourceComplete: z.boolean(),
  lifecycle: runLifecycleSchema,
  coverage: z.object({
    totalEvaluations: z.number().int().nonnegative(),
    completedEvaluations: z.number().int().nonnegative(),
    failedEvaluations: z.number().int().nonnegative(),
    respondents: z.object({ total: z.number().int().nonnegative(), active: z.number().int().nonnegative(), completed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), unreached: z.number().int().nonnegative() }).strict(),
  }).strict(),
  matchedCoverage: z.object({
    evaluations: z.object({ total: z.number().int().nonnegative(), pending: z.number().int().nonnegative(), answered: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), unreached: z.number().int().nonnegative() }).strict(),
    representedRespondents: z.number().int().nonnegative(),
    selectedMaterials: z.object({ evaluations: z.number().int().nonnegative(), respondents: z.number().int().nonnegative(), distinctMaterials: z.number().int().nonnegative() }).strict(),
  }).strict(),
  nextCursor: z.string().min(1).optional(),
}).strict();

export const runRequestSchema = z.union([inlineRunRequestSchema, inlineJourneyRequestSchema, followOnRunRequestSchema]);

export type InlineRunRequest = z.input<typeof inlineRunRequestSchema>;
export type ParsedInlineRunRequest = z.output<typeof inlineRunRequestSchema>;
export type InlineJourneyRequest = z.input<typeof inlineJourneyRequestSchema>;
export type ParsedInlineJourneyRequest = z.output<typeof inlineJourneyRequestSchema>;
export type ParsedRunRequest = z.output<typeof runRequestSchema>;
export type EvidenceCriteria = z.infer<typeof evidenceCriteriaSchema>;
export type FollowOnRunRequest = z.input<typeof followOnRunRequestSchema>;
export type ParsedFollowOnRunRequest = z.output<typeof followOnRunRequestSchema>;
export type RunListQueryInput = z.infer<typeof runListQuerySchema>;
export type RunEvidenceQuery = z.infer<typeof runEvidenceQuerySchema>;
export type RunEvidenceItem = z.infer<typeof runEvidenceItemSchema>;
export type RunEvidencePage = z.infer<typeof runEvidencePageSchema>;
export type RunRequest = z.input<typeof runRequestSchema>;
export type { JourneyDefinition };

export type FrozenEvaluation = {
  groupId?: string;
  evaluationId: string;
  contextId: string;
  respondentId: string;
  questionId: string;
  packet: import('../decision/decision.js').DecisionRequest;
  packetFingerprint: string;
};

export type PreparedQuestionGroup = {
  groupId: string;
  contextId: string;
  respondentId: string;
  state: Record<string, unknown>;
  questionIds: string[];
};

export type PreparedRun = {
  request: ParsedInlineRunRequest | ParsedFollowOnRunRequest;
  requestFingerprint: string;
  compilerFingerprint: string;
  evaluations: FrozenEvaluation[];
  groups?: PreparedQuestionGroup[];
  lineage?: FollowOnLineage;
};

export type FollowOnSourceVersion = { status: import('./lifecycle.js').RunStatus; usedCalls: number; reservedCalls: number; maxOrdinal: number };
export type FollowOnSourceTurn = {
  evaluationId: string;
  contextId: string;
  respondentId: string;
  status: 'pending' | 'answered' | 'failed' | 'unreached';
  packet: import('../decision/decision.js').DecisionRequest & { state: import('../decision/prompt.js').PromptState };
  result?: import('../decision/decision.js').DecisionResult;
  materials?: RunMaterialItem[];
  selectedMaterial?: RunEvidenceItem['selectedMaterial'];
};
export type FollowOnSourceSet = {
  sourceRunId: string;
  sourceStatus: import('./lifecycle.js').RunStatus;
  sourceComplete: boolean;
  version: FollowOnSourceVersion;
  turns: FollowOnSourceTurn[];
};
export type FollowOnLineage = z.infer<typeof followOnLineageSchema>;

export type PreparedJourneyRun = {
  request: ParsedInlineJourneyRequest;
  requestFingerprint: string;
  compilerFingerprint: string;
  evaluations: JourneyEvaluation[];
  respondents: JourneyRespondentState[];
};
