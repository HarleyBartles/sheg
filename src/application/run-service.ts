import path from 'node:path';
import type { DecisionProvider } from '../domain/decision/provider.js';
import type { AnswerRow, Page, RunStatusView } from '../domain/run/lifecycle.js';
import type { PreparedRun, RunRequest } from '../domain/run/request.js';
import { followOnRunRequestSchema, runEvidenceQuerySchema, runRequestSchema } from '../domain/run/request.js';
import type { ProviderConfigInput } from '../providers/config.js';
import type { DeletePreview, DeleteResult, RunStore, StorageInfo } from '../infrastructure/run-store.js';
import { CredentialStoreError } from '../infrastructure/credentials/windows.js';
import { fingerprintRunRequest, materializeJourneyRun, prepareFollowOnRun, prepareRun } from './run-inspection.js';

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
  start(submissionId: string, input: RunRequest): Promise<RunStatusView>;
  resume(runId: string): Promise<RunStatusView>;
  previewDelete(runIds: string[]): DeletePreview;
  deleteRuns(runIds: string[]): DeleteResult;
  storageInfo(): StorageInfo;
  optimizeStorage(): void;
  list(query: import('../infrastructure/run-store.js').RunListQuery): Page<RunStatusView>;
  queryEvidence(query: import('../domain/run/request.js').RunEvidenceQuery): import('../domain/run/request.js').RunEvidencePage;
  getStatus(runId: string): RunStatusView;
  getRequest(runId: string): PreparedRun | ReturnType<RunStore['getJourneyRun']>;
  getJourneyRun(runId: string): ReturnType<RunStore['getJourneyRun']>;
  answers(runId: string, cursor?: string, limit?: number): Page<AnswerRow>;
  cancel(runId: string): RunStatusView;
}

function normalizeRequest(input: unknown): RunRequest {
  const parsed = runRequestSchema.safeParse(input);
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
  async function assertReady(provider: ProviderConfigInput): Promise<void> {
    try { await options.assertProviderReady?.(provider); }
    catch (error) {
      if (error instanceof RunServiceError) throw error;
      if (error instanceof CredentialStoreError) {
        const code = error.code === 'credential_malformed' ? 'provider_credential_malformed' : error.code === 'credential_missing' ? 'provider_credential_missing' : 'provider_credential_unavailable';
        throw new RunServiceError(code, error.message, { cause: error });
      }
      throw new RunServiceError('provider_credential_unavailable', 'Provider credential is unavailable.', { cause: error });
    }
  }

  async function inspect(input: unknown) {
    let request: RunRequest;
    try { request = normalizeRequest(input); }
    catch (error) {
      return { valid: false, respondentCount: 0, minimumCalls: 0, problems: [{ code: 'invalid_request', message: error instanceof Error ? error.message : 'Request is invalid.' }], fits: [] };
    }
    if (request.kind === 'follow-on') {
      try {
        const followOn = followOnRunRequestSchema.parse(request);
        const source = store.resolveFollowOnSources(followOn);
        return (await prepareFollowOnRun(followOn, source, providerFactory(followOn.provider))).inspection;
      } catch (error) {
        return { valid: false, respondentCount: 0, minimumCalls: 0, problems: [{ code: error instanceof Error && 'code' in error ? String(error.code) : 'follow_on_resolution_failed', message: error instanceof Error ? error.message : 'Follow-on request could not be resolved.' }], fits: [] };
      }
    }
    return (await prepareRun(request, providerFactory(request.provider))).inspection;
  }

  async function start(submissionId: string, input: RunRequest): Promise<RunStatusView> {
    if (typeof submissionId !== 'string' || !submissionId.trim()) throw new RunServiceError('invalid_submission_id', 'A submission ID is required.');
    const request = normalizeRequest(input);
    const requestFingerprint = fingerprintRunRequest(request);
    if (!requestFingerprint) throw new RunServiceError('invalid_request', 'Request is invalid.');
    const prior = store.findSubmission(submissionId, requestFingerprint);
    if (prior) return prior;

    await assertReady(request.provider);
    let accepted: ReturnType<RunStore['accept']>;
    if (request.kind === 'follow-on') {
      try {
        const followOn = followOnRunRequestSchema.parse(request);
        const source = store.resolveFollowOnSources(followOn);
        const admission = await prepareFollowOnRun(followOn, source, providerFactory(followOn.provider));
        if (!admission.inspection.valid) throw new RunServiceError('admission_failed', admission.inspection.problems.map(({ message }) => message).join('; ') || 'Request did not pass provider fit admission.');
        accepted = store.accept(submissionId, admission.prepared);
      } catch (error) {
        if (error instanceof RunServiceError) throw error;
        if (error instanceof Error && 'code' in error) throw new RunServiceError(String(error.code), error.message, { cause: error });
        throw new RunServiceError('follow_on_resolution_failed', error instanceof Error ? error.message : 'Follow-on request could not be resolved.', { cause: error });
      }
    } else {
      const admission = await prepareRun(request, providerFactory(request.provider));
      if ((!admission.prepared && !admission.journey) || !admission.inspection.valid) {
        throw new RunServiceError('admission_failed', admission.inspection.problems.map(({ message }) => message).join('; ') || 'Request did not pass provider fit admission.');
      }
      accepted = admission.prepared
        ? store.accept(submissionId, admission.prepared)
        : store.acceptJourney(submissionId, materializeJourneyRun(admission.journey!));
    }
    if (!accepted.created) return accepted.run;
    try { await launcher.launch(dataRoot, accepted.run.runId); }
    catch { store.failLaunch(accepted.run.runId, 'worker_launch_failed'); }
    return store.getStatus(accepted.run.runId);
  }

  async function resume(runId: string): Promise<RunStatusView> {
    const current = store.getStatus(runId);
    if (current.status === 'prepared') return current;
    const retryablePartial = current.status === 'partial' && current.failedEvaluations > 0 && store.getRequestKind(runId) !== 'journey';
    if (current.status !== 'interrupted' && current.status !== 'failed' && !retryablePartial) {
      throw new RunServiceError('run_not_resumable', `A run in ${current.status} state cannot be resumed.`);
    }
    if (current.cancelRequested) throw new RunServiceError('run_not_resumable', 'A run with a cancellation request cannot be resumed.');
    if (current.usedCalls + current.reservedCalls >= current.maxCalls) throw new RunServiceError('run_not_resumable', 'This run has no remaining provider-call allowance.');
    const frozenProvider = store.getRequestKind(runId) === 'journey'
      ? store.getJourneyRun(runId).request.provider
      : store.getRequest(runId).request.provider;
    await assertReady(frozenProvider);
    const resumed = store.resume(runId, Date.now());
    if (resumed.started) {
      try { await launcher.launch(dataRoot, runId); }
      catch { store.failLaunch(runId, 'worker_launch_failed'); }
    }
    return store.getStatus(runId);
  }

  return {
    inspect,
    start,
    resume,
    previewDelete: (runIds) => store.previewDelete(runIds),
    deleteRuns: (runIds) => store.deleteRuns(runIds),
    storageInfo: () => store.storageInfo(),
    optimizeStorage: () => store.optimizeStorage(),
    list: (query) => store.list(query),
    queryEvidence: (query) => store.queryEvidence(runEvidenceQuerySchema.parse(query)),
    getStatus: (runId) => store.reconcile(runId, Date.now()),
    getRequest: (runId) => store.getRequestKind(runId) === 'journey' ? store.getJourneyRun(runId) : store.getRequest(runId),
    getJourneyRun: (runId) => store.getJourneyRun(runId),
    answers: (runId, cursor, limit) => { store.reconcile(runId, Date.now()); return store.answers(runId, cursor, limit); },
    cancel: (runId) => store.requestCancel(runId),
  };
}

