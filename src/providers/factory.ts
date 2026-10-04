import { CredentialStoreError, WindowsCredentialStore } from '../infrastructure/credentials/windows.js';
import type { DecisionProvider } from '../domain/decision/provider.js';
import type { ProviderConfigInput } from './config.js';
import { JevProvider } from './jev.js';
import { LayaProvider } from './laya.js';
import { createControlledWorkflowProvider, isControlledWorkflowTestEnabled } from '../testing/controlled-workflow-provider.js';

export function createProvider(config: ProviderConfigInput): DecisionProvider {
  if (config.kind === 'jev') {
    if (isControlledWorkflowTestEnabled()) {
      if ((config.route ?? 'openrouter') !== 'typesafe' || config.model !== 'jev-latest') throw new Error('Controlled recovery provider only accepts its frozen TypeSafe fixture request.');
      return createControlledWorkflowProvider();
    }
    return new JevProvider(config);
  }
  return new LayaProvider({
    kind: 'laya', baseUrl: config.baseUrl, checkpoint: config.checkpoint,
    contextLimit: config.contextLimit, headLimit: config.headLimit,
    tokenizerJsonPath: config.tokenizerJsonPath, tokenizerSha256: config.tokenizerSha256,
    timeoutMs: config.timeoutMs, ...(config.precision === undefined ? {} : { precision: config.precision }),
  });
}

export async function assertProviderReady(config: ProviderConfigInput, credentials = new WindowsCredentialStore()): Promise<void> {
  if (config.kind !== 'jev') return;
  const route = config.route ?? 'openrouter';
  const state = await credentials.availability(route);
  if (state === 'malformed') throw new CredentialStoreError('credential_malformed', route);
  if (state === 'missing') throw new CredentialStoreError('credential_missing', route);
  if (state === 'unavailable') throw new CredentialStoreError('credential_unavailable', route);
}
