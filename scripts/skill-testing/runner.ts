import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { campaignManifestSchema, type CampaignManifest } from './contracts.js';

export interface ExecutionResult {
  status: 'completed' | 'timed-out' | 'failed';
  exitCode: number | null;
  rawEvents: string;
  rawFinalMessage: string;
  rawStderr: string;
  sessionId: string | null;
  observedSettings: Record<string, unknown>;
}

export interface CampaignAdapter {
  execute(input: { prompt: string; cwd: string; timeoutMs: number; requestedSettings: Record<string, unknown>; signal?: AbortSignal; persistent?: boolean; resumeSessionId?: string }): Promise<ExecutionResult>;
  executeWorkflow?(input: { initialPrompt: string; turns: string[]; cwd: string; timeoutMs: number; requestedSettings: Record<string, unknown>; signal?: AbortSignal }): Promise<ExecutionResult>;
}

interface JournalEntry {
  type: 'trial-added' | 'attempt-started' | 'output-captured' | 'runtime-error' | 'attempt-interrupted';
  trialId?: string;
  attemptId?: string;
  armId?: string;
  repetition?: number;
  result?: Pick<ExecutionResult, 'status' | 'exitCode' | 'sessionId' | 'observedSettings'>;
  error?: string;
}

export interface CampaignRunSummary {
  captured: number;
  runtimeErrors: number;
  interrupted: number;
}

function campaignFiles(campaignDirectory: string): { root: string; manifest: CampaignManifest; journal: string } {
  const root = path.resolve(campaignDirectory);
  const manifest = campaignManifestSchema.parse(JSON.parse(readFileSync(path.join(root, 'campaign.json'), 'utf8')));
  return { root, manifest, journal: path.join(root, 'attempts.jsonl') };
}

function journalEntries(journal: string): JournalEntry[] {
  if (!existsSync(journal)) return [];
  return readFileSync(journal, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as JournalEntry);
}

function append(journal: string, entry: JournalEntry): void {
  appendFileSync(journal, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' });
}

function writeAtomic(filePath: string, value: string): void {
  const temporary = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporary, value, { encoding: 'utf8', flag: 'wx' });
  renameSync(temporary, filePath);
}

function fileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function resultSummary(result: ExecutionResult): NonNullable<JournalEntry['result']> {
  return { status: result.status, exitCode: result.exitCode, sessionId: result.sessionId, observedSettings: result.observedSettings };
}

function currentTrials(manifest: CampaignManifest, entries: JournalEntry[]): CampaignManifest['trials'] {
  const additions = entries.filter((entry) => entry.type === 'trial-added').map((entry) => ({
    trialId: entry.trialId!, armId: entry.armId!, repetition: entry.repetition!, attempts: [`${entry.trialId}:attempt-001`],
  }));
  return [...manifest.trials, ...additions];
}

export function addTrial(campaignDirectory: string, armId: string): CampaignManifest['trials'][number] {
  const { manifest, journal } = campaignFiles(campaignDirectory);
  if (!manifest.arms.some((arm) => arm.id === armId)) throw new Error(`Unknown campaign arm: ${armId}`);
  const entries = journalEntries(journal);
  const existing = currentTrials(manifest, entries).filter((trial) => trial.armId === armId);
  const repetition = Math.max(0, ...existing.map((trial) => trial.repetition)) + 1;
  const trialId = `${manifest.scenarioId}@v${manifest.scenarioVersion}:${armId}:${String(repetition).padStart(3, '0')}`;
  if (existing.some((trial) => trial.trialId === trialId)) throw new Error(`Trial already exists: ${trialId}`);
  append(journal, { type: 'trial-added', trialId, armId, repetition });
  return { trialId, armId, repetition, attempts: [`${trialId}:attempt-001`] };
}

export async function runCampaign(
  campaignDirectory: string,
  adapter: CampaignAdapter,
  options: { concurrency?: number; afterCapture?: (trialId: string) => void; signal?: AbortSignal } = {},
): Promise<CampaignRunSummary> {
  const { root, manifest, journal } = campaignFiles(campaignDirectory);
  if (manifest.suite === 'workflow' && !adapter.executeWorkflow) throw new Error('Workflow campaign requires an adapter with persistent conversation support.');
  const concurrency = options.concurrency ?? manifest.concurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > manifest.concurrency) {
    throw new Error(`Campaign concurrency must be between 1 and ${manifest.concurrency}.`);
  }
  mkdirSync(path.join(root, 'attempts'), { recursive: true });
  const initial = journalEntries(journal);
  const trials = currentTrials(manifest, initial);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < trials.length) {
      const trial = trials[cursor++];
      if (!trial) continue;
      const before = journalEntries(journal).filter((entry) => entry.trialId === trial.trialId);
      if (before.some((entry) => entry.type === 'output-captured')) continue;
      const started = before.filter((entry) => entry.type === 'attempt-started').length;
      const finished = new Set(before.filter((entry) => ['output-captured', 'runtime-error', 'attempt-interrupted'].includes(entry.type)).map((entry) => entry.attemptId));
      const orphan = before.findLast((entry) => entry.type === 'attempt-started' && !finished.has(entry.attemptId));
      if (orphan?.attemptId) append(journal, { type: 'attempt-interrupted', trialId: trial.trialId, attemptId: orphan.attemptId, error: 'No terminal record followed the attempt start.' });
      const attemptNumber = started + 1;
      const attemptId = `${trial.trialId}:attempt-${String(attemptNumber).padStart(3, '0')}`;
      append(journal, { type: 'attempt-started', trialId: trial.trialId, attemptId, armId: trial.armId, repetition: trial.repetition });
      const arm = manifest.arms.find((candidate) => candidate.id === trial.armId);
      if (!arm) throw new Error(`Campaign manifest has no arm ${trial.armId}.`);
      let result: ExecutionResult;
      try {
        const cwd = campaignScratchRoot(root, trial.trialId, attemptId);
        mkdirSync(cwd, { recursive: true });
        if (manifest.suite === 'workflow') {
          const marker = '\n## User request\n';
          const userBoundary = arm.actorPrompt.indexOf(marker);
          if (userBoundary < 0 || !manifest.workflowTurns?.length) throw new Error('Workflow prompt or frozen turns are missing.');
          const turns = manifest.workflowTurns.map((turn) => `${turn.user}${turn.evidence === undefined ? '' : `\n\nEvidence for this turn only:\n${JSON.stringify(turn.evidence)}`}`);
          const workflowPrelude = arm.actorPrompt.slice(0, userBoundary)
            .replace('Use the supplied skill and references to respond to the user request. Treat the evidence below as a mock fixture, not a live tool result.', 'Use the supplied skill and references to handle the conversation. The scripted evidence is fixture data supplied only at its listed turn.')
            .replace('Do not call tools, connectors, inference providers, or external services. If a tool action would help, record it as a proposed action only.', 'Sheg MCP tools are available when relevant to the user request. You may use them to inspect, start, query, or resume studies. Do not call tools outside Sheg or use hosted inference. Never invent a tool result; report unavailable local services clearly.')
            .replace('Return only JSON with scenarioId, scenarioVersion, actions (objects with tool and input), finalResponse, and uncertainties.', 'Respond to the user naturally and use tools when needed.');
          result = await adapter.executeWorkflow!({
            initialPrompt: `${workflowPrelude}\n## Workflow turn 1\n${turns[0]}`,
            turns: turns.slice(1), cwd, timeoutMs: manifest.timeoutMs, requestedSettings: manifest.execution,
            ...(options.signal ? { signal: options.signal } : {}),
          });
        } else {
          result = await adapter.execute({
            prompt: manifest.suite === 'discovery' ? arm.discoveryPrompt : arm.actorPrompt,
            cwd, timeoutMs: manifest.timeoutMs, requestedSettings: manifest.execution,
            ...(options.signal ? { signal: options.signal } : {}),
          });
        }
      } catch (error) {
        append(journal, { type: 'runtime-error', trialId: trial.trialId, attemptId, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const attemptRoot = path.join(root, 'attempts', fileSegment(trial.trialId), fileSegment(attemptId));
      mkdirSync(attemptRoot, { recursive: true });
      const shegDataDirectory = path.join(campaignScratchRoot(root, trial.trialId, attemptId), 'sheg-data');
      if (existsSync(shegDataDirectory)) cpSync(shegDataDirectory, path.join(attemptRoot, 'sheg-data'), { recursive: true, errorOnExist: true });
      writeAtomic(path.join(attemptRoot, 'raw-events.jsonl'), result.rawEvents);
      writeAtomic(path.join(attemptRoot, 'raw-final-message.txt'), result.rawFinalMessage);
      writeAtomic(path.join(attemptRoot, 'raw-stderr.txt'), result.rawStderr);
      writeAtomic(path.join(attemptRoot, 'result.json'), `${JSON.stringify({
        requestedSettings: manifest.execution,
        observedSettings: result.observedSettings,
        retainedShegData: existsSync(path.join(attemptRoot, 'sheg-data')) ? 'sheg-data/' : null,
        sessionId: result.sessionId,
        exitCode: result.exitCode,
        status: result.status,
      }, null, 2)}\n`);
      if (result.status === 'completed') append(journal, { type: 'output-captured', trialId: trial.trialId, attemptId, result: resultSummary(result) });
      else append(journal, { type: 'runtime-error', trialId: trial.trialId, attemptId, error: `Adapter ended with ${result.status} (exit ${String(result.exitCode)}).`, result: resultSummary(result) });
      options.afterCapture?.(trial.trialId);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const finalEntries = journalEntries(journal);
  const finalTrials = currentTrials(manifest, finalEntries);
  let captured = 0;
  let runtimeErrors = 0;
  let interrupted = 0;
  for (const trial of finalTrials) {
    const entries = finalEntries.filter((entry) => entry.trialId === trial.trialId);
    if (entries.some((entry) => entry.type === 'output-captured')) captured += 1;
    else if (entries.some((entry) => entry.type === 'runtime-error')) runtimeErrors += 1;
    else if (entries.some((entry) => entry.type === 'attempt-interrupted')) interrupted += 1;
  }
  return { captured, runtimeErrors, interrupted };
}

export function campaignScratchRoot(campaignDirectory: string, trialId: string, attemptId: string): string {
  const key = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'sheg-skill-campaign', key(path.resolve(campaignDirectory)), key(trialId), key(attemptId));
}
