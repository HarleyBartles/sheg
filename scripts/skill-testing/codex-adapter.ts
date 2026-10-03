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

export function createCodexAdapter(options: { executable?: string; args?: string[] } = {}): CampaignAdapter {
  const executable = options.executable ?? process.env.SHEG_CODEX_EXECUTABLE ?? 'codex';
  return {
    async execute(input): Promise<ExecutionResult> {
      const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'sheg-codex-trial-'));
      const finalMessagePath = path.join(temporaryRoot, 'final-message.txt');
      const requested = input.requestedSettings;
      const args = [
        'exec', '--json', '--ephemeral', '--skip-git-repo-check',
        '-C', input.cwd,
        '--output-last-message', finalMessagePath,
      ];
      const model = requested.model;
      if (typeof model === 'string' && model.length > 0) args.push('--model', model);
      const reasoning = requested.reasoning;
      if (typeof reasoning === 'string' && reasoning.length > 0) args.push('-c', `model_reasoning_effort=${JSON.stringify(reasoning)}`);
      args.push(...(options.args ?? []), '-');
      try {
        const result = await new Promise<{ status: ExecutionResult['status']; exitCode: number | null; rawEvents: string; rawStderr: string }>((resolve, reject) => {
        const child = spawn(executable, args, { cwd: input.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
          sessionId: observation.sessionId,
          observedSettings: observation.settings,
        };
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    },
  };
}
