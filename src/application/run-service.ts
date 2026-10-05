import path from 'node:path';
import type { DecisionProvider } from '../domain/decision/provider.js';
import type { AnswerRow, JourneyRunRecord, Page, RunAttempt, RunContextDetail, RunStatusView } from '../domain/run/lifecycle.js';
import { resumeRefusalMessage } from '../domain/run/lifecycle.js';
import type { PreparedRun, RunRequest } from '../domain/run/request.js';
import { followOnRunRequestSchema, runEvidenceQuerySchema, runRequestSchema } from '../domain/run/request.js';
import type { ProviderConfigInput } from '../providers/config.js';
import type { DeletePreview, DeleteResult, RunCommandRepository, RunListQuery, RunPersistence, StorageInfo } from './run-store.js';
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
  list(query: RunListQuery): Page<RunStatusView>;
  queryEvidence(query: import('../domain/run/request.js').RunEvidenceQuery): import('../domain/run/request.js').RunEvidencePage;
  getContext(runId: string, evaluationId: string, contextId: string): RunContextDetail;
  getStatus(runId: string): RunStatusView;
  getRequest(runId: string): PreparedRun | JourneyRunRecord;
  getJourneyRun(runId: string): JourneyRunRecord;
  answers(runId: string, cursor?: string, limit?: number): Page<AnswerRow>;
  attempts(runId: string, cursor?: string, limit?: number): Page<RunAttempt>;
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
  persistence: RunPersistence,
  dataRoot: string,
  providerFactory: ProviderFactory,
  launcher: WorkerLauncher,
  options: RunServiceOptions = {},
): RunService {
  const { reads, commands } = persistence;
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
        commands.reconcile(followOn.sourceRunId, Date.now());
        const source = reads.resolveFollowOnSources(followOn);
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
    const prior = reads.findSubmission(submissionId, requestFingerprint);
    if (prior) { commands.reconcile(prior.runId, Date.now()); return reads.getStatus(prior.runId); }

    await assertReady(request.provider);
    let accepted: ReturnType<RunCommandRepository['accept']>;
    if (request.kind === 'follow-on') {
      try {
        const followOn = followOnRunRequestSchema.parse(request);
        commands.reconcile(followOn.sourceRunId, Date.now());
        const source = reads.resolveFollowOnSources(followOn);
        const admission = await prepareFollowOnRun(followOn, source, providerFactory(followOn.provider));
        if (!admission.inspection.valid) throw new RunServiceError('admission_failed', admission.inspection.problems.map(({ message }) => message).join('; ') || 'Request did not pass provider fit admission.');
        accepted = commands.accept(submissionId, admission.prepared);
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
        ? commands.accept(submissionId, admission.prepared)
        : commands.acceptJourney(submissionId, materializeJourneyRun(admission.journey!));
    }
    if (!accepted.created) return accepted.run;
    try { await launcher.launch(dataRoot, accepted.run.runId); }
    catch { commands.failLaunch(accepted.run.runId, 'worker_launch_failed'); }
    return reads.getStatus(accepted.run.runId);
  }

  async function resume(runId: string): Promise<RunStatusView> {
    commands.reconcile(runId, Date.now());
    const current = reads.getStatus(runId);
    if (current.status === 'prepared') return current;
    if (!current.lifecycle.resume.eligible) {
      throw new RunServiceError('run_not_resumable', resumeRefusalMessage(current.lifecycle.resume.reason));
    }
    const frozenProvider = reads.getRequestKind(runId) === 'journey'
      ? reads.getJourneyRun(runId).request.provider
      : reads.getRequest(runId).request.provider;
    await assertReady(frozenProvider);
    const resumed = commands.resume(runId, Date.now());
    if (resumed.started) {
      try { await launcher.launch(dataRoot, runId); }
      catch { commands.failLaunch(runId, 'worker_launch_failed'); }
    }
    return reads.getStatus(runId);
  }

  return {
    inspect,
    start,
    resume,
    previewDelete: (runIds) => { commands.reconcileMany(runIds, Date.now()); return reads.previewDelete(runIds); },
    deleteRuns: (runIds) => commands.deleteRuns(runIds),
    storageInfo: () => { commands.reconcileActive(Date.now()); return reads.storageInfo(); },
    optimizeStorage: () => commands.optimizeStorage(),
    list: (query) => { commands.reconcileActive(Date.now()); return reads.list(query); },
    queryEvidence: (query) => { const parsed = runEvidenceQuerySchema.parse(query); commands.reconcile(parsed.sourceRunId, Date.now()); return reads.queryEvidence(parsed); },
    getContext: (runId, evaluationId, contextId) => reads.getContext(runId, evaluationId, contextId),
    getStatus: (runId) => { commands.reconcile(runId, Date.now()); return reads.getStatus(runId); },
    getRequest: (runId) => reads.getRequestKind(runId) === 'journey' ? reads.getJourneyRun(runId) : reads.getRequest(runId),
    getJourneyRun: (runId) => reads.getJourneyRun(runId),
    answers: (runId, cursor, limit) => { commands.reconcile(runId, Date.now()); return reads.answers(runId, cursor, limit); },
    attempts: (runId, cursor, limit) => { commands.reconcile(runId, Date.now()); return reads.attempts(runId, cursor, limit); },
    cancel: (runId) => commands.requestCancel(runId),
  };
}
