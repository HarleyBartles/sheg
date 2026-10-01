import path from 'node:path';
import type { DecisionProvider } from '../domain/decision/provider.js';
import type { AnswerRow, Page, RunStatusView } from '../domain/run/lifecycle.js';
import type { InlineRunRequest, PreparedRun } from '../domain/run/request.js';
import { inlineRunRequestSchema } from '../domain/run/request.js';
import type { ProviderConfigInput } from '../providers/config.js';
import type { RunStore } from '../infrastructure/run-store.js';
import { CredentialStoreError } from '../infrastructure/credentials/windows.js';
import { fingerprintRunRequest, prepareRun } from './run-inspection.js';

export class RunServiceError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RunServiceError';
  }
}

export interface WorkerLauncher { launch(dataRoot: string, runId: string): Promise<void> }
export type ProviderFactory = (config: ProviderConfigInput) => DecisionProvider;
export type RunServiceOptions = { assertProviderReady?: (config: ProviderConfigInput) => Promise<void> };

export interface RunService {
  inspect(input: unknown): Promise<Awaited<ReturnType<typeof prepareRun>>['inspection']>;
  start(submissionId: string, input: InlineRunRequest): Promise<RunStatusView>;
  list(query: import('../infrastructure/run-store.js').RunListQuery): Page<RunStatusView>;
  getStatus(runId: string): RunStatusView;
  getRequest(runId: string): PreparedRun;
  answers(runId: string, cursor?: string, limit?: number): Page<AnswerRow>;
  cancel(runId: string): RunStatusView;
}

function normalizeRequest(input: unknown): InlineRunRequest {
  const parsed = inlineRunRequestSchema.safeParse(input);
  if (!parsed.success) throw new RunServiceError('invalid_request', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  if (parsed.data.provider.kind === 'laya') {
    return { ...parsed.data, provider: { ...parsed.data.provider, tokenizerJsonPath: path.resolve(parsed.data.provider.tokenizerJsonPath) } };
  }
  return parsed.data;
}

export function createRunService(
  store: RunStore,
  dataRoot: string,
  providerFactory: ProviderFactory,
  launcher: WorkerLauncher,
  options: RunServiceOptions = {},
): RunService {
  async function inspect(input: unknown) {
    let request: InlineRunRequest;
    try { request = normalizeRequest(input); }
    catch (error) {
      return { valid: false, respondentCount: 0, minimumCalls: 0, problems: [{ code: 'invalid_request', message: error instanceof Error ? error.message : 'Request is invalid.' }], fits: [] };
    }
    return (await prepareRun(request, providerFactory(request.provider))).inspection;
  }

  async function start(submissionId: string, input: InlineRunRequest): Promise<RunStatusView> {
    if (typeof submissionId !== 'string' || !submissionId.trim()) throw new RunServiceError('invalid_submission_id', 'A submission ID is required.');
    const request = normalizeRequest(input);
    const requestFingerprint = fingerprintRunRequest(request);
    if (!requestFingerprint) throw new RunServiceError('invalid_request', 'Request is invalid.');
    const prior = store.findSubmission(submissionId, requestFingerprint);
    if (prior) return prior;

    try { await options.assertProviderReady?.(request.provider); }
    catch (error) {
      if (error instanceof RunServiceError) throw error;
      if (error instanceof CredentialStoreError) {
        const code = error.code === 'credential_malformed' ? 'provider_credential_malformed' : error.code === 'credential_missing' ? 'provider_credential_missing' : 'provider_credential_unavailable';
        throw new RunServiceError(code, error.message, { cause: error });
      }
      throw new RunServiceError('provider_credential_unavailable', 'Provider credential is unavailable.', { cause: error });
    }
    const admission = await prepareRun(request, providerFactory(request.provider));
    if (!admission.prepared || !admission.inspection.valid) {
      throw new RunServiceError('admission_failed', admission.inspection.problems.map(({ message }) => message).join('; ') || 'Request did not pass provider fit admission.');
    }
    const accepted = store.accept(submissionId, admission.prepared);
    if (!accepted.created) return accepted.run;
    try { await launcher.launch(dataRoot, accepted.run.runId); }
    catch { store.failLaunch(accepted.run.runId, 'worker_launch_failed'); }
    return store.getStatus(accepted.run.runId);
  }

  return {
    inspect,
    start,
    list: (query) => store.list(query),
    getStatus: (runId) => store.reconcile(runId, Date.now()),
    getRequest: (runId) => store.getRequest(runId),
    answers: (runId, cursor, limit) => { store.reconcile(runId, Date.now()); return store.answers(runId, cursor, limit); },
    cancel: (runId) => store.requestCancel(runId),
  };
}

