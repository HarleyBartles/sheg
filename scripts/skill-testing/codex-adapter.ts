import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CampaignAdapter, ExecutionResult, WorkflowSetup } from './runner.js';
import { sha256, stableJson } from './snapshots.js';

interface CodexEvent {
  type?: string;
  thread_id?: string;
  model?: string;
  info?: { model?: string };
  turn_context?: { model?: string };
}

interface ShegMcpServerConfig {
  enabled?: boolean;
  transport?: { type?: string; command?: string; args?: string[]; env?: Record<string, string>; cwd?: string };
  enabled_tools?: string[] | null;
  disabled_tools?: string[] | null;
  startup_timeout_sec?: number | null;
  tool_timeout_sec?: number | null;
}

interface ControlledCandidateMcp {
  version: string;
  root: string;
  harnessPath: string;
  sourceSha256: string;
}

export function resolveControlledCandidateMcp(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')): ControlledCandidateMcp {
  const packagePath = path.join(root, 'package.json');
  const pluginPath = path.join(root, 'plugin.json');
  const harnessPath = path.join(root, 'scripts', 'skill-testing', 'recovery-mcp.ts');
  const providerPath = path.join(root, 'scripts', 'skill-testing', 'controlled-recovery.ts');
  for (const candidatePath of [packagePath, pluginPath, harnessPath, providerPath]) {
    if (!existsSync(candidatePath)) throw new Error(`Controlled recovery requires the candidate source harness: ${path.relative(root, candidatePath)} is missing.`);
  }
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown };
  const pluginJson = JSON.parse(readFileSync(pluginPath, 'utf8')) as { version?: unknown };
  if (typeof packageJson.version !== 'string' || packageJson.version !== pluginJson.version) throw new Error('Controlled recovery candidate package and plugin versions do not match.');
  const sourceFiles = readdirSync(path.join(root, 'src'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .concat(harnessPath, providerPath)
    .sort();
  const sourceIdentity = sourceFiles.map((file) => [path.relative(root, file).replaceAll('\\', '/'), sha256(readFileSync(file, 'utf8'))]);
  return {
    version: packageJson.version,
    root,
    harnessPath,
    sourceSha256: sha256(stableJson(sourceIdentity)),
  };
}

function isRecoverySetup(setup: WorkflowSetup | undefined): boolean {
  return setup?.kind === 'partial-journey-recovery' && setup.version === 1;
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

export function createCodexAdapter(options: { executable?: string; args?: string[]; spawnProcess?: typeof spawn; spawnSyncProcess?: typeof spawnSync; shegMcpConfig?: ShegMcpServerConfig } = {}): CampaignAdapter {
  const executable = options.executable ?? process.env.SHEG_CODEX_EXECUTABLE ?? 'codex';
  const spawnProcess = options.spawnProcess ?? spawn;
  const spawnSyncProcess = options.spawnSyncProcess ?? spawnSync;
  const probe = (args: string[], purpose: string): string => {
    const result = spawnSyncProcess(executable, args, { encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`Codex preflight could not ${purpose}: ${result.error?.message ?? `exit ${String(result.status)}`}.`);
    return String(result.stdout ?? '');
  };
  const getShegConfig = () => {
    const value = options.shegMcpConfig ?? JSON.parse(probe(['mcp', 'get', 'sheg', '--json'], 'read the Sheg MCP server configuration')) as ShegMcpServerConfig;
    if (!value.enabled || value.transport?.type !== 'stdio' || !value.transport.command || !value.transport.cwd) throw new Error('Cannot isolate Sheg MCP storage because the configured Sheg server is not an enabled stdio server.');
    return value;
  };
  let cachedShegConfig: ReturnType<typeof getShegConfig> | undefined;
  let cachedCandidate: ControlledCandidateMcp | undefined;
  const candidateForRecovery = () => cachedCandidate ??= resolveControlledCandidateMcp();
  const preflightPromises = new Map<string, Promise<Record<string, unknown>>>();
  const shegConfigFor = (workflowSetup?: WorkflowSetup) => {
    const configured = cachedShegConfig ??= getShegConfig();
    if (!isRecoverySetup(workflowSetup)) return configured;
    const candidate = candidateForRecovery();
    return {
      ...configured,
      transport: { type: 'stdio', command: process.execPath, args: ['--import', 'tsx', candidate.harnessPath], cwd: candidate.root, env: { NODE_ENV: 'test', SHEG_TEST_PROVIDER: 'partial-journey-recovery' } },
    } satisfies ShegMcpServerConfig;
  };
  const preflight = async (workflowSetup?: WorkflowSetup): Promise<Record<string, unknown>> => {
    const setupKey = stableJson(workflowSetup ?? null);
    let preflightPromise = preflightPromises.get(setupKey);
    if (!preflightPromise) {
      preflightPromise = Promise.resolve().then(() => {
      const version = probe(['--version'], 'read its version').trim();
      const execHelp = probe(['exec', '--help'], 'inspect exec capabilities');
      const resumeHelp = probe(['exec', 'resume', '--help'], 'inspect resume capabilities');
      const requireFlag = (help: string, flag: string, mode: string) => {
        if (!help.includes(flag)) throw new Error(`Codex preflight found required ${mode} flag ${flag} unsupported by the installed CLI.`);
      };
      for (const flag of ['--json', '--ephemeral', '--skip-git-repo-check', '-C', '-o']) requireFlag(execHelp, flag, 'exec');
      for (const flag of ['--json', '--skip-git-repo-check', '-o']) requireFlag(resumeHelp, flag, 'resume');
      const activeShegConfig = shegConfigFor(workflowSetup);
      const candidate = isRecoverySetup(workflowSetup) ? candidateForRecovery() : undefined;
      const env = activeShegConfig.transport?.env ?? {};
      const configFingerprint = sha256(stableJson({
        enabled: activeShegConfig.enabled,
        transport: { type: activeShegConfig.transport?.type, command: activeShegConfig.transport?.command, args: activeShegConfig.transport?.args ?? [], cwd: activeShegConfig.transport?.cwd, envSha256: sha256(stableJson(env)) },
        enabledTools: activeShegConfig.enabled_tools ?? null,
        disabledTools: activeShegConfig.disabled_tools ?? null,
        startupTimeoutSec: activeShegConfig.startup_timeout_sec ?? null,
        toolTimeoutSec: activeShegConfig.tool_timeout_sec ?? null,
      }));
      const packagePath = candidate ? path.join(candidate.root, 'package.json') : path.resolve('package.json');
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown };
      const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
      const codexConfig = path.join(codexHome, 'config.toml');
      return {
        adapter: 'sheg-codex-adapter',
        adapterVersion: typeof packageJson.version === 'string' ? packageJson.version : 'unknown',
        executable,
        codexVersion: version,
        codexConfigSha256: existsSync(codexConfig) ? sha256(readFileSync(codexConfig, 'utf8')) : null,
        customArgumentsSha256: sha256(stableJson(options.args ?? [])),
        shegMcpConfigSha256: configFingerprint,
        ...(candidate ? { shegMcpVersion: candidate.version, shegRecoveryHarnessSha256: sha256(readFileSync(candidate.harnessPath, 'utf8')), shegSourceSha256: candidate.sourceSha256 } : {}),
      };
      });
      preflightPromises.set(setupKey, preflightPromise);
    }
    return preflightPromise;
  };
  const execute: CampaignAdapter['execute'] = async (input): Promise<ExecutionResult> => {
      await preflight(input.workflowSetup);
      const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'sheg-codex-trial-'));
      const finalMessagePath = path.join(temporaryRoot, 'final-message.txt');
      const requested = input.requestedSettings;
      const args = input.resumeSessionId
        ? ['exec', 'resume', input.resumeSessionId, '--json', '--skip-git-repo-check', '-o', finalMessagePath]
        : ['exec', '--json', ...(input.persistent ? [] : ['--ephemeral']), '--skip-git-repo-check', '-C', input.cwd, '-o', finalMessagePath];
      const activeShegConfig = shegConfigFor(input.workflowSetup);
      const isolatedData = path.join(input.cwd, 'sheg-data');
      const env: Record<string, string> = { ...(activeShegConfig.transport?.env ?? {}), PLUGIN_DATA: isolatedData, SHEG_DATA_DIR: isolatedData };
      const toml = (item: unknown): string => {
        if (typeof item === 'string') return JSON.stringify(item);
        if (typeof item === 'boolean' || typeof item === 'number') return String(item);
        if (Array.isArray(item)) return `[${item.map(toml).join(',')}]`;
        if (item && typeof item === 'object') return `{${Object.entries(item).map(([key, entry]) => `${key}=${toml(entry)}`).join(',')}}`;
        throw new Error('Unsupported Sheg MCP configuration value.');
      };
      const mcpConfig: Record<string, unknown> = {
        enabled: activeShegConfig.enabled,
        command: activeShegConfig.transport!.command,
        args: activeShegConfig.transport!.args ?? [],
        cwd: activeShegConfig.transport!.cwd,
        env,
      };
      if (activeShegConfig.enabled_tools) mcpConfig.enabled_tools = activeShegConfig.enabled_tools;
      if (activeShegConfig.disabled_tools) mcpConfig.disabled_tools = activeShegConfig.disabled_tools;
      if (activeShegConfig.startup_timeout_sec) mcpConfig.startup_timeout_sec = activeShegConfig.startup_timeout_sec;
      if (activeShegConfig.tool_timeout_sec) mcpConfig.tool_timeout_sec = activeShegConfig.tool_timeout_sec;
      args.push('-c', `mcp_servers.sheg=${toml(mcpConfig)}`);
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
        const failStream = (stream: 'stdout' | 'stderr', error: Error) => {
          if (settled) return;
          child.kill();
          const detail = `Codex ${stream} stream error: ${error.message}`;
          const childStderr = Buffer.concat(stderr).toString('utf8');
          finish({ status: 'failed', exitCode: null, rawEvents: Buffer.concat(stdout).toString('utf8'), rawStderr: childStderr ? `${childStderr}\n${detail}` : detail });
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
        child.stdout.on('error', (error: Error) => failStream('stdout', error));
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
        child.stderr.on('error', (error: Error) => failStream('stderr', error));
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
    const workflowTurnEvents: string[] = [];
    const messages: string[] = [];
    const errors: string[] = [];
    let sessionId: string | null = null;
    let observedSettings: Record<string, unknown> = {};
    let exitCode: number | null = null;
    for (const [index, prompt] of prompts.entries()) {
      const result = await execute({ ...input, prompt, persistent: true, ...(sessionId ? { resumeSessionId: sessionId } : {}) });
      workflowTurnEvents.push(result.rawEvents);
      if (result.rawEvents) events.push(result.rawEvents);
      if (result.rawFinalMessage) messages.push(`## Turn ${index + 1}\n${result.rawFinalMessage}`);
      if (result.rawStderr) errors.push(result.rawStderr);
      sessionId = result.sessionId ?? sessionId;
      observedSettings = { ...observedSettings, ...result.observedSettings };
      exitCode = result.exitCode;
      if (result.status !== 'completed') return { ...result, rawEvents: events.join(''), rawFinalMessage: messages.join('\n\n'), rawStderr: errors.join('\n'), sessionId, observedSettings, workflowTurnEvents };
      if (index < prompts.length - 1 && !sessionId) return { status: 'failed', exitCode, rawEvents: events.join(''), rawFinalMessage: messages.join('\n\n'), rawStderr: `${errors.join('\n')}\nCodex did not expose a session ID; conversation cannot safely continue.`, sessionId: null, observedSettings, workflowTurnEvents };
    }
    return { status: 'completed', exitCode, rawEvents: events.join(''), rawFinalMessage: messages.join('\n\n'), rawStderr: errors.join('\n'), sessionId, observedSettings, workflowTurnEvents };
  };
  return { preflight, execute, executeWorkflow };
}
