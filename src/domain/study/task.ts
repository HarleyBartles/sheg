import { z } from 'zod';

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const prose = z.string().trim().min(1);

export const taskSchema = z.object({
  id: identifier,
  instructions: prose,
  options: z.record(identifier, prose).refine((options) => Object.keys(options).length > 0, 'A choice task requires at least one option.'),
  comparisonKey: identifier.optional(),
  answerKeyOptionId: identifier.optional(),
}).strict().superRefine((task, context) => {
  if (task.answerKeyOptionId && !(task.answerKeyOptionId in task.options)) {
    context.addIssue({ code: 'custom', path: ['answerKeyOptionId'], message: `Answer key must identify an offered option. Unknown option ${task.answerKeyOptionId}.` });
  }
});

export type StudyTask = z.infer<typeof taskSchema>;
