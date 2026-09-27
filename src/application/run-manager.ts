import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadStudy } from '../infrastructure/study-loader.js';
import type { DecisionProvider } from '../domain/decision/provider.js';
import { promptContractHash } from '../domain/decision/prompt.js';
import { BudgetLedger } from '../domain/budget-ledger.js';
import { CheckpointStore, emptyBudgetSnapshot, type RunCheckpoint } from '../infrastructure/checkpoint-store.js';
import { executionFingerprint, stimulusFingerprint } from '../infrastructure/identity.js';
import { ProcessLock, ProcessLockError } from '../infrastructure/process-lock.js';
import { JevProvider, type JevConfig } from '../providers/jev.js';
import { LayaProvider, type FitMeasurer, type LayaConfig } from '../providers/laya.js';
import { runWorker } from './worker.js';

const configSchema = z.object({
  manifestPath: z.string().min(1), cohortPath: z.string().min(1),
  provider: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('jev'), model: z.string().min(1), keyEnv: z.string().min(1), endpoint: z.string().url(), timeoutMs: z.number().int().positive() }).strict(),
    z.object({ kind: z.literal('laya'), baseUrl: z.string().url(), checkpoint: z.string().min(1), contextLimit: z.number().int().positive(), precision: z.string().optional(), timeoutMs: z.number().int().positive() }).strict(),
  ]),
  outputDirectory: z.string().min(1), maxCalls: z.number().int().positive(), maxUsd: z.number().finite().positive().optional(),
  maxPerCallUsd: z.number().finite().positive().optional(), concurrency: z.number().int().min(1).max(64).default(1),
}).strict().superRefine((value, context) => {
  if (value.provider.kind === 'jev' && (value.maxUsd === undefined || value.maxPerCallUsd === undefined)) {
    context.addIssue({ code: 'custom', path: ['maxUsd'], message: 'Jev runs require maxUsd and maxPerCallUsd.' });
  }
  if (value.provider.kind === 'laya' && (value.maxUsd !== undefined || value.maxPerCallUsd !== undefined)) {
    context.addIssue({ code: 'custom', path: ['maxUsd'], message: 'Local Laya runs do not accept hosted spend caps.' });
  }
});

export type RunConfig = z.input<typeof configSchema>;
type ParsedConfig = z.output<typeof configSchema>;
export type CheckedStudy = { config: ParsedConfig; study: Awaited<ReturnType<typeof loadStudy>>; stimulusFingerprint: string; executionFingerprint: string };
export type JobOptions = { measureLayaFit?: FitMeasurer; providerFactory?: (config: ParsedConfig['provider']) => DecisionProvider };

export async function checkStudy(config: RunConfig): Promise<CheckedStudy> {
  const parsed = configSchema.parse(config);
  const normalized: ParsedConfig = { ...parsed, manifestPath: path.resolve(parsed.manifestPath), cohortPath: path.resolve(parsed.cohortPath), outputDirectory: path.resolve(parsed.outputDirectory) };
  const study = await loadStudy(normalized.manifestPath, normalized.cohortPath);
  const stimulus = stimulusFingerprint(study.manifest, study.cohort, promptContractHash());
  const identityProvider = normalized.provider.kind === 'laya'
    ? { kind: 'laya' as const, checkpoint: normalized.provider.checkpoint, contextLimit: normalized.provider.contextLimit, baseUrl: normalized.provider.baseUrl, timeoutMs: normalized.provider.timeoutMs, ...(normalized.provider.precision === undefined ? {} : { precision: normalized.provider.precision }) }
    : normalized.provider;
  return { config: normalized, study, stimulusFingerprint: stimulus, executionFingerprint: executionFingerprint(stimulus, identityProvider) };
}

export class RunManager {
  private readonly active = new Map<string, Promise<void>>();
  constructor(private readonly options: JobOptions = {}) {}

  async startRun(config: RunConfig): Promise<RunCheckpoint> {
    const checked = await checkStudy(config);
    const { config: c, study } = checked;
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
        provider: c.provider, maxCalls: c.maxCalls, ...(c.maxUsd === undefined ? {} : { maxUsd: c.maxUsd }),
        ...(c.maxPerCallUsd === undefined ? {} : { maxPerCallUsd: c.maxPerCallUsd }), concurrency: c.concurrency,
        stimulusFingerprint: checked.stimulusFingerprint, executionFingerprint: checked.executionFingerprint,
        sourceHashes: study.sources.map((source) => source.sha256), respondentIds: study.respondents.map((profile) => profile.id),
        journeys: [], activeCellIds: [], cancellationRequested: false, budget: emptyBudgetSnapshot(c.maxCalls, c.maxUsd),
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
          const ledger = BudgetLedger.restore(cleanBudget(current.budget));
          ledger.markInterruptedReservationsUnpriced();
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

  async reconcileRun(outputDirectory: string, runId: string, unpricedUsd: number): Promise<RunCheckpoint> {
    const store = new CheckpointStore(path.resolve(outputDirectory));
    const current = await store.read(runId);
    const ledger = BudgetLedger.restore(cleanBudget(current.budget));
    await ledger.reconcile(unpricedUsd);
    return store.update(runId, (latest) => ({ ...latest, budget: ledger.snapshot(), updatedAt: new Date().toISOString() }));
  }

  async resumeRun(outputDirectory: string, runId: string): Promise<RunCheckpoint> {
    const store = new CheckpointStore(path.resolve(outputDirectory));
    let checkpoint = await store.read(runId);
    if (checkpoint.status === 'completed' || checkpoint.status === 'cancelled') throw new Error(`Cannot resume a ${checkpoint.status} run.`);
    const checked = await checkStudy({ manifestPath: checkpoint.manifestPath, cohortPath: checkpoint.cohortPath, provider: checkpoint.provider, outputDirectory: checkpoint.outputDirectory, maxCalls: checkpoint.maxCalls, ...(checkpoint.maxUsd === undefined ? {} : { maxUsd: checkpoint.maxUsd }), ...(checkpoint.maxPerCallUsd === undefined ? {} : { maxPerCallUsd: checkpoint.maxPerCallUsd }), concurrency: checkpoint.concurrency });
    if (checked.executionFingerprint !== checkpoint.executionFingerprint || checked.study.sources.some((source, index) => source.sha256 !== checkpoint.sourceHashes[index])) throw new Error('Study or execution settings changed since this run was prepared.');
    const lock = await ProcessLock.acquire(store.directory, `run-${runId}`);
    try {
      if (checkpoint.budget.blocked) throw new Error('Unpriced calls must be reconciled before resume.');
      checkpoint = await store.update(runId, (current) => ({ ...current, status: 'running', cancellationRequested: false, updatedAt: new Date().toISOString() }));
      this.launch(store, checkpoint, lock);
      return checkpoint;
    } catch (error) { await lock.release(); throw error; }
  }

  async readCheckpoint(outputDirectory: string, runId: string): Promise<RunCheckpoint> { return new CheckpointStore(path.resolve(outputDirectory)).read(runId); }

  private launch(store: CheckpointStore, checkpoint: RunCheckpoint, lock: Awaited<ReturnType<typeof ProcessLock.acquire>>): void {
    const provider = this.options.providerFactory?.(checkpoint.provider) ?? (checkpoint.provider.kind === 'jev'
      ? new JevProvider(checkpoint.provider as JevConfig)
      : new LayaProvider(checkpoint.provider as LayaConfig, { ...(this.options.measureLayaFit === undefined ? {} : { measureFit: this.options.measureLayaFit }) }));
    const task = runWorker(store, checkpoint, provider).then(() => undefined).catch(async () => {
      await store.update(checkpoint.runId, (current) => ({ ...current, status: 'failed', activeCellIds: [], updatedAt: new Date().toISOString() }));
    }).finally(async () => { this.active.delete(checkpoint.runId); await lock.release(); });
    this.active.set(checkpoint.runId, task);
  }
}

function cleanBudget(snapshot: RunCheckpoint['budget']) {
  const { maxUsd, ...rest } = snapshot;
  return { ...rest, ...(maxUsd === undefined ? {} : { maxUsd }) };
}
