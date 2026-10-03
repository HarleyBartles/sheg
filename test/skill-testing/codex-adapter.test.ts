import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import test from 'node:test';
import { createCodexAdapter } from '../../scripts/skill-testing/codex-adapter.js';

test('Codex workflow resumes the exact session and sends turns in order without --last or ephemeral mode', async () => {
  const invocations: string[][] = [];
  const prompts: string[] = [];
  const fakeSpawn = ((
    _file: string,
    args: readonly string[],
  ) => {
    invocations.push([...args]);
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdin = new EventEmitter();
    Object.assign(stdin, { end(prompt: string) { prompts.push(prompt); } });
    Object.assign(child, { stdout, stderr, stdin, kill() { return true; } });
    setImmediate(() => {
      const resume = args[1] === 'resume';
      const session = resume ? undefined : '11111111-1111-4111-8111-111111111111';
      const event = JSON.stringify(session ? { type: 'thread.started', thread_id: session } : { type: 'turn.completed' });
      stdout.emit('data', Buffer.from(`${event}\n`));
      const outputIndex = args.indexOf('-o');
      writeFileSync(args[outputIndex + 1]!, resume ? 'turn two done' : 'turn one done');
      child.emit('close', 0);
    });
    return child as unknown as ChildProcess;
  }) as unknown as typeof import('node:child_process').spawn;
  const adapter = createCodexAdapter({
    executable: 'codex-test', spawnProcess: fakeSpawn,
    shegMcpConfig: { enabled: true, transport: { type: 'stdio', command: 'node', args: ['sheg-mcp.js'], cwd: process.cwd(), env: { PLUGIN_DATA: 'default-data', PLUGIN_ROOT: 'plugin-root' } } },
  });
  const result = await adapter.executeWorkflow!({
    initialPrompt: 'first prompt', turns: ['second prompt', 'third prompt'], cwd: process.cwd(), timeoutMs: 5000,
    requestedSettings: { model: 'test-model', reasoning: 'medium' },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(prompts, ['first prompt', 'second prompt', 'third prompt']);
  assert.equal(invocations[0]![0], 'exec');
  assert.equal(invocations[1]![0], 'exec');
  assert.equal(invocations[1]![1], 'resume');
  assert.equal(invocations[1]![2], '11111111-1111-4111-8111-111111111111');
  assert.equal(invocations.some((args) => args.includes('--last') || args.includes('--ephemeral')), false);
  assert.ok(invocations.every((args) => args.some((arg) => arg.startsWith('mcp_servers.sheg={') && arg.includes('PLUGIN_DATA=') && arg.includes('SHEG_DATA_DIR='))));
  assert.equal(result.sessionId, '11111111-1111-4111-8111-111111111111');
  assert.match(result.rawFinalMessage, /Turn 3/);
  assert.equal(result.workflowTurnEvents?.length, 3);
  assert.match(result.workflowTurnEvents?.[0] ?? '', /thread.started/);
  assert.ok(result.workflowTurnEvents?.slice(1).every((events) => events.includes('turn.completed')));
});

test('Codex stdout pipe errors become retained attempt failures instead of unhandled process errors', async () => {
  const fakeSpawn = (() => {
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdin = new EventEmitter();
    Object.assign(stdin, { end() {} });
    Object.assign(child, { stdout, stderr, stdin, kill() { return true; } });
    setImmediate(() => stdout.emit('error', Object.assign(new Error('read ENOTCONN'), { code: 'ENOTCONN' })));
    return child as unknown as ChildProcess;
  }) as unknown as typeof import('node:child_process').spawn;
  const adapter = createCodexAdapter({
    executable: 'codex-test', spawnProcess: fakeSpawn,
    shegMcpConfig: { enabled: true, transport: { type: 'stdio', command: 'node', args: ['sheg-mcp.js'], cwd: process.cwd() } },
  });
  const result = await adapter.execute({ prompt: 'inspect', cwd: process.cwd(), timeoutMs: 5000, requestedSettings: {} });
  assert.equal(result.status, 'failed');
  assert.match(result.rawStderr, /stdout stream error.*ENOTCONN/i);
});
