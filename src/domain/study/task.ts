import { z } from 'zod';

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const prose = z.string().trim().min(1);
const taskFields = {
  id: identifier,
  instructions: prose,
  comparisonKey: identifier.optional(),
  responseHistory: z.enum(['include', 'omit']).optional(),
};
const options = z.record(identifier, prose).refine((value) => Object.keys(value).length > 0, 'A choice task requires at least one option.');

function validateChoiceTask(task: unknown, context: z.RefinementCtx): void {
  if (typeof task !== 'object' || task === null || !('options' in task) || !('answerKeyOptionId' in task)) return;
  const options = task.options as Record<string, string>;
  const answerKeyOptionId = task.answerKeyOptionId;
  if (typeof answerKeyOptionId === 'string' && answerKeyOptionId && !(answerKeyOptionId in options)) {
    context.addIssue({ code: 'custom', path: ['answerKeyOptionId'], message: `Answer key must identify an offered option. Unknown option ${answerKeyOptionId}.` });
  }
}

const legacyChoiceTaskSchema = z.object({
  ...taskFields,
  options,
  answerKeyOptionId: identifier.optional(),
}).strict().superRefine(validateChoiceTask);

const typedChoiceTaskSchema = z.object({
  ...taskFields,
  type: z.literal('choice'),
  options,
  answerKeyOptionId: identifier.optional(),
}).strict().superRefine(validateChoiceTask);

const scoreTaskSchema = z.object({
  ...taskFields,
  type: z.literal('score'),
  rubric: z.array(prose).min(2),
}).strict();

const noulTaskSchema = z.object({
  ...taskFields,
  type: z.literal('noul'),
  criteria: z.object({ true: prose.optional(), false: prose.optional() }).strict().optional(),
}).strict();

const typedTaskSchema = z.discriminatedUnion('type', [typedChoiceTaskSchema, scoreTaskSchema, noulTaskSchema]);

export const taskSchema = z.union([legacyChoiceTaskSchema, typedTaskSchema]).transform((task) => (
  'type' in task ? task : { ...task, type: 'choice' as const }
));

type HistoryPolicy = 'include' | 'omit';
type CommonTask = { id: string; instructions: string; comparisonKey?: string | undefined; responseHistory?: HistoryPolicy | undefined };
export type StudyTask =
  | (CommonTask & { type?: 'choice' | undefined; options: Record<string, string>; answerKeyOptionId?: string | undefined })
  | (CommonTask & { type: 'score'; rubric: string[] })
  | (CommonTask & { type: 'noul'; criteria?: { true?: string | undefined; false?: string | undefined } | undefined });
export type StudyTaskInput = z.input<typeof taskSchema>;
