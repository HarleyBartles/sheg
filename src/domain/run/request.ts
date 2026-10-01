import { z } from 'zod';
import { decisionQuestionSchema } from '../decision/decision.js';
import { respondentProfileSchema } from '../respondents/profile.js';
import { providerConfigSchema } from '../../providers/config.js';

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

export type InlineRunRequest = z.input<typeof inlineRunRequestSchema>;
export type ParsedInlineRunRequest = z.output<typeof inlineRunRequestSchema>;

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
