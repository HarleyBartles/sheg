import { z } from 'zod';

export const resetConfirmation = 'RESET SHEG DATASTORE';
export const runStorageSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('inspect') }).strict(),
  z.object({ operation: z.literal('optimize') }).strict(),
  z.object({ operation: z.literal('reset'), confirmation: z.literal(resetConfirmation) }).strict(),
]);
export const runDeleteSchema = z.object({ runIds: z.array(z.string().uuid()).min(1).max(200).refine((ids) => new Set(ids).size === ids.length, 'Run IDs must be unique.'), dryRun: z.boolean().default(false) }).strict();
export const runGetSchema = z.discriminatedUnion('view', [
  z.object({ runId: z.string().uuid(), view: z.literal('status') }).strict(),
  z.object({ runId: z.string().uuid(), view: z.literal('request') }).strict(),
  z.object({ runId: z.string().uuid(), view: z.literal('journey') }).strict(),
  z.object({ runId: z.string().uuid(), view: z.literal('context'), evaluationId: z.string().uuid(), contextId: z.string().uuid() }).strict(),
  z.object({ runId: z.string().uuid(), view: z.literal('answers'), cursor: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
  z.object({ runId: z.string().uuid(), view: z.literal('attempts'), cursor: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
]);

export type StorageOperation = z.infer<typeof runStorageSchema>;
