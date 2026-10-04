import { z } from 'zod';
import type { DecisionQuestion } from '../domain/decision/decision.js';

const choiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string().min(1),
  probabilities: z.record(z.string(), z.number().finite().min(0).max(1)),
  confidence: z.number().finite().min(0).max(1).optional(),
}).passthrough();
const scoreAnswerSchema = z.object({ type: z.literal('score'), score: z.number().finite(), legend: z.record(z.string(), z.string()), probabilities: z.record(z.string(), z.number().finite().min(0).max(1)), confidence: z.number().finite().min(0).max(1).optional() }).passthrough();
const noulAnswerSchema = z.object({ type: z.literal('noul'), noul: z.number().finite().min(0).max(1) }).passthrough();

export const systemOneAnswerSchema = z.discriminatedUnion('type', [choiceAnswerSchema, scoreAnswerSchema, noulAnswerSchema]);

export function systemOneQuestion(question: DecisionQuestion): Record<string, unknown> {
  const criteria = question.type === 'choice' ? question.options : question.type === 'score' ? question.rubric : question.criteria;
  return { type: question.type, instructions: question.instructions, ...(criteria === undefined ? {} : { criteria }) };
}
