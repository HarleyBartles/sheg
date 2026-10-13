import { z } from 'zod';
import { routeableDecisionTypeSchema } from '../decision/decision.js';

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const forkNodeSchema = z.object({
  id: identifier,
  kind: z.literal('fork'),
  conditions: z.array(z.object({ id: identifier, label: z.string().trim().min(1), entryNodeId: identifier }).strict()).min(2),
}).strict().superRefine((fork, context) => {
  const ids = fork.conditions.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['conditions'], message: 'Fork condition IDs must be unique within the fork.' });
});
export type ForkPresentationNode = z.output<typeof forkNodeSchema>;

const nodeSchema = z.discriminatedUnion('kind', [
  z.object({ id: identifier, kind: z.literal('expose'), itemId: identifier }).strict(),
  z.object({ id: identifier, kind: z.literal('ask'), taskId: identifier }).strict(),
  forkNodeSchema,
  z.object({ id: identifier, kind: z.literal('terminal'), outcome: identifier }).strict(),
]);

const responseIntervalSchema = z.object({
  type: routeableDecisionTypeSchema,
  minimum: z.number().finite(),
  maximum: z.number().finite(),
  minimumInclusive: z.boolean(),
  maximumInclusive: z.boolean(),
}).strict();
export type ResponseInterval = z.infer<typeof responseIntervalSchema>;

const transitionSchema = z.object({
  fromNodeId: identifier,
  optionId: identifier.optional(),
  when: responseIntervalSchema.optional(),
  toNodeId: identifier,
}).strict();

export const presentationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sequence') }).strict(),
  z.object({
    kind: z.literal('graph'),
    nodes: z.array(nodeSchema).min(1),
    transitions: z.array(transitionSchema),
    entryNodeId: identifier,
    maxDecisions: z.number().int().positive(),
  }).strict(),
]);

export type StudyPresentation = z.infer<typeof presentationSchema>;
export type PresentationTransition = Extract<StudyPresentation, { kind: 'graph' }>['transitions'][number];
