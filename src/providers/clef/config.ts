import { z } from 'zod';
import type { ImageMetadata } from '../../domain/assets/image.js';

export const clefConfigSchema = z.object({
  kind: z.literal('clef'),
  accountId: z.string().regex(/^[a-f0-9]{32}$/),
  model: z.enum(['clef', 'clef-flash']).default('clef'),
  timeoutMs: z.number().int().positive().default(30_000),
}).strict();

export type ClefConfigInput = z.input<typeof clefConfigSchema>;
export type ClefConfig = z.output<typeof clefConfigSchema>;
export type ClefResolvedImage = { metadata: ImageMetadata; bytes: Uint8Array };
export type ClefImageResolver = { resolve(assetId: string): ClefResolvedImage };
export type ClefCredentialStore = { readForAuthentication(route: 'clef'): Promise<string> };

export function clefEndpoint(config: Pick<ClefConfig, 'accountId' | 'model'>): string {
  return `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/run/@cf/cloudflare/${config.model}`;
}
