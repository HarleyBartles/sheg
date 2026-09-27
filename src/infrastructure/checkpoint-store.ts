import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { JourneyResult } from '../domain/journey/run.js';
import { decisionResultSchema, type DecisionResult } from '../domain/decision/decision.js';
import type { BudgetSnapshot } from '../domain/budget-ledger.js';
import { ProcessLock } from './process-lock.js';

const providerConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('jev'), model: z.string().min(1), keyEnv: z.string().min(1), endpoint: z.string().url(), timeoutMs: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('laya'), baseUrl: z.string().url(), checkpoint: z.string().min(1), contextLimit: z.number().int().positive(), precision: z.string().optional(), timeoutMs: z.number().int().positive() }).strict(),
]);

const journeyResultSchema = z.object({
  events: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('exposure'), sequence: z.number().int().nonnegative(), nodeId: z.string(), itemId: z.string() }).strict(),
    z.object({ type: z.literal('choice'), sequence: z.number().int().nonnegative(), nodeId: z.string(), taskId: z.string(), choice: z.string() }).strict(),
  ])),
  outcome: z.string().nullable(),
  status: z.enum(['completed', 'decision-limit']),
  decisionCount: z.number().int().nonnegative(),
}).strict();

const budgetSnapshotSchema = z.object({
  maxCalls: z.number().int().positive(), maxUsd: z.number().finite().nonnegative().optional(),
  usedCalls: z.number().int().nonnegative(), reservedCalls: z.number().int().nonnegative(),
  remainingCalls: z.number().int().nonnegative(), billedUsd: z.number().finite().nonnegative(),
  reservedUsd: z.number().finite().nonnegative(), unpricedReservations: z.number().int().nonnegative(),
  overspendUsd: z.number().finite().nonnegative(), blocked: z.boolean(),
}).strict();

export const runCheckpointSchema = z.object({
  formatVersion: z.literal(2),
  runId: z.string().uuid(),
  status: z.enum(['prepared', 'running', 'completed', 'partial', 'failed', 'cancelled']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  manifestPath: z.string().min(1),
  cohortPath: z.string().min(1),
  outputDirectory: z.string().min(1),
  provider: providerConfigSchema,
  maxCalls: z.number().int().positive(),
  maxUsd: z.number().finite().nonnegative().optional(),
  maxPerCallUsd: z.number().finite().positive().optional(),
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
  }).strict()),
  activeCellIds: z.array(z.string().min(1)),
  cancellationRequested: z.boolean(),
  budget: budgetSnapshotSchema,
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
export type CompletedJourney = RunCheckpoint['journeys'][number] & { result: JourneyResult };
export type CheckpointDecision = { decisionId: string; requestFingerprint: string; result: DecisionResult };

export class CheckpointStore {
  constructor(readonly directory: string) {}

  async create(input: Omit<RunCheckpoint, 'formatVersion' | 'runId'> & { runId?: string }): Promise<RunCheckpoint> {
    const checkpoint = runCheckpointSchema.parse({ ...input, formatVersion: 2, runId: input.runId ?? randomUUID() });
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
    let raw: string;
    try {
      raw = await readFile(this.filePath(runId), 'utf8');
    } catch (error) {
      try {
        raw = await readFile(`${this.filePath(runId)}.bak`, 'utf8');
      } catch {
        throw new Error(`Run checkpoint ${runId} is unavailable.`, { cause: error });
      }
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(`Run checkpoint ${runId} is not valid JSON.`, { cause: error });
    }
    const checkpoint = runCheckpointSchema.safeParse(value);
    if (!checkpoint.success) throw new Error(`Run checkpoint ${runId} failed validation.`, { cause: checkpoint.error });
    return checkpoint.data;
  }

  async save(checkpoint: RunCheckpoint): Promise<void> {
    const parsed = runCheckpointSchema.parse(checkpoint);
    const existing = await this.read(parsed.runId);
    if (existing.runId !== parsed.runId) throw new Error('Checkpoint identity changed while saving.');
    await this.writeAtomic(parsed);
  }

  async update(runId: string, mutate: (checkpoint: RunCheckpoint) => RunCheckpoint): Promise<RunCheckpoint> {
    const lock = await ProcessLock.acquire(this.directory, `${runId}-checkpoint`);
    try {
      const current = await this.read(runId);
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

export function emptyBudgetSnapshot(maxCalls: number, maxUsd?: number): BudgetSnapshot {
  return {
    maxCalls,
    ...(maxUsd === undefined ? {} : { maxUsd }),
    usedCalls: 0,
    reservedCalls: 0,
    remainingCalls: maxCalls,
    billedUsd: 0,
    reservedUsd: 0,
    unpricedReservations: 0,
    overspendUsd: 0,
    blocked: false,
  };
}
