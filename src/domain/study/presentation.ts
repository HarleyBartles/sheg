import { z } from 'zod';

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

const nodeSchema = z.discriminatedUnion('kind', [
  z.object({ id: identifier, kind: z.literal('expose'), itemId: identifier }).strict(),
  z.object({ id: identifier, kind: z.literal('ask'), taskId: identifier }).strict(),
  z.object({ id: identifier, kind: z.literal('terminal'), outcome: identifier }).strict(),
]);

const transitionSchema = z.object({
  fromNodeId: identifier,
  optionId: identifier.optional(),
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
