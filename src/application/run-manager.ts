import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadStudy } from '../infrastructure/study-loader.js';
import type { DecisionProvider } from '../domain/decision/provider.js';
import { promptContractHash } from '../domain/decision/prompt.js';
import { AttemptLedger } from '../domain/attempt-ledger.js';
import { CheckpointStore, emptyAttemptSnapshot, type RunCheckpoint } from '../infrastructure/checkpoint-store.js';
import { executionFingerprint, stimulusFingerprint } from '../infrastructure/identity.js';
import { ProcessLock, ProcessLockError } from '../infrastructure/process-lock.js';
import { JevProvider, jevConfigInputSchema, jevConfigSchema, type JevConfig } from '../providers/jev.js';
import { LayaProvider, type FitMeasurer, type LayaConfig } from '../providers/laya.js';
import { WindowsCredentialStore } from '../infrastructure/credentials/windows.js';
import { runWorker } from './worker.js';
import { estimateRunDecisionCalls, type RunDecisionCallBounds } from '../domain/journey/route-bounds.js';

const configSchema = z.object({
  manifestPath: z.string().min(1), cohortPath: z.string().min(1),
  provider: z.union([
    jevConfigInputSchema.transform((input) => jevConfigSchema.parse(input)),
    z.object({ kind: z.literal('laya'), baseUrl: z.string().url(), checkpoint: z.string().min(1), contextLimit: z.number().int().positive(), headLimit: z.number().int().positive(), tokenizerJsonPath: z.string().min(1), tokenizerSha256: z.string().regex(/^[a-f\d]{64}$/i), precision: z.string().optional(), timeoutMs: z.number().int().positive() }).strict(),
  ]),
  outputDirectory: z.string().min(1), maxCalls: z.number().int().positive(),
  concurrency: z.number().int().min(1).max(64).default(1),
}).strict();

export type RunConfig = z.input<typeof configSchema>;
type ParsedConfig = z.output<typeof configSchema>;
export type CheckedStudy = { config: ParsedConfig; study: Awaited<ReturnType<typeof loadStudy>>; stimulusFingerprint: string; executionFingerprint: string; runBounds: RunDecisionCallBounds & { maximumCallsConfigured: number; maximumCallsSufficient: boolean } };
export type JobOptions = {
  measureLayaFit?: FitMeasurer;
  providerFactory?: (config: ParsedConfig['provider']) => DecisionProvider;
  credentialStore?: Pick<WindowsCredentialStore, 'availability' | 'readForAuthentication'>;
};

export async function checkStudy(config: RunConfig): Promise<CheckedStudy> {
  const parsed = configSchema.parse(config);
  const normalized: ParsedConfig = { ...parsed, manifestPath: path.resolve(parsed.manifestPath), cohortPath: path.resolve(parsed.cohortPath), outputDirectory: path.resolve(parsed.outputDirectory),
    provider: parsed.provider.kind === 'laya' ? { ...parsed.provider, tokenizerJsonPath: path.resolve(parsed.provider.tokenizerJsonPath) } : parsed.provider };
  const study = await loadStudy(normalized.manifestPath, normalized.cohortPath);
  const routeBounds = estimateRunDecisionCalls(study.manifest.arms, study.respondents);
  const runBounds = {
    ...routeBounds,
    maximumCallsConfigured: normalized.maxCalls,
    maximumCallsSufficient: routeBounds.maximumDecisionCalls <= normalized.maxCalls,
  };
  const stimulus = stimulusFingerprint(study.manifest, study.cohort, promptContractHash());
  const identityProvider = normalized.provider.kind === 'laya'
    ? { kind: 'laya' as const, checkpoint: normalized.provider.checkpoint, contextLimit: normalized.provider.contextLimit, headLimit: normalized.provider.headLimit, tokenizerSha256: normalized.provider.tokenizerSha256, baseUrl: normalized.provider.baseUrl, timeoutMs: normalized.provider.timeoutMs, ...(normalized.provider.precision === undefined ? {} : { precision: normalized.provider.precision }) }
    : normalized.provider;
  return { config: normalized, study, stimulusFingerprint: stimulus, executionFingerprint: executionFingerprint(stimulus, identityProvider), runBounds };
}

export class RunManager {
  private readonly active = new Map<string, Promise<void>>();
  private readonly credentialStore: Pick<WindowsCredentialStore, 'availability' | 'readForAuthentication'>;
  constructor(private readonly options: JobOptions = {}) {
    this.credentialStore = options.credentialStore ?? new WindowsCredentialStore();
  }

  async startRun(config: RunConfig): Promise<RunCheckpoint> {
    const checked = await checkStudy(config);
    const { config: c, study } = checked;
    await requireJevCredential(c.provider, this.credentialStore);
    await mkdir(c.outputDirectory, { recursive: true });
    const runId = randomUUID();
    const store = new CheckpointStore(c.outputDirectory);
    const lock = await ProcessLock.acquire(c.outputDirectory, `run-${runId}`);
    let checkpoint: RunCheckpoint;
    try {
      checkpoint = await store.create({
        runId,
        status: 'prepared', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        manifestPath: c.manifestPath, cohortPath: c.cohortPath, outputDirectory: c.outputDirectory,
        provider: c.provider, maxCalls: c.maxCalls, concurrency: c.concurrency,
        stimulusFingerprint: checked.stimulusFingerprint, executionFingerprint: checked.executionFingerprint,
        sourceHashes: study.sources.map((source) => source.sha256), respondentIds: study.respondents.map((profile) => profile.id),
        journeys: [], activeCellIds: [], cancellationRequested: false, budget: emptyAttemptSnapshot(c.maxCalls),
      });
      checkpoint = await store.update(runId, (current) => ({ ...current, status: 'running', updatedAt: new Date().toISOString() }));
      this.launch(store, checkpoint, lock);
      return checkpoint;
    } catch (error) { await lock.release(); throw error; }
  }

  async runStatus(outputDirectory: string, runId: string): Promise<RunCheckpoint> {
    const store = new CheckpointStore(path.resolve(outputDirectory));
    const checkpoint = await store.read(runId);
    if (checkpoint.status === 'running' && !this.active.has(runId)) {
      try {
        const lock = await ProcessLock.acquire(store.directory, `run-${runId}`);
        try {
          const current = await store.read(runId);
          const ledger = AttemptLedger.restore(current.budget);
          ledger.consumeInterruptedReservations();
          return await store.update(runId, (latest) => ({ ...latest, status: 'partial', activeCellIds: [], budget: ledger.snapshot(), updatedAt: new Date().toISOString() }));
        } finally { await lock.release(); }
      } catch (error) { if (!(error instanceof ProcessLockError)) throw error; }
    }
    return checkpoint;
  }

  async cancelRun(outputDirectory: string, runId: string): Promise<RunCheckpoint> {
    const store = new CheckpointStore(path.resolve(outputDirectory));
    await store.update(runId, (current) => ({ ...current, cancellationRequested: true, updatedAt: new Date().toISOString() }));
    await this.active.get(runId);
    return store.read(runId);
  }

  async resumeRun(outputDirectory: string, runId: string): Promise<RunCheckpoint> {
    const store = new CheckpointStore(path.resolve(outputDirectory));
    let checkpoint = await store.read(runId);
    if (checkpoint.status === 'completed' || checkpoint.status === 'cancelled') throw new Error(`Cannot resume a ${checkpoint.status} run.`);
    const checked = await checkStudy({ manifestPath: checkpoint.manifestPath, cohortPath: checkpoint.cohortPath, provider: checkpoint.provider, outputDirectory: checkpoint.outputDirectory, maxCalls: checkpoint.maxCalls, concurrency: checkpoint.concurrency });
    if (checked.executionFingerprint !== checkpoint.executionFingerprint || checked.study.sources.some((source, index) => source.sha256 !== checkpoint.sourceHashes[index])) throw new Error('Study or execution settings changed since this run was prepared.');
    await requireJevCredential(checkpoint.provider, this.credentialStore);
    const lock = await ProcessLock.acquire(store.directory, `run-${runId}`);
    try {
      checkpoint = await store.update(runId, (current) => {
        const ledger = AttemptLedger.restore(current.budget);
        ledger.consumeInterruptedReservations();
        return { ...current, status: 'running', cancellationRequested: false, activeCellIds: [], budget: ledger.snapshot(), updatedAt: new Date().toISOString() };
      });
      this.launch(store, checkpoint, lock);
      return checkpoint;
    } catch (error) { await lock.release(); throw error; }
  }

  async readCheckpoint(outputDirectory: string, runId: string): Promise<RunCheckpoint> { return new CheckpointStore(path.resolve(outputDirectory)).read(runId); }

  private launch(store: CheckpointStore, checkpoint: RunCheckpoint, lock: Awaited<ReturnType<typeof ProcessLock.acquire>>): void {
    const provider = this.options.providerFactory?.(checkpoint.provider) ?? (checkpoint.provider.kind === 'jev'
      ? new JevProvider(checkpoint.provider as JevConfig, fetch, { credentialStore: this.credentialStore })
      : new LayaProvider(checkpoint.provider as LayaConfig, { ...(this.options.measureLayaFit === undefined ? {} : { measureFit: this.options.measureLayaFit }) }));
    const task = runWorker(store, checkpoint, provider).then(() => undefined).catch(async () => {
      await store.update(checkpoint.runId, (current) => ({ ...current, status: 'failed', activeCellIds: [], updatedAt: new Date().toISOString() }));
    }).finally(async () => { this.active.delete(checkpoint.runId); await lock.release(); });
    this.active.set(checkpoint.runId, task);
  }
}

async function requireJevCredential(provider: ParsedConfig['provider'], credentialStore: Pick<WindowsCredentialStore, 'availability'>): Promise<void> {
  if (provider.kind !== 'jev') return;
  const availability = await credentialStore.availability(provider.route);
  if (availability !== 'available') throw new Error(`The ${provider.route} secure credential is ${availability}. Connect the key through Windows Credential Manager before starting or resuming a run.`);
}
