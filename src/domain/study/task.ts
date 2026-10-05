import { z } from 'zod';
import { decisionTypes } from '../decision/decision.js';

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const prose = z.string().trim().min(1);
const choiceText = z.string().min(1).refine((value) => value.trim().length > 0, 'Choice text must not be blank.');
const taskFields = {
  id: identifier,
  instructions: prose,
  comparisonKey: identifier.optional(),
  responseHistory: z.enum(['include', 'omit']).optional(),
};
const options = z.record(identifier, choiceText).refine((value) => Object.keys(value).length > 0, 'A choice task requires at least one option.');
const materialOptions = z.record(identifier, identifier).optional();

function validateChoiceTask(task: unknown, context: z.RefinementCtx): void {
  if (typeof task !== 'object' || task === null || !('options' in task)) return;
  const optionsValue = task.options;
  if (typeof optionsValue !== 'object' || optionsValue === null || Array.isArray(optionsValue)) return;
  const choiceOptions = optionsValue as Record<string, string>;
  if ('answerKeyOptionId' in task) {
    const answerKeyOptionId = task.answerKeyOptionId;
    if (typeof answerKeyOptionId === 'string' && answerKeyOptionId && !Object.hasOwn(choiceOptions, answerKeyOptionId)) {
      context.addIssue({ code: 'custom', path: ['answerKeyOptionId'], message: `Answer key must identify an offered option. Unknown option ${answerKeyOptionId}.` });
    }
  }
  if ('materialOptions' in task && typeof task.materialOptions === 'object' && task.materialOptions !== null && !Array.isArray(task.materialOptions)) {
    const materialOptions = task.materialOptions as Record<string, string>;
    for (const optionId of Object.keys(materialOptions)) {
      if (!Object.hasOwn(choiceOptions, optionId)) {
        context.addIssue({ code: 'custom', path: ['materialOptions', optionId], message: `Material link references unknown option ${optionId}.` });
      }
    }
    if (new Set(Object.values(materialOptions)).size !== Object.keys(materialOptions).length) {
      context.addIssue({ code: 'custom', path: ['materialOptions'], message: 'Each material may be linked from at most one option.' });
    }
  }
}

const legacyChoiceTaskSchema = z.object({
  ...taskFields,
  options,
  materialOptions,
  answerKeyOptionId: identifier.optional(),
}).strict().superRefine(validateChoiceTask);

const typedChoiceTaskSchema = z.object({
  ...taskFields,
  type: z.literal(decisionTypes.choice),
  options,
  materialOptions,
  answerKeyOptionId: identifier.optional(),
}).strict().superRefine(validateChoiceTask);

const scoreTaskSchema = z.object({
  ...taskFields,
  type: z.literal(decisionTypes.score),
  rubric: z.array(prose).min(2),
}).strict();

const noulTaskSchema = z.object({
  ...taskFields,
  type: z.literal(decisionTypes.noul),
  criteria: z.object({ true: prose.optional(), false: prose.optional() }).strict().optional(),
}).strict();

const typedTaskSchema = z.discriminatedUnion('type', [typedChoiceTaskSchema, scoreTaskSchema, noulTaskSchema]);

export const taskSchema = z.union([legacyChoiceTaskSchema, typedTaskSchema]).transform((task) => (
  'type' in task ? task : { ...task, type: 'choice' as const }
));

export type StudyTask = z.output<typeof taskSchema>;
export type StudyTaskInput = z.input<typeof taskSchema>;
