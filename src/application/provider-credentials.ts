import { z } from 'zod';
import { WindowsCredentialStore, type CredentialRoute } from '../infrastructure/credentials/windows.js';

export const providerCredentialRequestSchema = z.object({
  route: z.enum(['typesafe', 'openrouter', 'clef']),
  operation: z.enum(['status', 'setup', 'remove']),
}).strict();
export type ProviderCredentialRequest = z.infer<typeof providerCredentialRequestSchema>;
export type ProviderCredentialStore = Pick<WindowsCredentialStore, 'availability' | 'setup' | 'remove'>;

export class ProviderCredentialOperationError extends Error {
  readonly code = 'credential_operation_failed';
  constructor() { super('The provider credential operation could not be completed.'); this.name = 'ProviderCredentialOperationError'; }
}

export async function manageProviderCredential(input: ProviderCredentialRequest, store: ProviderCredentialStore = new WindowsCredentialStore()): Promise<{
  route: CredentialRoute; operation: ProviderCredentialRequest['operation']; availability: Awaited<ReturnType<WindowsCredentialStore['availability']>>;
}> {
  const request = providerCredentialRequestSchema.parse(input);
  try {
    if (request.operation === 'setup') await store.setup(request.route);
    else if (request.operation === 'remove') await store.remove(request.route);
    return { route: request.route, operation: request.operation, availability: await store.availability(request.route) };
  } catch {
    throw new ProviderCredentialOperationError();
  }
}
