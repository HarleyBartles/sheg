import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadProfiles } from '../domain/readers/profile.js';
import { CheckpointStore, type RunCheckpoint } from '../infrastructure/checkpoint-store.js';

export const pollingReportSchema = z.object({
  formatVersion: z.literal(1), runId: z.string().uuid(), status: z.string(),
  stimulusFingerprint: z.string(), executionFingerprint: z.string(), provider: z.object({ kind: z.enum(['jev', 'laya']), model: z.string().nullable(), checkpoint: z.string().nullable() }).strict(),
  denominator: z.object({ intended: z.number().int().nonnegative(), completed: z.number().int().nonnegative(), excluded: z.number().int().nonnegative(), excludedByStatus: z.record(z.string(), z.number().int().nonnegative()) }).strict(),
  outcomes: z.record(z.string(), z.number().int().nonnegative()),
  archetypes: z.record(z.string(), z.object({ intended: z.number().int().nonnegative(), completed: z.number().int().nonnegative(), outcomes: z.record(z.string(), z.number().int().nonnegative()) }).strict()),
  items: z.record(z.string(), z.object({ exposures: z.number().int().nonnegative(), readers: z.number().int().nonnegative() }).strict()),
  journeys: z.array(z.object({ readerId: z.string(), archetypeId: z.string().nullable(), status: z.string(), outcome: z.string().nullable(), events: z.array(z.unknown()), decisions: z.array(z.object({ decisionId: z.string(), choice: z.string(), attempts: z.number().int(), latencyMs: z.number().nonnegative(), inputTokens: z.number().int().nonnegative().nullable(), outputTokens: z.number().int().nonnegative().nullable(), confidence: z.number().nullable(), chargeStatus: z.string(), chargeUsd: z.number().nonnegative().nullable() }).strict()) }).strict()),
  providerEvidence: z.object({ attempts: z.number().int().nonnegative(), meanLatencyMs: z.number().nonnegative().nullable(), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), confidence: z.object({ count: z.number().int().nonnegative(), mean: z.number().min(0).max(1).nullable() }).strict(), billedUsd: z.number().nonnegative(), unknownCharges: z.number().int().nonnegative(), unsupportedJourneys: z.number().int().nonnegative(), failedJourneys: z.number().int().nonnegative() }).strict(),
}).strict();

export type PollingReport = z.infer<typeof pollingReportSchema>;

export async function buildReport(checkpoint: RunCheckpoint): Promise<PollingReport> {
  const rawCohort = JSON.parse(await readFile(checkpoint.cohortPath, 'utf8')) as unknown;
  const profiles = loadProfiles(rawCohort);
  const archetypeByReader = new Map(profiles.map((profile) => [profile.id, profile.archetypeId]));
  const intended = checkpoint.readerIds;
  const completedJourneys = checkpoint.journeys.filter((journey) => journey.status === 'completed' && journey.result);
  const excludedByStatus: Record<string, number> = {};
  for (const id of intended) {
    const journey = checkpoint.journeys.find((record) => record.readerId === id);
    if (!journey || journey.status !== 'completed' || !journey.result) {
      const status = journey?.status ?? 'not-started';
      excludedByStatus[status] = (excludedByStatus[status] ?? 0) + 1;
    }
  }
  const outcomes: Record<string, number> = {};
  const archetypes: PollingReport['archetypes'] = {};
  const items: PollingReport['items'] = {};
  const journeys: PollingReport['journeys'] = [];
  let attempts = 0; let latencyTotal = 0; let latencyCount = 0; let inputTokens = 0; let outputTokens = 0;
  let confidenceTotal = 0; let confidenceCount = 0; let billedUsd = 0; let unknownCharges = 0;
  for (const readerId of intended) {
    const journey = checkpoint.journeys.find((record) => record.readerId === readerId);
    const archetypeId = archetypeByReader.get(readerId) ?? null;
    const bucket = archetypeId ? (archetypes[archetypeId] ??= { intended: 0, completed: 0, outcomes: {} }) : undefined;
    if (bucket) bucket.intended += 1;
    const isComplete = journey?.status === 'completed' && journey.result !== undefined;
    const result = isComplete ? journey.result : undefined;
    const outcome = result?.outcome ?? null;
    if (result) {
      if (outcome !== null) { outcomes[outcome] = (outcomes[outcome] ?? 0) + 1; if (bucket) bucket.outcomes[outcome] = (bucket.outcomes[outcome] ?? 0) + 1; }
      if (bucket) bucket.completed += 1;
      for (const event of result.events) {
        if (event.type !== 'exposure') continue;
        const item = items[event.itemId] ??= { exposures: 0, readers: 0 };
        item.exposures += 1;
      }
      const exposed = new Set(result.events.filter((event) => event.type === 'exposure').map((event) => event.itemId));
      for (const itemId of exposed) items[itemId]!.readers += 1;
    }
    const decisions = (journey?.decisions ?? []).map(({ decisionId, result: decision }) => {
      attempts += decision.attempts; latencyTotal += decision.latencyMs; latencyCount += 1;
      inputTokens += decision.usage.inputTokens ?? 0; outputTokens += decision.usage.outputTokens ?? 0;
      if (decision.confidence !== undefined) { confidenceTotal += decision.confidence; confidenceCount += 1; }
      if (decision.chargeStatus === 'billed') billedUsd += decision.chargeUsd ?? 0;
      if (decision.chargeStatus === 'unknown') unknownCharges += 1;
      return { decisionId, choice: decision.choice, attempts: decision.attempts, latencyMs: decision.latencyMs, inputTokens: decision.usage.inputTokens ?? null, outputTokens: decision.usage.outputTokens ?? null, confidence: decision.confidence ?? null, chargeStatus: decision.chargeStatus, chargeUsd: decision.chargeUsd ?? null };
    });
    journeys.push({ readerId, archetypeId, status: journey?.status ?? 'not-started', outcome, events: result?.events ?? [], decisions });
  }
  const rawProvider = checkpoint.provider;
  const report = {
    formatVersion: 1 as const, runId: checkpoint.runId, status: checkpoint.status,
    stimulusFingerprint: checkpoint.stimulusFingerprint, executionFingerprint: checkpoint.executionFingerprint,
    provider: { kind: rawProvider.kind, model: rawProvider.kind === 'jev' ? rawProvider.model : null, checkpoint: rawProvider.kind === 'laya' ? rawProvider.checkpoint : null },
    denominator: { intended: intended.length, completed: completedJourneys.length, excluded: intended.length - completedJourneys.length, excludedByStatus },
    outcomes, archetypes, items, journeys,
    providerEvidence: { attempts, meanLatencyMs: latencyCount ? latencyTotal / latencyCount : null, inputTokens, outputTokens, confidence: { count: confidenceCount, mean: confidenceCount ? confidenceTotal / confidenceCount : null }, billedUsd, unknownCharges, unsupportedJourneys: checkpoint.journeys.filter((journey) => journey.failureKind === 'unsupported-input').length, failedJourneys: checkpoint.journeys.filter((journey) => journey.status === 'failed').length },
  };
  return pollingReportSchema.parse(report);
}

export async function getReport(outputDirectory: string, runId: string): Promise<PollingReport> {
  const checkpoint = await new CheckpointStore(path.resolve(outputDirectory)).read(runId);
  return buildReport(checkpoint);
}

export function compareReports(left: PollingReport, right: PollingReport) {
  if (left.stimulusFingerprint !== right.stimulusFingerprint) throw new Error('Reports have different stimulus fingerprints and cannot be compared.');
  const rightByReader = new Map(right.journeys.filter((journey) => journey.status === 'completed').map((journey) => [journey.readerId, journey]));
  const matched = left.journeys.filter((journey) => journey.status === 'completed' && rightByReader.has(journey.readerId));
  const readers = matched.map((journey) => {
    const other = rightByReader.get(journey.readerId)!;
    const leftChoices = new Map(journey.decisions.map((decision) => [decision.decisionId, decision.choice]));
    const rightChoices = new Map(other.decisions.map((decision) => [decision.decisionId, decision.choice]));
    const common = [...leftChoices.keys()].filter((id) => rightChoices.has(id));
    const agreements = common.filter((id) => leftChoices.get(id) === rightChoices.get(id)).length;
    return { readerId: journey.readerId, leftOutcome: journey.outcome, rightOutcome: other.outcome, outcomeAgreement: journey.outcome === other.outcome, commonDecisionCount: common.length, choiceAgreements: agreements, choiceDivergences: common.length - agreements };
  });
  return { stimulusFingerprint: left.stimulusFingerprint, leftRunId: left.runId, rightRunId: right.runId, matchedCompletedReaders: readers.length, unmatchedCompletedLeft: left.denominator.completed - readers.length, unmatchedCompletedRight: right.denominator.completed - readers.length, readers };
}
