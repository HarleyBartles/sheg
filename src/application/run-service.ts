import path from 'node:path';
import type { DecisionProvider } from '../domain/decision/provider.js';
import type { AnswerRow, JourneyRunRecord, Page, RunAttempt, RunContextDetail, RunStatusView, ProviderSelectionPolicySnapshot } from '../domain/run/lifecycle.js';
import { resumeRefusalMessage } from '../domain/run/lifecycle.js';
import type { ParsedRunRequest, PreparedRun, RunRequest } from '../domain/run/request.js';
import { followOnRunRequestSchema, requireExplicitProvider, runEvidenceQuerySchema, runRequestSchema } from '../domain/run/request.js';
import type { ProviderConfigInput, ProviderFactoryOptions } from '../providers/config.js';
import type { DeletePreview, DeleteResult, RunCommandRepository, RunListQuery, RunPersistence, StorageInfo } from './run-store.js';
import { fingerprintRunRequest, materializeJourneyRun, prepareFollowOnRun, prepareRun } from './run-inspection.js';
import { providerSelectionFingerprint } from './provider-selection-fingerprint.js';

export class RunServiceError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RunServiceError';
  }
}

export interface WorkerLauncher { launch(dataRoot: string, runId: string): Promise<void> }
export type ProviderFactory = (config: ProviderConfigInput, options?: ProviderFactoryOptions) => DecisionProvider;
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

function normalizeRequest(input: unknown): ParsedRunRequest {
  const parsed = runRequestSchema.safeParse(input);
  if (!parsed.success) throw new RunServiceError('invalid_request', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  if (parsed.data.provider?.kind === 'laya') {
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
  function selectionSnapshot(request: ParsedRunRequest): ProviderSelectionPolicySnapshot {
    const settings = reads.getProviderSettings();
    return { version: 1, catalogueRevision: settings.catalogue.revision, catalogue: { entries: settings.catalogue.entries },
      preferences: settings.preferences, policy: { batching: request.providerSelection?.batching ?? 'automatic' } };
  }
  async function assertReady(provider: ProviderConfigInput): Promise<void> {
    try { await options.assertProviderReady?.(provider); }
    catch (error) {
      if (error instanceof RunServiceError) throw error;
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      if (code === 'credential_malformed' || code === 'credential_missing' || code === 'credential_unavailable') {
        const mapped = code === 'credential_malformed' ? 'provider_credential_malformed' : code === 'credential_missing' ? 'provider_credential_missing' : 'provider_credential_unavailable';
        throw new RunServiceError(mapped, error instanceof Error ? error.message : 'Provider credential is unavailable.', { cause: error });
      }
      throw new RunServiceError('provider_credential_unavailable', 'Provider credential is unavailable.', { cause: error });
    }
  }

  async function inspect(input: unknown) {
    let request: ParsedRunRequest;
    try { request = normalizeRequest(input); }
    catch (error) {
      return { valid: false, respondentCount: 0, minimumCalls: 0, problems: [{ code: 'invalid_request', message: error instanceof Error ? error.message : 'Request is invalid.' }], fits: [] };
    }
    const snapshot = request.providerSelection ? selectionSnapshot(request) : undefined;
    const selectionFingerprint = snapshot ? providerSelectionFingerprint(request, snapshot) : undefined;
    if (request.kind === 'follow-on') {
      try {
        const followOn = followOnRunRequestSchema.parse(request);
        commands.reconcile(followOn.sourceRunId, Date.now());
        const source = reads.resolveFollowOnSources(followOn);
        const inspection = (await prepareFollowOnRun(followOn, source, providerFactory(requireExplicitProvider(followOn)))).inspection;
        return { ...inspection, ...(selectionFingerprint ? { selectionFingerprint } : {}) };
      } catch (error) {
        return { valid: false, respondentCount: 0, minimumCalls: 0, problems: [{ code: error instanceof Error && 'code' in error ? String(error.code) : 'follow_on_resolution_failed', message: error instanceof Error ? error.message : 'Follow-on request could not be resolved.' }], fits: [] };
      }
    }
    if (!request.provider && snapshot) {
      return { valid: false, respondentCount: request.respondents.length, minimumCalls: 0, problems: [{ code: 'provider_selection_not_ready', message: 'Automatic provider eligibility and fit are being resolved by the provider selection planner.' }], fits: [], ...(selectionFingerprint ? { selectionFingerprint } : {}) };
    }
    const inspection = (await prepareRun(request, providerFactory(requireExplicitProvider(request)))).inspection;
    return { ...inspection, ...(selectionFingerprint ? { selectionFingerprint } : {}) };
  }

  async function start(submissionId: string, input: RunRequest): Promise<RunStatusView> {
    if (typeof submissionId !== 'string' || !submissionId.trim()) throw new RunServiceError('invalid_submission_id', 'A submission ID is required.');
    const request = normalizeRequest(input);
    if (request.providerSelection && request.expectedSelectionFingerprint) {
      const currentFingerprint = providerSelectionFingerprint(request, selectionSnapshot(request));
      if (currentFingerprint !== request.expectedSelectionFingerprint) throw new RunServiceError('provider_selection_fingerprint_stale', 'Provider selection settings or study inputs changed after inspection. Inspect the request again before starting it.');
    }
    const requestFingerprint = fingerprintRunRequest(request);
    if (!requestFingerprint) throw new RunServiceError('invalid_request', 'Request is invalid.');
    const prior = reads.findSubmission(submissionId, requestFingerprint);
    if (prior) { commands.reconcile(prior.runId, Date.now()); return reads.getStatus(prior.runId); }

    await assertReady(requireExplicitProvider(request));
    let accepted: ReturnType<RunCommandRepository['accept']>;
    if (request.kind === 'follow-on') {
      try {
        const followOn = followOnRunRequestSchema.parse(request);
        commands.reconcile(followOn.sourceRunId, Date.now());
        const source = reads.resolveFollowOnSources(followOn);
        const admission = await prepareFollowOnRun(followOn, source, providerFactory(requireExplicitProvider(followOn)));
        if (!admission.inspection.valid) throw new RunServiceError('admission_failed', admission.inspection.problems.map(({ message }) => message).join('; ') || 'Request did not pass provider fit admission.');
        accepted = commands.accept(submissionId, admission.prepared);
      } catch (error) {
        if (error instanceof RunServiceError) throw error;
        if (error instanceof Error && 'code' in error) throw new RunServiceError(String(error.code), error.message, { cause: error });
        throw new RunServiceError('follow_on_resolution_failed', error instanceof Error ? error.message : 'Follow-on request could not be resolved.', { cause: error });
      }
    } else {
      const admission = await prepareRun(request, providerFactory(requireExplicitProvider(request)));
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
      ? requireExplicitProvider(reads.getJourneyRun(runId).request)
      : requireExplicitProvider(reads.getRequest(runId).request);
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
