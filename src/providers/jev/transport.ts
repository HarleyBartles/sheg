import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';
import type { JevConfig } from './config.js';
import { jevMetadata } from './model-metadata.js';
import { CredentialStoreError, type WindowsCredentialStore } from '../../infrastructure/credentials/windows.js';

const wireUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  cost: z.number().finite().nonnegative().optional(),
}).passthrough();
const nativeWireUsageSchema = wireUsageSchema.extend({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});
const wireResponseSchema = z.object({ model: z.string().min(1), answers: z.record(z.string(), z.unknown()), usage: wireUsageSchema }).passthrough();
const nativeWireResponseSchema = wireResponseSchema.extend({ usage: nativeWireUsageSchema });
const retryableStatuses = new Set([429, 500, 502, 503, 524, 529]);

export type JevWireResponse = z.infer<typeof wireResponseSchema>;
export type JevExecutionMetadata = {
  attempts: number;
  provider: 'jev';
  model: string;
  latencyMs: number;
  usage: { inputTokens?: number; outputTokens?: number };
  cost?: { amountUsd: number; basis: 'provider-reported' | 'published-rate-estimate' };
};

export class JevTransportError extends Error {
  constructor(message: string, readonly attempts: number, readonly scope: 'evaluation' | 'run', readonly code: string, readonly category: 'credential' | 'transport' | 'http' | 'envelope', readonly httpStatus?: number) {
    super(message);
    this.name = 'JevTransportError';
  }
}

export async function executeJevTransport(input: {
  config: JevConfig;
  credentialStore: Pick<WindowsCredentialStore, 'readForAuthentication'>;
  fetchRequest: typeof fetch;
  body: string;
  maxAttempts: number;
}): Promise<{ response: JevWireResponse; execution: JevExecutionMetadata }> {
  let apiKey: string;
  try { apiKey = await input.credentialStore.readForAuthentication(input.config.route); }
  catch (error) {
    if (error instanceof CredentialStoreError) {
      throw new JevTransportError(error.message, 0, 'run', error.code, 'credential');
    }
    throw new JevTransportError(`The ${input.config.route} secure credential is unavailable.`, 0, 'run', 'credential_unavailable', 'credential');
  }

  const startedAt = performance.now();
  for (let attempts = 1; attempts <= input.maxAttempts; attempts += 1) {
    let response: Response;
    try {
      response = await input.fetchRequest(input.config.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: input.body,
        signal: AbortSignal.timeout(input.config.timeoutMs),
      });
    } catch {
      if (attempts < input.maxAttempts) { await wait(retryDelayMs(attempts)); continue; }
      throw new JevTransportError('Jev request failed at the transport boundary.', attempts, 'evaluation', 'provider_unavailable', 'transport');
    }
    if (!response.ok) {
      if (retryableStatuses.has(response.status) && attempts < input.maxAttempts) { await wait(retryDelayMs(attempts)); continue; }
      throw new JevTransportError(`Jev request failed with HTTP ${response.status}.`, attempts,
        response.status === 401 || response.status === 403 ? 'run' : 'evaluation', 'provider_unavailable', 'http', response.status);
    }

    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new JevTransportError('Jev returned an unreadable response.', attempts, 'evaluation', 'provider_unavailable', 'envelope'); }
    const parsed = (input.config.route === 'typesafe' ? nativeWireResponseSchema : wireResponseSchema).safeParse(payload);
    if (!parsed.success) throw new JevTransportError('Jev response is missing required identity or usage fields.', attempts, 'evaluation', 'provider_unavailable', 'envelope');

    const { model, usage } = parsed.data;
    const metadata = jevMetadata(input.config.route, model);
    const estimatedAmount = usage.input_tokens !== undefined && usage.output_tokens !== undefined && metadata?.inputUsdPerMillion !== undefined && metadata.outputUsdPerMillion !== undefined
      ? (usage.input_tokens * metadata.inputUsdPerMillion + usage.output_tokens * metadata.outputUsdPerMillion) / 1_000_000
      : undefined;
    return {
      response: parsed.data,
      execution: {
        attempts, provider: 'jev', model, latencyMs: performance.now() - startedAt,
        usage: { ...(usage.input_tokens === undefined ? {} : { inputTokens: usage.input_tokens }), ...(usage.output_tokens === undefined ? {} : { outputTokens: usage.output_tokens }) },
        ...(usage.cost !== undefined ? { cost: { amountUsd: usage.cost, basis: 'provider-reported' as const } } : estimatedAmount === undefined ? {} : { cost: { amountUsd: estimatedAmount, basis: 'published-rate-estimate' as const } }),
      },
    };
  }
  throw new JevTransportError('Jev call limit reached without a response.', input.maxAttempts, 'evaluation', 'provider_unavailable', 'transport');
}

function retryDelayMs(attempt: number): number {
  return Math.min(50 * 2 ** (attempt - 1), 1_000);
}
