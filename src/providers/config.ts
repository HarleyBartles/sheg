import { z } from 'zod';
import { providerKinds } from '../domain/decision/provider.js';
import { jevConfigInputSchema, jevConfigSchema } from './jev/config.js';
import { clefConfigSchema, type ClefImageResolver } from './clef/config.js';

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

export const providerConfigSchema = z.union([
  jevConfigInputSchema.transform((input) => jevConfigSchema.parse(input)),
  layaConfigSchema,
  clefConfigSchema,
]);

export type ProviderConfigInput = z.input<typeof providerConfigSchema>;
export type ProviderConfig = z.output<typeof providerConfigSchema>;
export type ProviderFactoryOptions = { imageResolver?: ClefImageResolver };

export const providerCapabilitySchema = z.enum(['text', 'pixels']);
export const providerQuestionTypeSchema = z.enum(['choice', 'score', 'noul']);
const providerPriceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('no-provider-invoice') }).strict(),
  z.object({
    kind: z.literal('published-rate'),
    currency: z.string().regex(/^[A-Z]{3}$/),
    unit: z.literal('million-input-tokens'),
    amount: z.number().finite().nonnegative(),
    source: z.string().url(),
    observedAt: z.string().date(),
  }).strict(),
  z.object({ kind: z.literal('unknown') }).strict(),
]);

export const providerCatalogueEntrySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  enabled: z.boolean(),
  provider: providerConfigSchema,
  execution: z.enum(['local', 'hosted']),
  capabilities: z.array(providerCapabilitySchema).min(1),
  questionTypes: z.array(providerQuestionTypeSchema).min(1),
  pricing: providerPriceSchema,
}).strict().superRefine((entry, context) => {
  if (new Set(entry.capabilities).size !== entry.capabilities.length) context.addIssue({ code: 'custom', path: ['capabilities'], message: 'Provider capabilities must be unique.' });
  if (new Set(entry.questionTypes).size !== entry.questionTypes.length) context.addIssue({ code: 'custom', path: ['questionTypes'], message: 'Provider question types must be unique.' });
  if ((entry.provider.kind === 'laya') !== (entry.execution === 'local')) context.addIssue({ code: 'custom', path: ['execution'], message: 'Execution mode must match the provider configuration.' });
  if ((entry.provider.kind === 'clef') !== entry.capabilities.includes('pixels')) context.addIssue({ code: 'custom', path: ['capabilities'], message: 'Pixel capability must match the Clef provider configuration.' });
  if (entry.execution === 'local' && entry.pricing.kind !== 'no-provider-invoice') context.addIssue({ code: 'custom', path: ['pricing'], message: 'Local providers must declare that no provider invoice applies.' });
  if (entry.execution === 'hosted' && entry.pricing.kind === 'no-provider-invoice') context.addIssue({ code: 'custom', path: ['pricing'], message: 'Hosted providers require published or unknown price evidence.' });
});

export const providerCatalogueSchema = z.object({
  revision: z.number().int().nonnegative(),
  entries: z.array(providerCatalogueEntrySchema),
}).strict().superRefine((catalogue, context) => {
  const ids = new Set<string>();
  const configs = new Set<string>();
  catalogue.entries.forEach((entry, index) => {
    if (ids.has(entry.id)) context.addIssue({ code: 'custom', path: ['entries', index, 'id'], message: `Duplicate provider identity ${entry.id}.` });
    ids.add(entry.id);
    const canonicalConfig = JSON.stringify(entry.provider, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
      : value);
    if (configs.has(canonicalConfig)) context.addIssue({ code: 'custom', path: ['entries', index, 'provider'], message: 'Provider configuration is already present under another identity.' });
    configs.add(canonicalConfig);
  });
});

export const providerPreferenceSchema = z.object({
  preferredOrder: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)),
}).strict().superRefine((preferences, context) => {
  if (new Set(preferences.preferredOrder).size !== preferences.preferredOrder.length) context.addIssue({ code: 'custom', path: ['preferredOrder'], message: 'Provider preference identities must be unique.' });
});

export type ProviderCatalogue = z.infer<typeof providerCatalogueSchema>;
export type ProviderCatalogueEntry = z.infer<typeof providerCatalogueEntrySchema>;
export type ProviderPreference = z.infer<typeof providerPreferenceSchema>;

export function providerModelIdentity(provider: ProviderConfig): string {
  return provider.kind === 'laya' ? provider.checkpoint : provider.model;
}

export function providerConfigurationIdentity(provider: ProviderConfig): string {
  const configuration = { ...provider } as Record<string, unknown>;
  delete configuration.model;
  delete configuration.checkpoint;
  return JSON.stringify(configuration);
}
