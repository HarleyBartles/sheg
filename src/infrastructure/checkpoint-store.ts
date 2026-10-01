import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { JourneyResult } from '../domain/journey/run.js';
import { decisionResultSchema, decisionValueSchema, type DecisionResult } from '../domain/decision/decision.js';
import type { AttemptSnapshot } from '../domain/attempt-ledger.js';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessLockError, ProcessLock } from './process-lock.js';
import { jevConfigInputSchema, jevConfigSchema } from '../providers/jev/config.js';
import { executionFingerprint, legacyExecutionFingerprint, legacyChoiceStimulusFingerprint, stimulusFingerprint } from './identity.js';
import { loadStudy } from './study-loader.js';
import { legacyPromptContractHash, promptContractHash } from '../domain/decision/prompt.js';

const providerConfigSchema = z.union([
  jevConfigInputSchema.transform((config) => jevConfigSchema.parse(config)),
  z.object({ kind: z.literal('laya'), baseUrl: z.string().url(), checkpoint: z.string().min(1), contextLimit: z.number().int().positive(), headLimit: z.number().int().positive(), tokenizerJsonPath: z.string().min(1), tokenizerSha256: z.string().regex(/^[a-f\d]{64}$/i), precision: z.string().optional(), timeoutMs: z.number().int().positive() }).strict(),
]);

const journeyResultSchema = z.object({
  events: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('exposure'), sequence: z.number().int().nonnegative(), nodeId: z.string(), itemId: z.string() }).strict(),
    z.object({ type: z.literal('choice'), sequence: z.number().int().nonnegative(), nodeId: z.string(), taskId: z.string(), choice: z.string() }).strict(),
    z.object({ type: z.literal('response'), sequence: z.number().int().nonnegative(), nodeId: z.string(), taskId: z.string(), result: decisionValueSchema }).strict(),
  ])),
  outcome: z.string().nullable(),
  status: z.enum(['completed', 'decision-limit']),
  decisionCount: z.number().int().nonnegative(),
}).strict();

const attemptSnapshotSchema = z.object({
  maxCalls: z.number().int().positive(),
  usedCalls: z.number().int().nonnegative(),
  reservedCalls: z.number().int().nonnegative(),
  remainingCalls: z.number().int().nonnegative(),
}).strict().superRefine((snapshot, context) => {
  if (snapshot.usedCalls + snapshot.reservedCalls > snapshot.maxCalls || snapshot.remainingCalls !== snapshot.maxCalls - snapshot.usedCalls - snapshot.reservedCalls) {
    context.addIssue({ code: 'custom', message: 'Attempt allowance counters must exactly account for maxCalls.' });
  }
});

export const contextFailureSchema = z.object({
  decisionId: z.string().min(1), nodeId: z.string().min(1), reason: z.string().min(1),
  tokens: z.number().int().nonnegative(), effectiveLimit: z.number().int().nonnegative(),
  measurementMethod: z.string().min(1),
}).strict();
export type ContextFailure = z.infer<typeof contextFailureSchema>;

export const interruptionEvidenceSchema = z.object({
  attempts: z.number().int().positive(),
  candidateCellIds: z.array(z.string().min(1)),
  recoveredAt: z.string().datetime(),
}).strict();

export const runCheckpointSchema = z.object({
  formatVersion: z.literal(4),
  migratedFromFormatVersion: z.union([z.literal(2), z.literal(3)]).optional(),
  runId: z.string().uuid(),
  status: z.enum(['prepared', 'running', 'completed', 'partial', 'failed', 'cancelled']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  manifestPath: z.string().min(1),
  cohortPath: z.string().min(1),
  outputDirectory: z.string().min(1),
  provider: providerConfigSchema,
  maxCalls: z.number().int().positive(),
  concurrency: z.number().int().positive(),
  stimulusFingerprint: z.string().regex(/^[a-f\d]{64}$/i),
  executionFingerprint: z.string().regex(/^[a-f\d]{64}$/i),
  sourceHashes: z.array(z.string().regex(/^[a-f\d]{64}$/i)),
  respondentIds: z.array(z.string().min(1)),
  journeys: z.array(z.object({
    armId: z.string().min(1),
    respondentId: z.string().min(1),
    status: z.enum(['completed', 'failed', 'partial']),
    result: journeyResultSchema.optional(),
    decisions: z.array(z.object({ decisionId: z.string().min(1), requestFingerprint: z.string().regex(/^[a-f\d]{64}$/i), result: decisionResultSchema }).strict()),
    attemptHistory: z.array(z.object({ decisionId: z.string().min(1), requestFingerprint: z.string().regex(/^[a-f\d]{64}$/i), result: decisionResultSchema }).strict()),
    presentedTaskIds: z.array(z.string().min(1)),
    failureKind: z.enum(['provider', 'journey', 'unsupported-input']).optional(),
    failedAttempts: z.number().int().nonnegative().optional(),
    failureEvidence: contextFailureSchema.optional(),
  }).strict()),
  interruptions: z.array(interruptionEvidenceSchema).optional(),
  activeCellIds: z.array(z.string().min(1)),
  cancellationRequested: z.boolean(),
  budget: attemptSnapshotSchema,
}).strict().superRefine((checkpoint, context) => {
  if (checkpoint.sourceHashes.some((hash) => hash.length !== 64)) {
    context.addIssue({ code: 'custom', path: ['sourceHashes'], message: 'Source hashes must be SHA-256 values.' });
  }
  const cellIds = checkpoint.journeys.map((journey) => `${journey.armId}\0${journey.respondentId}`);
  if (new Set(checkpoint.respondentIds).size !== checkpoint.respondentIds.length || new Set(cellIds).size !== cellIds.length) {
    context.addIssue({ code: 'custom', path: ['respondentIds'], message: 'Checkpoint respondent IDs and arm/respondent cells must be unique.' });
  }
});

export type RunCheckpoint = z.infer<typeof runCheckpointSchema>;
export type LegacyRunCheckpointFormat = 2 | 3;
export type CompletedJourney = RunCheckpoint['journeys'][number] & { result: JourneyResult };
export type CheckpointDecision = { decisionId: string; requestFingerprint: string; result: DecisionResult };

const legacyBudgetSchema = z.object({
  maxCalls: z.number().int().positive(), maxUsd: z.number().finite().nonnegative().optional(),
  usedCalls: z.number().int().nonnegative(), reservedCalls: z.number().int().nonnegative(),
  remainingCalls: z.number().int().nonnegative(), billedUsd: z.number().finite().nonnegative(),
  reservedUsd: z.number().finite().nonnegative(), unpricedReservations: z.number().int().nonnegative(),
  overspendUsd: z.number().finite().nonnegative(), blocked: z.boolean(),
}).strict();

function normalizeLegacyShape(value: unknown): unknown | null {
  if (!isRecord(value) || (value.formatVersion !== 2 && value.formatVersion !== 3)) return null;
  const legacyVersion = value.formatVersion;
  const budget = legacyBudgetSchema.parse(value.budget);
  if (budget.maxCalls !== value.maxCalls || budget.usedCalls + budget.reservedCalls + budget.remainingCalls !== budget.maxCalls ||
      budget.usedCalls + budget.reservedCalls > budget.maxCalls) throw new Error('Legacy call counters do not account for maxCalls.');
  if (value.maxUsd !== undefined && (!Number.isFinite(value.maxUsd) || Number(value.maxUsd) < 0)) throw new Error('Legacy run spend limit is invalid.');
  if (value.maxPerCallUsd !== undefined && (!Number.isFinite(value.maxPerCallUsd) || Number(value.maxPerCallUsd) <= 0)) throw new Error('Legacy per-call spend limit is invalid.');

  const migrated = structuredClone(value) as Record<string, unknown>;
  migrated.formatVersion = 4;
  migrated.migratedFromFormatVersion = legacyVersion;
  delete migrated.maxUsd;
  delete migrated.maxPerCallUsd;
  migrated.provider = normalizeLegacyProvider(migrated.provider);
  if (budget.reservedCalls > 0) migrated.interruptions = [{
    attempts: budget.reservedCalls,
    candidateCellIds: Array.isArray(migrated.activeCellIds) ? migrated.activeCellIds : [],
    recoveredAt: new Date().toISOString(),
  }];
  migrated.budget = {
    maxCalls: budget.maxCalls,
    usedCalls: budget.usedCalls + budget.reservedCalls,
    reservedCalls: 0,
    remainingCalls: budget.maxCalls - budget.usedCalls - budget.reservedCalls,
  } satisfies AttemptSnapshot;
  if (!Array.isArray(migrated.journeys)) throw new Error('Legacy checkpoint journeys are invalid.');
  migrated.journeys = migrated.journeys.map((rawJourney) => {
    if (!isRecord(rawJourney)) return rawJourney;
    const journey = { ...rawJourney };
    for (const key of ['decisions', 'attemptHistory'] as const) {
      if (!Array.isArray(journey[key])) continue;
      journey[key] = (journey[key] as unknown[]).map((rawDecision) => {
        if (!isRecord(rawDecision) || !isRecord(rawDecision.result)) return rawDecision;
        return { ...rawDecision, result: normalizeLegacyDecision(rawDecision.result) };
      });
    }
    if (legacyVersion === 2 && isRecord(journey.result) && Array.isArray(journey.result.events)) {
      journey.result = { ...journey.result, events: journey.result.events.map((event) => isRecord(event) && event.type === 'choice'
        ? { type: 'response', sequence: event.sequence, nodeId: event.nodeId, taskId: event.taskId, result: { type: 'choice', choice: event.choice } }
        : event) };
    }
    return journey;
  });
  return migrated;
}

function normalizeLegacyProvider(value: unknown): unknown {
  if (!isRecord(value) || value.kind !== 'jev') return value;
  if (value.keyEnv !== undefined && typeof value.keyEnv !== 'string') throw new Error('Legacy Jev credential metadata is invalid.');
  const config = { ...value };
  delete config.keyEnv;
  return jevConfigSchema.parse({ ...config, route: config.route ?? 'openrouter' });
}

function normalizeLegacyDecision(value: Record<string, unknown>): Record<string, unknown> {
  const { chargeStatus, chargeUsd, ...result } = value;
  if (chargeStatus !== undefined && !['billed', 'not_billed', 'unknown'].includes(String(chargeStatus))) throw new Error('Legacy charge status is invalid.');
  if (chargeUsd !== undefined && (typeof chargeUsd !== 'number' || !Number.isFinite(chargeUsd) || chargeUsd < 0)) throw new Error('Legacy charge amount is invalid.');
  if (chargeStatus === 'billed' && chargeUsd !== undefined) result.cost = { amountUsd: chargeUsd, basis: 'provider-reported' };
  return result;
}

async function migrateLegacyCheckpoint(checkpoint: RunCheckpoint): Promise<RunCheckpoint> {
  const legacyVersion = checkpoint.migratedFromFormatVersion;
  if (!legacyVersion) return checkpoint;
  const study = await loadStudy(checkpoint.manifestPath, checkpoint.cohortPath);
  if (study.sources.length !== checkpoint.sourceHashes.length || study.sources.some((source, index) => source.sha256 !== checkpoint.sourceHashes[index])) {
    throw new Error('Study source hashes changed since the legacy run was prepared.');
  }
  const oldStimulus = legacyVersion === 2
    ? legacyChoiceStimulusFingerprint(study.manifest, study.cohort, legacyPromptContractHash)
    : stimulusFingerprint(study.manifest, study.cohort, promptContractHash());
  const providerIdentity = checkpoint.provider.kind === 'laya'
    ? { kind: 'laya' as const, checkpoint: checkpoint.provider.checkpoint, contextLimit: checkpoint.provider.contextLimit, headLimit: checkpoint.provider.headLimit, tokenizerSha256: checkpoint.provider.tokenizerSha256, ...(checkpoint.provider.precision === undefined ? {} : { precision: checkpoint.provider.precision }) }
    : checkpoint.provider;
  if (oldStimulus !== checkpoint.stimulusFingerprint || legacyExecutionFingerprint(oldStimulus, providerIdentity) !== checkpoint.executionFingerprint) {
    throw new Error('Legacy study or provider identity changed since the run was prepared.');
  }
  const nextStimulus = stimulusFingerprint(study.manifest, study.cohort, promptContractHash());
  return runCheckpointSchema.parse({
    ...checkpoint,
    stimulusFingerprint: nextStimulus,
    executionFingerprint: executionFingerprint(nextStimulus, providerIdentity),
    updatedAt: new Date().toISOString(),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class CheckpointStore {
  constructor(readonly directory: string) {}

  async create(input: Omit<RunCheckpoint, 'formatVersion' | 'runId'> & { runId?: string }): Promise<RunCheckpoint> {
    const checkpoint = runCheckpointSchema.parse({ ...input, formatVersion: 4, runId: input.runId ?? randomUUID() });
    await mkdir(this.directory, { recursive: true });
    const filePath = this.filePath(checkpoint.runId);
    try {
      await readFile(filePath);
      throw new Error(`Run checkpoint already exists: ${checkpoint.runId}.`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Run checkpoint already exists:')) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await this.writeAtomic(checkpoint);
    return checkpoint;
  }

  async read(runId: string): Promise<RunCheckpoint> {
    const initial = await this.readValue(runId);
    const current = runCheckpointSchema.safeParse(initial);
    if (current.success) return current.data;
    const runLock = await ProcessLock.acquire(this.directory, `run-${runId}`);
    try {
      const checkpointLock = await acquireCheckpointLock(this.directory, runId);
      try { return await this.readCurrentOrMigrate(runId); }
      finally { await checkpointLock.release(); }
    } finally { await runLock.release(); }
  }

  async save(checkpoint: RunCheckpoint): Promise<void> {
    const parsed = runCheckpointSchema.parse(checkpoint);
    const existing = await this.read(parsed.runId);
    if (existing.runId !== parsed.runId) throw new Error('Checkpoint identity changed while saving.');
    await this.writeAtomic(parsed);
  }

  async update(runId: string, mutate: (checkpoint: RunCheckpoint) => RunCheckpoint): Promise<RunCheckpoint> {
    await this.read(runId);
    const lock = await acquireCheckpointLock(this.directory, runId);
    try {
      const current = await this.readCurrentOrMigrate(runId);
      const updated = runCheckpointSchema.parse(mutate(current));
      if (updated.runId !== current.runId) throw new Error('Checkpoint identity cannot be changed.');
      await this.writeAtomic(updated);
      return updated;
    } finally {
      await lock.release();
    }
  }

  async list(): Promise<RunCheckpoint[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const files = names.filter((name) => /^run-[0-9a-f-]+\.json$/i.test(name)).sort();
    const checkpoints: RunCheckpoint[] = [];
    for (const filename of files) checkpoints.push(await this.read(filename.slice(4, -5)));
    return checkpoints;
  }

  private filePath(runId: string): string {
    if (!z.string().uuid().safeParse(runId).success) throw new TypeError('Run ID must be a UUID.');
    return path.join(this.directory, `run-${runId}.json`);
  }

  private async readCurrentOrMigrate(runId: string): Promise<RunCheckpoint> {
    const value = await this.readValue(runId);
    const current = runCheckpointSchema.safeParse(value);
    if (current.success) return current.data;
    const legacyShape = normalizeLegacyShape(value);
    if (!legacyShape) throw new Error(`Run checkpoint ${runId} failed validation.`, { cause: current.error });
    let migrated: RunCheckpoint;
    try {
      migrated = await migrateLegacyCheckpoint(runCheckpointSchema.parse(legacyShape));
    } catch (error) {
      throw new Error(`Legacy run checkpoint ${runId} failed migration validation.`, { cause: error });
    }
    await this.writeAtomic(migrated);
    return migrated;
  }

  private async readValue(runId: string): Promise<unknown> {
    let raw: string;
    try {
      raw = await readFile(this.filePath(runId), 'utf8');
    } catch (error) {
      try { raw = await readFile(`${this.filePath(runId)}.bak`, 'utf8'); }
      catch { throw new Error(`Run checkpoint ${runId} is unavailable.`, { cause: error }); }
    }
    try { return JSON.parse(raw) as unknown; }
    catch (error) { throw new Error(`Run checkpoint ${runId} is not valid JSON.`, { cause: error }); }
  }

  private async writeAtomic(checkpoint: RunCheckpoint): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = this.filePath(checkpoint.runId);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      try {
        await rename(temporary, target);
      } catch (error) {
        if (!['EPERM', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        const backup = `${target}.bak`;
        await rm(backup, { force: true });
        await rename(target, backup);
        try {
          await rename(temporary, target);
          await rm(backup, { force: true });
        } catch (replacementError) {
          await rename(backup, target).catch(() => undefined);
          throw replacementError;
        }
      }
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

export function emptyAttemptSnapshot(maxCalls: number): AttemptSnapshot {
  return { maxCalls, usedCalls: 0, reservedCalls: 0, remainingCalls: maxCalls };
}


async function acquireCheckpointLock(directory: string, runId: string): Promise<ProcessLock> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { return await ProcessLock.acquire(directory, `${runId}-checkpoint`); }
    catch (error) {
      if (!(error instanceof ProcessLockError) || Date.now() >= deadline) throw error;
      await delay(10);
    }
  }
}
