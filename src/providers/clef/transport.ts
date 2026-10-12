import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';
import { ProviderCallError } from '../../domain/decision/provider-failure.js';
import { CredentialStoreError, type WindowsCredentialStore } from '../../infrastructure/credentials/windows.js';
import { clefEndpoint, type ClefConfig } from './config.js';

const usageSchema = z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative().optional() }).passthrough();
const resultSchema = z.object({ model: z.string().min(1), answers: z.record(z.string(), z.unknown()), usage: usageSchema }).passthrough();
const responseSchema = z.object({ success: z.literal(true), result: resultSchema }).passthrough();
const retryableStatuses = new Set([429, 500, 502, 503, 524, 529]);

export type ClefWireResult = z.infer<typeof resultSchema>;
export type ClefExecutionMetadata = { attempts: number; provider: 'clef'; model: string; latencyMs: number; usage: { inputTokens: number; outputTokens?: number } };

export async function executeClefTransport(input: {
  config: ClefConfig;
  credentialStore: Pick<WindowsCredentialStore, 'readForAuthentication'>;
  fetchRequest: typeof fetch;
  body: string;
  maxAttempts: number;
}): Promise<{ response: ClefWireResult; execution: ClefExecutionMetadata }> {
  let token: string;
  try { token = await input.credentialStore.readForAuthentication('clef'); }
  catch (error) {
    const credential = error instanceof CredentialStoreError ? error : new CredentialStoreError('credential_unavailable', 'clef');
    throw new ProviderCallError(credential.message, { attempts: 0, scope: 'run', code: credential.code, category: 'credential' });
  }
  const startedAt = performance.now();
  for (let attempts = 1; attempts <= input.maxAttempts; attempts += 1) {
    let response: Response;
    try {
      response = await input.fetchRequest(clefEndpoint(input.config), { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: input.body, signal: AbortSignal.timeout(input.config.timeoutMs) });
    } catch {
      if (attempts < input.maxAttempts) { await wait(Math.min(50 * 2 ** (attempts - 1), 1_000)); continue; }
      throw new ProviderCallError('Clef request failed at the transport boundary.', { attempts, scope: 'evaluation', category: 'transport' });
    }
    if (!response.ok) {
      if (retryableStatuses.has(response.status) && attempts < input.maxAttempts) { await wait(Math.min(50 * 2 ** (attempts - 1), 1_000)); continue; }
      throw new ProviderCallError(`Clef request failed with HTTP ${response.status}.`, { attempts,
        scope: response.status === 401 || response.status === 403 ? 'run' : 'evaluation', category: 'http', httpStatus: response.status });
    }
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new ProviderCallError('Clef returned unreadable response JSON.', { attempts, scope: 'run', category: 'envelope' }); }
    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success) throw new ProviderCallError('Clef returned an invalid execution envelope.', { attempts, scope: 'run', category: 'envelope' });
    const usage = parsed.data.result.usage;
    return { response: parsed.data.result, execution: { attempts, provider: 'clef', model: parsed.data.result.model, latencyMs: performance.now() - startedAt,
      usage: { inputTokens: usage.input_tokens, ...(usage.output_tokens === undefined ? {} : { outputTokens: usage.output_tokens }) } } };
  }
  throw new ProviderCallError('Clef call limit reached without a response.', { attempts: input.maxAttempts, scope: 'evaluation', category: 'transport' });
}
