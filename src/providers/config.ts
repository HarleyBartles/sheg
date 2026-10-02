import { z } from 'zod';
import { jevConfigInputSchema, jevConfigSchema } from './jev/config.js';

const layaConfigSchema = z.object({
  kind: z.literal('laya'),
  baseUrl: z.string().url(),
  checkpoint: z.string().min(1),
  contextLimit: z.number().int().positive(),
  headLimit: z.number().int().positive(),
  tokenizerJsonPath: z.string().min(1),
  tokenizerSha256: z.string().regex(/^[a-f\d]{64}$/i),
  precision: z.string().optional(),
  timeoutMs: z.number().int().positive(),
}).strict();

export const providerConfigSchema = z.union([
  jevConfigInputSchema.transform((input) => jevConfigSchema.parse(input)),
  layaConfigSchema,
]);

export type ProviderConfigInput = z.input<typeof providerConfigSchema>;
export type ProviderConfig = z.output<typeof providerConfigSchema>;
