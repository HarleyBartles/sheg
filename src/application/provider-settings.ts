import { z } from 'zod';
import { providerCatalogueEntrySchema, providerPreferenceSchema } from '../providers/config.js';

const providerSettingsWriteSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  catalogue: z.object({ entries: z.array(providerCatalogueEntrySchema) }).strict(),
  preferences: providerPreferenceSchema,
}).strict();

export const providerSettingsOperationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('get') }).strict(),
  z.object({ operation: z.literal('set'), ...providerSettingsWriteSchema.shape }).strict(),
]);
export type ProviderSettingsOperation = z.infer<typeof providerSettingsOperationSchema>;
