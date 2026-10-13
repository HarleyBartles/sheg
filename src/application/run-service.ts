import path from 'node:path';
import type { DecisionProvider } from '../domain/decision/provider.js';
import type { AnswerRow, JourneyRunRecord, Page, RunAttempt, RunContextDetail, RunStatusView, ProviderSelectionPolicySnapshot } from '../domain/run/lifecycle.js';
import { resumeRefusalMessage } from '../domain/run/lifecycle.js';
import type { ParsedRunRequest, PreparedRun, RunRequest } from '../domain/run/request.js';
import { followOnRunRequestSchema, requireExplicitProvider, runEvidenceQuerySchema, runRequestSchema } from '../domain/run/request.js';
import type { ProviderConfigInput, ProviderFactoryOptions } from '../providers/config.js';
import type { DeletePreview, DeleteResult, ProviderSettings, RunCommandRepository, RunListQuery, RunPersistence, StorageInfo } from './run-store.js';
import { fingerprintRunRequest, materializeJourneyRun, prepareAutomaticallySelectedJourney, prepareAutomaticallySelectedPoll, prepareFollowOnRun, prepareRun } from './run-inspection.js';
import { providerSelectionFingerprint, providerSelectionFingerprintRevision } from './provider-selection-fingerprint.js';
import { providerModelIdentity } from '../providers/config.js';
import type { ProviderBatchCandidate } from './provider-batch-planning.js';
import { providerSettingsOperationSchema } from './provider-settings.js';

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
  providerSettings(operation: unknown): ProviderSettings;
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
  function selectionSnapshot(request: ParsedRunRequest, initialChoices?: ProviderSelectionPolicySnapshot['initialChoices']): ProviderSelectionPolicySnapshot {
    const settings = reads.getProviderSettings();
    return { version: 1, catalogueRevision: settings.catalogue.revision, catalogue: { entries: settings.catalogue.entries },
      preferences: settings.preferences, policy: { batching: request.providerSelection?.batching ?? 'automatic' },
      ...(initialChoices === undefined ? {} : { initialChoices }) };
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

  async function automaticCandidates(snapshot: ProviderSelectionPolicySnapshot): Promise<ProviderBatchCandidate[]> {
    const candidates: ProviderBatchCandidate[] = [];
    for (const entry of snapshot.catalogue.entries) {
      if (!entry.enabled) continue;
      let ready = true;
      try { await assertReady(entry.provider); } catch { ready = false; }
      try {
        candidates.push({ id: entry.id, provider: providerFactory(entry.provider), providerKind: entry.provider.kind,
          modelIdentity: providerModelIdentity(entry.provider), ready });
      } catch { /* An enabled but unconstructable adapter remains an ineligible catalogue candidate. */ }
    }
    return candidates;
  }

  async function inspectAutomaticPoll(request: Extract<ParsedRunRequest, { kind: 'poll' }>, snapshot: ProviderSelectionPolicySnapshot) {
    const candidates = await automaticCandidates(snapshot);
    const admission = await prepareAutomaticallySelectedPoll(request, { catalogue: { revision: snapshot.catalogueRevision, entries: snapshot.catalogue.entries }, preferences: snapshot.preferences }, candidates);
    const frozenSnapshot = selectionSnapshot(request, admission.inspection.initialChoices);
    return { ...admission, snapshot: frozenSnapshot, fingerprint: providerSelectionFingerprint(request, frozenSnapshot) };
  }

  async function inspectAutomaticJourney(request: Extract<ParsedRunRequest, { kind: 'journey' }>, snapshot: ProviderSelectionPolicySnapshot) {
    const candidates = await automaticCandidates(snapshot);
    const admission = await prepareAutomaticallySelectedJourney(request, { catalogue: { revision: snapshot.catalogueRevision, entries: snapshot.catalogue.entries }, preferences: snapshot.preferences }, candidates);
    const frozenSnapshot = selectionSnapshot(request, admission.inspection.initialChoices);
    return { ...admission, snapshot: frozenSnapshot, fingerprint: providerSelectionFingerprint(request, frozenSnapshot) };
  }

  async function inspectAutomaticFollowOn(request: Extract<ParsedRunRequest, { kind: 'follow-on' }>, snapshot: ProviderSelectionPolicySnapshot) {
    const candidates = await automaticCandidates(snapshot);
    commands.reconcile(request.sourceRunId, Date.now());
    const source = reads.resolveFollowOnSources(request);
    const admission = await prepareFollowOnRun(request, source, undefined, { catalogue: { revision: snapshot.catalogueRevision, entries: snapshot.catalogue.entries }, preferences: snapshot.preferences, candidates });
    const fingerprintSnapshot = selectionSnapshot(request, admission.inspection.initialChoices);
    return { ...admission, snapshot: selectionSnapshot(request), fingerprint: providerSelectionFingerprint(request, fingerprintSnapshot) };
  }

  async function inspect(input: unknown) {
    let request: ParsedRunRequest;
    try { request = normalizeRequest(input); }
    catch (error) {
      return { valid: false, respondentCount: 0, minimumCalls: 0, problems: [{ code: 'invalid_request', message: error instanceof Error ? error.message : 'Request is invalid.' }], fits: [] };
    }
    const snapshot = request.providerSelection ? selectionSnapshot(request) : undefined;
    if (request.kind === 'follow-on') {
      try {
        const followOn = followOnRunRequestSchema.parse(request);
        if (!followOn.provider && snapshot) {
          const admission = await inspectAutomaticFollowOn(followOn, snapshot);
          return { ...admission.inspection, selectionFingerprint: admission.fingerprint };
        }
        commands.reconcile(followOn.sourceRunId, Date.now());
        const source = reads.resolveFollowOnSources(followOn);
        const inspection = (await prepareFollowOnRun(followOn, source, providerFactory(requireExplicitProvider(followOn)))).inspection;
        return { ...inspection, ...(snapshot ? { selectionFingerprint: providerSelectionFingerprint(request, snapshot) } : {}) };
      } catch (error) {
        return { valid: false, respondentCount: 0, minimumCalls: 0, problems: [{ code: error instanceof Error && 'code' in error ? String(error.code) : 'follow_on_resolution_failed', message: error instanceof Error ? error.message : 'Follow-on request could not be resolved.' }], fits: [] };
      }
    }
    if (!request.provider && snapshot && request.kind === 'poll') {
      const admission = await inspectAutomaticPoll(request, snapshot);
      return { ...admission.inspection, selectionFingerprint: admission.fingerprint };
    }
    if (!request.provider && snapshot && request.kind === 'journey') {
      const admission = await inspectAutomaticJourney(request, snapshot);
      return { ...admission.inspection, selectionFingerprint: admission.fingerprint };
    }
    const selectionFingerprint = snapshot ? providerSelectionFingerprint(request, snapshot) : undefined;
    if (!request.provider && snapshot) return { valid: false, respondentCount: request.kind === 'journey' ? request.respondents.length : 0, minimumCalls: 0,
      problems: [{ code: 'provider_selection_not_ready', message: 'Automatic provider selection is not yet available for this request kind.' }], fits: [],
      ...(selectionFingerprint ? { selectionFingerprint } : {}) };
    const inspection = (await prepareRun(request, providerFactory(requireExplicitProvider(request)))).inspection;
    return { ...inspection, ...(selectionFingerprint ? { selectionFingerprint } : {}) };
  }

  async function start(submissionId: string, input: RunRequest): Promise<RunStatusView> {
    if (typeof submissionId !== 'string' || !submissionId.trim()) throw new RunServiceError('invalid_submission_id', 'A submission ID is required.');
    const request = normalizeRequest(input);
    const requestFingerprint = fingerprintRunRequest(request);
    if (!requestFingerprint) throw new RunServiceError('invalid_request', 'Request is invalid.');
    const prior = reads.findSubmission(submissionId, requestFingerprint);
    if (prior) { commands.reconcile(prior.runId, Date.now()); return reads.getStatus(prior.runId); }

    const baseSnapshot = request.providerSelection ? selectionSnapshot(request) : undefined;
    const expectedRevision = request.expectedSelectionFingerprint ? providerSelectionFingerprintRevision(request.expectedSelectionFingerprint) : undefined;
    if (request.expectedSelectionFingerprint && (!baseSnapshot || expectedRevision === undefined || expectedRevision !== baseSnapshot.catalogueRevision)) {
      throw new RunServiceError('provider_selection_fingerprint_stale', 'Provider selection settings changed after inspection. Inspect the request again before starting it.');
    }
    let automaticAdmission: Awaited<ReturnType<typeof inspectAutomaticPoll>> | undefined;
    let automaticJourneyAdmission: Awaited<ReturnType<typeof inspectAutomaticJourney>> | undefined;
    let automaticFollowOnAdmission: Awaited<ReturnType<typeof inspectAutomaticFollowOn>> | undefined;
    if (!request.provider && baseSnapshot && request.kind === 'poll') {
      automaticAdmission = await inspectAutomaticPoll(request, baseSnapshot);
      if (request.expectedSelectionFingerprint && automaticAdmission.fingerprint !== request.expectedSelectionFingerprint) {
        throw new RunServiceError('provider_selection_fingerprint_stale', 'Provider selection inputs or initial choices changed after inspection. Inspect the request again before starting it.');
      }
      if (!automaticAdmission.inspection.valid || !automaticAdmission.prepared) {
        throw new RunServiceError('admission_failed', automaticAdmission.inspection.problems.map(({ message }) => message).join('; ') || 'Automatic provider admission failed.');
      }
      const selectedProviderIds = [...new Set((automaticAdmission.snapshot.initialChoices ?? []).map(({ providerId }) => providerId))];
      for (const providerId of selectedProviderIds) {
        const entry = automaticAdmission.snapshot.catalogue.entries.find(({ id }) => id === providerId);
        if (entry) await assertReady(entry.provider);
      }
    } else if (!request.provider && baseSnapshot && request.kind === 'journey') {
      automaticJourneyAdmission = await inspectAutomaticJourney(request, baseSnapshot);
      if (request.expectedSelectionFingerprint && automaticJourneyAdmission.fingerprint !== request.expectedSelectionFingerprint) {
        throw new RunServiceError('provider_selection_fingerprint_stale', 'Provider selection inputs or initial choices changed after inspection. Inspect the request again before starting it.');
      }
      if (!automaticJourneyAdmission.inspection.valid || !automaticJourneyAdmission.journey) {
        throw new RunServiceError('admission_failed', automaticJourneyAdmission.inspection.problems.map(({ message }) => message).join('; ') || 'Automatic journey provider admission failed.');
      }
      const selectedProviderIds = [...new Set((automaticJourneyAdmission.snapshot.initialChoices ?? []).map(({ providerId }) => providerId))];
      for (const providerId of selectedProviderIds) {
        const entry = automaticJourneyAdmission.snapshot.catalogue.entries.find(({ id }) => id === providerId);
        if (entry) await assertReady(entry.provider);
      }
    } else if (!request.provider && baseSnapshot && request.kind === 'follow-on') {
      automaticFollowOnAdmission = await inspectAutomaticFollowOn(followOnRunRequestSchema.parse(request), baseSnapshot);
      if (request.expectedSelectionFingerprint && automaticFollowOnAdmission.fingerprint !== request.expectedSelectionFingerprint) {
        throw new RunServiceError('provider_selection_fingerprint_stale', 'Provider selection inputs or follow-on contexts changed after inspection. Inspect the request again before starting it.');
      }
      if (!automaticFollowOnAdmission.inspection.valid || !automaticFollowOnAdmission.prepared) {
        throw new RunServiceError('admission_failed', automaticFollowOnAdmission.inspection.problems.map(({ message }) => message).join('; ') || 'Automatic follow-on provider admission failed.');
      }
      const selectedProviderIds = [...new Set((automaticFollowOnAdmission.snapshot.initialChoices ?? []).map(({ providerId }) => providerId))];
      for (const providerId of selectedProviderIds) {
        const entry = automaticFollowOnAdmission.snapshot.catalogue.entries.find(({ id }) => id === providerId);
        if (entry) await assertReady(entry.provider);
      }
    } else if (!request.provider && baseSnapshot) {
      throw new RunServiceError('provider_selection_not_ready', 'Automatic provider selection is not yet available for this request kind.');
    } else if (request.provider) await assertReady(request.provider);
    let accepted: ReturnType<RunCommandRepository['accept']>;
    if (request.kind === 'follow-on') {
      try {
        const followOn = followOnRunRequestSchema.parse(request);
        if (automaticFollowOnAdmission) accepted = commands.accept(submissionId, { ...automaticFollowOnAdmission.prepared,
          providerSelectionSnapshot: automaticFollowOnAdmission.snapshot });
        else {
          commands.reconcile(followOn.sourceRunId, Date.now());
          const source = reads.resolveFollowOnSources(followOn);
          const admission = await prepareFollowOnRun(followOn, source, providerFactory(requireExplicitProvider(followOn)));
          if (!admission.inspection.valid) throw new RunServiceError('admission_failed', admission.inspection.problems.map(({ message }) => message).join('; ') || 'Request did not pass provider fit admission.');
          accepted = commands.accept(submissionId, admission.prepared);
        }
      } catch (error) {
        if (error instanceof RunServiceError) throw error;
        if (error instanceof Error && 'code' in error) throw new RunServiceError(String(error.code), error.message, { cause: error });
        throw new RunServiceError('follow_on_resolution_failed', error instanceof Error ? error.message : 'Follow-on request could not be resolved.', { cause: error });
      }
    } else {
      if (automaticAdmission?.prepared) {
        accepted = commands.accept(submissionId, { ...automaticAdmission.prepared, providerSelectionSnapshot: automaticAdmission.snapshot });
      } else if (automaticJourneyAdmission?.journey) {
        accepted = commands.acceptJourney(submissionId, { ...materializeJourneyRun(automaticJourneyAdmission.journey), providerSelectionSnapshot: automaticJourneyAdmission.snapshot });
      } else {
        const admission = await prepareRun(request, providerFactory(requireExplicitProvider(request)));
        if ((!admission.prepared && !admission.journey) || !admission.inspection.valid) {
          throw new RunServiceError('admission_failed', admission.inspection.problems.map(({ message }) => message).join('; ') || 'Request did not pass provider fit admission.');
        }
        accepted = admission.prepared
          ? commands.accept(submissionId, admission.prepared)
          : commands.acceptJourney(submissionId, materializeJourneyRun(admission.journey!));
      }
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
    const journey = reads.getRequestKind(runId) === 'journey' ? reads.getJourneyRun(runId) : undefined;
    const prepared = journey ? undefined : reads.getRequest(runId);
    const request = journey?.request ?? prepared!.request;
    if (request.provider) await assertReady(requireExplicitProvider(request));
    else {
      const snapshot = journey?.providerSelectionSnapshot ?? prepared?.providerSelectionSnapshot;
      if (!snapshot) throw new RunServiceError('provider_selection_snapshot_missing', 'The accepted automatic run has no frozen provider catalogue.');
      const unresolved = journey?.evaluations ?? prepared?.evaluations ?? [];
      const used = new Map<string, ProviderConfigInput>();
      for (const evaluation of unresolved) {
        if ('status' in evaluation && evaluation.status !== 'pending' && evaluation.status !== 'failed') continue;
        const choice = evaluation.providerSelection ?? snapshot.initialChoices?.find(({ respondentId, questionId }) => respondentId === evaluation.respondentId && questionId === evaluation.questionId);
        const config = snapshot.catalogue.entries.find(({ id }) => id === choice?.providerId)?.provider;
        if (config) used.set(JSON.stringify(config), config);
      }
      for (const config of used.values()) await assertReady(config);
    }
    const resumed = commands.resume(runId, Date.now());
    if (resumed.started) {
      try { await launcher.launch(dataRoot, runId); }
      catch { commands.failLaunch(runId, 'worker_launch_failed'); }
    }
    return reads.getStatus(runId);
  }

  return {
    providerSettings: (input) => {
      const parsed = providerSettingsOperationSchema.safeParse(input);
      if (!parsed.success) throw new RunServiceError('invalid_provider_settings', 'Provider settings operation is invalid.');
      if (parsed.data.operation === 'get') return reads.getProviderSettings();
      return commands.setProviderSettings({ catalogue: parsed.data.catalogue, preferences: parsed.data.preferences }, parsed.data.expectedRevision);
    },
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
