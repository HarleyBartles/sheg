import { z } from 'zod';
import { providerKinds } from '../domain/decision/provider.js';
import { jevConfigInputSchema, jevConfigSchema } from './jev/config.js';

const layaConfigSchema = z.object({
  kind: z.literal(providerKinds[1]),
  baseUrl: z.string().url(),
  checkpoint: z.string().min(1),
  contextLimit: z.number().int().positive(),
  headLimit: z.number().int().positive(),
  tokenizerJsonPath: z.string().min(1),
  tokenizerSha256: z.string().regex(/^[a-f\d]{64}$/i),
  precision: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive(),
}).strict();

const clefConfigSchema = z.object({
  kind: z.literal('clef'),
  accountId: z.string().regex(/^[a-f0-9]{32}$/),
  model: z.enum(['clef', 'clef-flash']).default('clef'),
  timeoutMs: z.number().int().positive().default(30_000),
}).strict();

export const providerConfigSchema = z.union([
  jevConfigInputSchema.transform((input) => jevConfigSchema.parse(input)),
  layaConfigSchema,
  clefConfigSchema,
]);

export type ProviderConfigInput = z.input<typeof providerConfigSchema>;
export type ProviderConfig = z.output<typeof providerConfigSchema>;
