import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFrozenCampaign, type CampaignManifest } from './contracts.js';
import { sha256, stableJson } from './snapshots.js';

export interface ExecutionResult {
  status: 'completed' | 'timed-out' | 'failed';
  exitCode: number | null;
  rawEvents: string;
  rawFinalMessage: string;
  rawStderr: string;
  sessionId: string | null;
  observedSettings: Record<string, unknown>;
  workflowTurnEvents?: string[];
}

export interface CampaignAdapter {
  preflight?(): Promise<Record<string, unknown>>;
  execute(input: { prompt: string; cwd: string; timeoutMs: number; requestedSettings: Record<string, unknown>; signal?: AbortSignal; persistent?: boolean; resumeSessionId?: string }): Promise<ExecutionResult>;
  executeWorkflow?(input: { initialPrompt: string; turns: string[]; cwd: string; timeoutMs: number; requestedSettings: Record<string, unknown>; signal?: AbortSignal }): Promise<ExecutionResult>;
}

interface JournalEntry {
  type: 'campaign-prepared' | 'actor-runtime-preflight' | 'grader-runtime-preflight' | 'trial-added' | 'attempt-started' | 'output-captured' | 'runtime-error' | 'attempt-interrupted';
  trialId?: string;
  attemptId?: string;
  armId?: string;
  repetition?: number;
  result?: Pick<ExecutionResult, 'status' | 'exitCode' | 'sessionId' | 'observedSettings'>;
  error?: string;
  runtimeIdentity?: Record<string, unknown>;
  runtimeIdentitySha256?: string;
}

export interface CampaignRunSummary {
  captured: number;
  runtimeErrors: number;
  interrupted: number;
}

function campaignFiles(campaignDirectory: string): { root: string; manifest: CampaignManifest; journal: string } {
  const root = path.resolve(campaignDirectory);
  const manifest = readFrozenCampaign(root);
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
  options: { concurrency?: number; afterOutputFiles?: (trialId: string) => void; afterCapture?: (trialId: string) => void; signal?: AbortSignal } = {},
): Promise<CampaignRunSummary> {
  const { root, manifest, journal } = campaignFiles(campaignDirectory);
  if (manifest.suite === 'workflow' && !adapter.executeWorkflow) throw new Error('Workflow campaign requires an adapter with persistent conversation support.');
  const concurrency = options.concurrency ?? manifest.concurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > manifest.concurrency) {
    throw new Error(`Campaign concurrency must be between 1 and ${manifest.concurrency}.`);
  }
  const adapterRuntimeIdentity = adapter.preflight
    ? await adapter.preflight()
    : { adapter: typeof manifest.execution.adapter === 'string' ? manifest.execution.adapter : 'custom', executionSha256: manifest.basis.executionSha256 };
  const runtimeIdentity = { ...adapterRuntimeIdentity, effectiveConcurrency: concurrency };
  const runtimeIdentitySha256 = sha256(stableJson(runtimeIdentity));
  const existingRuntime = journalEntries(journal).find((entry) => entry.type === 'actor-runtime-preflight');
  if (existingRuntime?.runtimeIdentitySha256 && existingRuntime.runtimeIdentitySha256 !== runtimeIdentitySha256) throw new Error('Campaign runtime identity changed since its first execution.');
  if (!existingRuntime) append(journal, { type: 'actor-runtime-preflight', runtimeIdentitySha256, runtimeIdentity });
  mkdirSync(path.join(root, 'attempts'), { recursive: true });
  const initial = journalEntries(journal);
  const trials = currentTrials(manifest, initial);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < trials.length) {
      const trial = trials[cursor++];
      if (!trial) continue;
      let before = journalEntries(journal).filter((entry) => entry.trialId === trial.trialId);
      recoverCompleteAttemptBundles(root, trial, before, journal);
      before = journalEntries(journal).filter((entry) => entry.trialId === trial.trialId);
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
      const cwd = campaignScratchRoot(root, trial.trialId, attemptId);
      try {
        mkdirSync(cwd, { recursive: true });
        let result: ExecutionResult;
        let dispatchedPromptSha256: string;
        if (manifest.suite === 'workflow') {
          const marker = '\n## User request\n';
          const userBoundary = arm.actorPrompt.indexOf(marker);
          const guidanceMarker = '\n## Current skill and declared references\n';
          const guidanceBoundary = arm.actorPrompt.indexOf(guidanceMarker);
          if (userBoundary < 0 || (guidanceBoundary < 0 && Object.keys(arm.skillReferenceHashes).length > 0) || !manifest.workflowTurns?.length) throw new Error('Workflow prompt, frozen guidance, or turns are missing.');
          const turns = manifest.workflowTurns.map((turn) => `${turn.user}${turn.evidence === undefined ? '' : `\n\nEvidence for this turn only:\n${JSON.stringify(turn.evidence)}`}`);
          const guidance = guidanceBoundary >= 0 ? arm.actorPrompt.slice(guidanceBoundary) : '';
          const workflowPrelude = `${arm.actorPrompt.slice(0, userBoundary)}${guidance}`
            .replace('Use the supplied skill and references to respond to the user request. Treat the evidence below as a mock fixture, not a live tool result.', 'Use the supplied skill and references to handle the conversation. The scripted evidence is fixture data supplied only at its listed turn.')
            .replace('Do not call tools, connectors, inference providers, or external services. If an action would help, describe it in the response rather than executing it.', 'Sheg MCP tools are available when relevant to the user request. You may use them to inspect, start, query, or resume studies. Do not call tools outside Sheg or use hosted inference. Never invent a tool result; report unavailable local services clearly.')
            .replace('Do not call tools, connectors, inference providers, or external services. If a tool action would help, record it as a proposed action only.', 'Sheg MCP tools are available when relevant to the user request. You may use them to inspect, start, query, or resume studies. Do not call tools outside Sheg or use hosted inference. Never invent a tool result; report unavailable local services clearly.')
            .replace('Return only JSON with scenarioId, scenarioVersion, actions (objects with tool and input), finalResponse, and uncertainties.', 'Respond to the user naturally and use tools when needed.');
          const workflowPrompts = [`${workflowPrelude}\n## Workflow turn 1\n${turns[0]}`, ...turns.slice(1)];
          dispatchedPromptSha256 = sha256(JSON.stringify(workflowPrompts));
          result = await adapter.executeWorkflow!({
            initialPrompt: workflowPrompts[0]!,
            turns: turns.slice(1), cwd, timeoutMs: manifest.timeoutMs, requestedSettings: manifest.execution,
            ...(options.signal ? { signal: options.signal } : {}),
          });
        } else {
          const prompt = manifest.suite === 'discovery' ? arm.discoveryPrompt : arm.actorPrompt;
          dispatchedPromptSha256 = sha256(prompt);
          result = await adapter.execute({
            prompt,
            cwd, timeoutMs: manifest.timeoutMs, requestedSettings: manifest.execution,
            ...(options.signal ? { signal: options.signal } : {}),
          });
        }
        const attemptRoot = path.join(root, 'attempts', fileSegment(trial.trialId), fileSegment(attemptId));
        mkdirSync(attemptRoot, { recursive: true });
        const shegDataDirectory = path.join(cwd, 'sheg-data');
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
          dispatchedPromptSha256,
          ...(result.workflowTurnEvents ? { workflowTurnEvents: result.workflowTurnEvents } : {}),
        }, null, 2)}\n`);
        options.afterOutputFiles?.(trial.trialId);
        if (result.status === 'completed') append(journal, { type: 'output-captured', trialId: trial.trialId, attemptId, result: resultSummary(result) });
        else append(journal, { type: 'runtime-error', trialId: trial.trialId, attemptId, error: `Adapter ended with ${result.status} (exit ${String(result.exitCode)}).`, result: resultSummary(result) });
        options.afterCapture?.(trial.trialId);
      } catch (error) {
        const attemptEntries = journalEntries(journal).filter((entry) => entry.trialId === trial.trialId && entry.attemptId === attemptId);
        const attemptRoot = path.join(root, 'attempts', fileSegment(trial.trialId), fileSegment(attemptId));
        const completeBundle = ['result.json', 'raw-events.jsonl', 'raw-final-message.txt', 'raw-stderr.txt'].every((name) => existsSync(path.join(attemptRoot, name)));
        if ((options.afterOutputFiles && completeBundle) || (options.afterCapture && attemptEntries.some((entry) => entry.type === 'output-captured'))) throw error;
        if (!attemptEntries.some((entry) => ['output-captured', 'runtime-error', 'attempt-interrupted'].includes(entry.type))) {
          append(journal, { type: 'runtime-error', trialId: trial.trialId, attemptId, error: error instanceof Error ? error.message : String(error) });
        }
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
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

function recoverCompleteAttemptBundles(root: string, trial: CampaignManifest['trials'][number], entries: JournalEntry[], journal: string): void {
  const terminal = new Set(entries.filter((entry) => ['output-captured', 'runtime-error', 'attempt-interrupted'].includes(entry.type)).map((entry) => entry.attemptId));
  for (const started of entries.filter((entry) => entry.type === 'attempt-started' && entry.attemptId && !terminal.has(entry.attemptId))) {
    const attemptId = started.attemptId;
    if (!attemptId) continue;
    const attemptRoot = path.join(root, 'attempts', fileSegment(trial.trialId), fileSegment(attemptId));
    const resultPath = path.join(attemptRoot, 'result.json');
    const rawPaths = ['raw-events.jsonl', 'raw-final-message.txt', 'raw-stderr.txt'].map((name) => path.join(attemptRoot, name));
    if (!existsSync(resultPath) || rawPaths.some((target) => !existsSync(target))) continue;
    try {
      const saved = JSON.parse(readFileSync(resultPath, 'utf8')) as { status?: unknown; exitCode?: unknown; sessionId?: unknown; observedSettings?: unknown };
      if (!['completed', 'timed-out', 'failed'].includes(String(saved.status)) || !(saved.exitCode === null || Number.isInteger(saved.exitCode)) || !(saved.sessionId === null || typeof saved.sessionId === 'string') || typeof saved.observedSettings !== 'object' || saved.observedSettings === null || Array.isArray(saved.observedSettings)) continue;
      const result = { status: saved.status as ExecutionResult['status'], exitCode: saved.exitCode as number | null, sessionId: saved.sessionId as string | null, observedSettings: saved.observedSettings as Record<string, unknown> };
      if (result.status === 'completed') append(journal, { type: 'output-captured', trialId: trial.trialId, attemptId, result });
      else append(journal, { type: 'runtime-error', trialId: trial.trialId, attemptId, error: `Recovered captured attempt status ${result.status}.`, result });
    } catch { /* Incomplete attempt bundles remain interrupted and are retried under a new attempt ID. */ }
  }
}

export function campaignScratchRoot(campaignDirectory: string, trialId: string, attemptId: string): string {
  const key = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'sheg-skill-campaign', key(path.resolve(campaignDirectory)), key(trialId), key(attemptId));
}

export function discardCampaign(campaignDirectory: string): void {
  const root = path.resolve(campaignDirectory);
  const campaignHash = sha256(root).slice(0, 16);
  rmSync(path.join(os.tmpdir(), 'sheg-skill-campaign', campaignHash), { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
