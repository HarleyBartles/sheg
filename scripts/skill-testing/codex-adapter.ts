import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CampaignAdapter, ExecutionResult } from './runner.js';

interface CodexEvent {
  type?: string;
  thread_id?: string;
  model?: string;
  info?: { model?: string };
  turn_context?: { model?: string };
}

function observe(events: string): { sessionId: string | null; settings: Record<string, unknown> } {
  let sessionId: string | null = null;
  let model: string | undefined;
  for (const line of events.split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line) as CodexEvent;
      if (event.type === 'thread.started' && event.thread_id) sessionId = event.thread_id;
      model = event.model ?? event.info?.model ?? event.turn_context?.model ?? model;
    } catch { /* Preserve unknown event lines; ignore them when extracting metadata. */ }
  }
  return { sessionId, settings: model ? { model } : {} };
}

export function createCodexAdapter(options: { executable?: string; args?: string[]; spawnProcess?: typeof spawn } = {}): CampaignAdapter {
  const executable = options.executable ?? process.env.SHEG_CODEX_EXECUTABLE ?? 'codex';
  const spawnProcess = options.spawnProcess ?? spawn;
  const execute: CampaignAdapter['execute'] = async (input): Promise<ExecutionResult> => {
      const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'sheg-codex-trial-'));
      const finalMessagePath = path.join(temporaryRoot, 'final-message.txt');
      const requested = input.requestedSettings;
      const args = input.resumeSessionId
        ? ['exec', 'resume', input.resumeSessionId, '--json', '--skip-git-repo-check', '-o', finalMessagePath]
        : ['exec', '--json', ...(input.persistent ? [] : ['--ephemeral']), '--skip-git-repo-check', '-C', input.cwd, '-o', finalMessagePath];
      const model = requested.model;
      if (typeof model === 'string' && model.length > 0) args.push('--model', model);
      const reasoning = requested.reasoning;
      if (typeof reasoning === 'string' && reasoning.length > 0) args.push('-c', `model_reasoning_effort=${JSON.stringify(reasoning)}`);
      args.push(...(options.args ?? []), '-');
      try {
        const result = await new Promise<{ status: ExecutionResult['status']; exitCode: number | null; rawEvents: string; rawStderr: string }>((resolve, reject) => {
        const child = spawnProcess(executable, args, { cwd: input.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SHEG_DATA_DIR: path.join(input.cwd, 'sheg-data') } });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let settled = false;
        const finish = (value: { status: ExecutionResult['status']; exitCode: number | null; rawEvents: string; rawStderr: string }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          input.signal?.removeEventListener('abort', abort);
          resolve(value);
        };
        const timer = setTimeout(() => {
          child.kill();
          finish({ status: 'timed-out', exitCode: null, rawEvents: Buffer.concat(stdout).toString('utf8'), rawStderr: Buffer.concat(stderr).toString('utf8') });
        }, input.timeoutMs);
        const abort = () => {
          child.kill();
          finish({ status: 'failed', exitCode: null, rawEvents: Buffer.concat(stdout).toString('utf8'), rawStderr: Buffer.concat(stderr).toString('utf8') });
        };
        if (input.signal?.aborted) abort();
        else input.signal?.addEventListener('abort', abort, { once: true });
        child.on('error', (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          input.signal?.removeEventListener('abort', abort);
          reject(error);
        });
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
        child.on('close', (code) => finish({
          status: code === 0 ? 'completed' : 'failed',
          exitCode: code,
          rawEvents: Buffer.concat(stdout).toString('utf8'),
          rawStderr: Buffer.concat(stderr).toString('utf8'),
        }));
        child.stdin.on('error', () => { /* A child that exits early is classified by its close event. */ });
        child.stdin.end(input.prompt, 'utf8');
        });
        const finalMessage = (() => { try { return readFileSync(finalMessagePath, 'utf8'); } catch { return ''; } })();
        const observation = observe(result.rawEvents);
        return {
          ...result,
          rawFinalMessage: finalMessage,
          sessionId: observation.sessionId ?? input.resumeSessionId ?? null,
          observedSettings: observation.settings,
        };
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    };
  const executeWorkflow: NonNullable<CampaignAdapter['executeWorkflow']> = async (input) => {
    const prompts = [input.initialPrompt, ...input.turns];
    const events: string[] = [];
    const messages: string[] = [];
    const errors: string[] = [];
    let sessionId: string | null = null;
    let observedSettings: Record<string, unknown> = {};
    let exitCode: number | null = null;
    for (const [index, prompt] of prompts.entries()) {
      const result = await execute({ ...input, prompt, persistent: true, ...(sessionId ? { resumeSessionId: sessionId } : {}) });
      if (result.rawEvents) events.push(result.rawEvents);
      if (result.rawFinalMessage) messages.push(`## Turn ${index + 1}\n${result.rawFinalMessage}`);
      if (result.rawStderr) errors.push(result.rawStderr);
      sessionId = result.sessionId ?? sessionId;
      observedSettings = { ...observedSettings, ...result.observedSettings };
      exitCode = result.exitCode;
      if (result.status !== 'completed') return { ...result, rawEvents: events.join(''), rawFinalMessage: messages.join('\n\n'), rawStderr: errors.join('\n'), sessionId, observedSettings };
      if (index < prompts.length - 1 && !sessionId) return { status: 'failed', exitCode, rawEvents: events.join(''), rawFinalMessage: messages.join('\n\n'), rawStderr: `${errors.join('\n')}\nCodex did not expose a session ID; conversation cannot safely continue.`, sessionId: null, observedSettings };
    }
    return { status: 'completed', exitCode, rawEvents: events.join(''), rawFinalMessage: messages.join('\n\n'), rawStderr: errors.join('\n'), sessionId, observedSettings };
  };
  return { execute, executeWorkflow };
}
