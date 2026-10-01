import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { openRunStore } from '../src/infrastructure/run-store.js';

test('a copied plugin launches its shipped MCP without checkout or node_modules', async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'polling-plugin-copy-'));
  const cleanup: { closeTransport?: () => Promise<void> } = {};
  t.after(async () => {
    try {
      await cleanup.closeTransport?.();
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
  const plugin = path.join(sandbox, 'installed', 'sheg');
  await mkdir(path.dirname(plugin), { recursive: true });
  for (const item of ['plugin.json', 'mcp.json', 'dist']) await cp(path.resolve(item), path.join(plugin, item), { recursive: true });
  await cp(path.resolve('skills/stimulus-response-polling/SKILL.md'), path.join(plugin, 'skills/stimulus-response-polling/SKILL.md'), { recursive: true });
  await cp(path.resolve('skills/stimulus-response-polling/references'), path.join(plugin, 'skills/stimulus-response-polling/references'), { recursive: true });
  await cp(path.resolve('skills/stimulus-response-polling/assets'), path.join(plugin, 'skills/stimulus-response-polling/assets'), { recursive: true });
  await cp(path.resolve('skills/study-design'), path.join(plugin, 'skills/study-design'), { recursive: true });
  await assertSkillLinksResolve(path.join(plugin, 'skills/stimulus-response-polling'), plugin);
  await assertSkillLinksResolve(path.join(plugin, 'skills/study-design'), plugin);
  assert.equal(await exists(path.join(plugin, 'dist/data/respondent-archetypes/story-craft-and-culture.json')), true);
  for (const contract of ['inline-run-request.schema.json', 'respondent-archetype.schema.json', 'respondent-archetype-library.schema.json', 'respondent-profile.schema.json', 'respondent-cohort.schema.json', 'study-manifest.schema.json']) {
    assert.equal(await exists(path.join(plugin, 'skills/stimulus-response-polling/assets', contract)), true);
  }
  assert.equal(await exists(path.join(plugin, 'skills/stimulus-response-polling/assets/reader-archetype.schema.json')), false);
  assert.equal(await exists(path.join(plugin, 'skills/stimulus-response-polling/assets/reader-archetype-library.schema.json')), false);
  assert.equal(await exists(path.join(plugin, 'dist/skills/stimulus-response-polling/assets/respondent-archetypes')), false);
  assert.equal(await exists(path.join(plugin, 'node_modules')), false);
  const manifest = JSON.parse(await readFile(path.join(plugin, 'plugin.json'), 'utf8')) as { name: string };
  const mcp = JSON.parse(await readFile(path.join(plugin, 'mcp.json'), 'utf8')) as { mcpServers: Record<string, { type: string; command: string; args: string[]; cwd: string }> };
  assert.equal(manifest.name, 'sheg');
  assert.equal(mcp.mcpServers['sheg']?.type, 'stdio');
  assert.equal(mcp.mcpServers['sheg']?.args[0], '${PLUGIN_ROOT}/dist/mcp.js');
  assert.equal(mcp.mcpServers['sheg']?.cwd, '${PLUGIN_ROOT}');
  const inputs = path.join(sandbox, 'user-study');
  await mkdir(inputs);
  const env = { ...(process.env as Record<string, string>), SHEG_DATA_DIR: path.join(sandbox, 'data') };
  const client = new Client({ name: 'copied-plugin-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: 'node', args: [path.join(plugin, 'dist', 'mcp.js')], cwd: plugin, env });
  cleanup.closeTransport = async () => {
    try {
      await client.close();
    } finally {
      await transport.close();
    }
  };
  await client.connect(transport);
  const tokenizerPath = path.resolve('test/fixtures/laya-tokenizer.json');
  const result = await client.callTool({ name: 'run_inspect', arguments: { request: {
    kind: 'poll', respondents: [{ id: 'reader-a', intent: 'Understand', context: 'New reader', desired_outcome: 'Choose', engagement_cues: 'Examples', friction_cues: 'Hype' }],
    material: [{ id: 'opening', text: 'A short passage.' }], questions: [{ type: 'choice', id: 'interest', instructions: 'Would you continue?', options: { continue: 'Continue', leave: 'Leave' } }],
    maxCalls: 1, provider: { kind: 'laya', baseUrl: 'http://127.0.0.1:8000', checkpoint: 'unavailable-checkpoint', contextLimit: 4096, headLimit: 192, tokenizerJsonPath: tokenizerPath, tokenizerSha256: createHash('sha256').update(readFileSync(tokenizerPath)).digest('hex'), timeoutMs: 5000 },
  } } });
  assert.equal(result.isError ?? false, false);
  assert.equal((result.structuredContent as { valid?: boolean }).valid, true);
  assert.equal(await exists(path.resolve(plugin, 'skills/stimulus-response-polling/references/../../../dist/data/respondent-archetypes/story-craft-and-culture.json')), true);
});

test('a packaged run survives its requesting MCP and can be recalled from a new MCP connection', async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sheg-cross-mcp-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const dataRoot = path.join(sandbox, 'data');
  const plugin = path.join(sandbox, 'plugin');
  await mkdir(plugin, { recursive: true });
  await cp(path.resolve('dist'), path.join(plugin, 'dist'), { recursive: true });
  const tokenizerPath = path.resolve('test/fixtures/laya-tokenizer.json');
  const tokenizerSha256 = createHash('sha256').update(readFileSync(tokenizerPath)).digest('hex');
  let calls = 0;
  let releaseFirst: (() => void) | undefined;
  let requestArrived: (() => void) | undefined;
  const arrived = new Promise<void>((resolve) => { requestArrived = resolve; });
  const inference = createServer(async (request, response) => {
    calls += 1;
    await new Promise<void>((resolve) => { request.once('end', resolve); request.resume(); });
    requestArrived?.();
    if (calls === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      model: 'fixture-checkpoint',
      routing: { model: 'fixture-checkpoint' },
      usage: { input_tokens: 12, output_tokens: 3 },
      answers: { interest: { type: 'choice', choice: 'continue', probabilities: { continue: 0.9, leave: 0.1 } } },
    }));
  });
  await new Promise<void>((resolve, reject) => { inference.once('error', reject); inference.listen(0, '127.0.0.1', resolve); });
  t.after(async () => new Promise<void>((resolve) => inference.close(() => resolve())));
  const address = inference.address();
  assert.ok(address && typeof address === 'object');
  const request = {
    kind: 'poll',
    respondents: [{ id: 'reader-a', intent: 'Understand', context: 'New reader', desired_outcome: 'Choose', engagement_cues: 'Examples', friction_cues: 'Hype' }],
    material: [{ id: 'opening', text: 'A short passage.' }],
    questions: [{ type: 'choice', id: 'interest', instructions: 'Would you continue?', options: { continue: 'Continue', leave: 'Leave' } }],
    maxCalls: 1,
    provider: { kind: 'laya', baseUrl: `http://127.0.0.1:${address.port}`, checkpoint: 'fixture-checkpoint', contextLimit: 4096, headLimit: 512, tokenizerJsonPath: tokenizerPath, tokenizerSha256, timeoutMs: 10_000 },
  };
  const submissionId = randomUUID();
  const env = { ...(process.env as Record<string, string>), SHEG_DATA_DIR: dataRoot };
  const clientA = new Client({ name: 'package-a', version: '1.0.0' });
  const transportA = new StdioClientTransport({ command: process.execPath, args: [path.join(plugin, 'dist', 'mcp.js')], cwd: plugin, env });
  await clientA.connect(transportA);
  let workerPid: number | undefined;
  try {
    const started = await clientA.callTool({ name: 'run_start', arguments: { submissionId, request } });
    const runId = (started.structuredContent as { runId: string }).runId;
    await arrived;
    const db = new DatabaseSync(path.join(dataRoot, 'runs.sqlite'));
    try {
      const owner = db.prepare('SELECT owner_pid, owner_token FROM runs WHERE run_id = ?').get(runId) as { owner_pid?: number; owner_token?: string } | undefined;
      assert.ok(owner?.owner_token, 'The persisted run must have a fenced live worker owner.');
      workerPid = Number(owner.owner_pid);
      assert.ok(Number.isInteger(workerPid) && workerPid > 0 && isPidAlive(workerPid), 'The detached worker must remain alive when MCP A is closed.');
    } finally { db.close(); }
    await killMcpConnection(clientA, transportA);
    releaseFirst?.();
    await waitForCompleted(dataRoot, runId);

    const clientB = new Client({ name: 'package-b', version: '1.0.0' });
    const transportB = new StdioClientTransport({ command: process.execPath, args: [path.join(plugin, 'dist', 'mcp.js')], cwd: plugin, env });
    try {
      await clientB.connect(transportB);
      const recalled = await clientB.callTool({ name: 'run_get', arguments: { runId, view: 'answers' } });
      const items = (recalled.structuredContent as { items: Array<{ status: string; result?: { choice: string; provider: string } }> }).items;
      assert.equal(items[0]?.status, 'answered');
      assert.equal(items[0]?.result?.choice, 'continue');
      assert.equal(items[0]?.result?.provider, 'laya');
      const retry = await clientB.callTool({ name: 'run_start', arguments: { submissionId, request } });
      assert.equal((retry.structuredContent as { runId: string }).runId, runId);
      assert.equal(calls, 1);
    } finally { await killMcpConnection(clientB, transportB); }
  } catch (error) {
    releaseFirst?.();
    if (workerPid && Number.isInteger(workerPid)) killPid(workerPid);
    throw error;
  }
});

test('a dead packaged worker is discovered as interrupted and reads never relaunch it', async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sheg-worker-interruption-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const dataRoot = path.join(sandbox, 'data');
  const plugin = path.join(sandbox, 'plugin');
  await mkdir(plugin, { recursive: true });
  await cp(path.resolve('dist'), path.join(plugin, 'dist'), { recursive: true });
  const tokenizerPath = path.resolve('test/fixtures/laya-tokenizer.json');
  const tokenizerSha256 = createHash('sha256').update(readFileSync(tokenizerPath)).digest('hex');
  let calls = 0;
  let releaseResponse: (() => void) | undefined;
  let requestArrived: (() => void) | undefined;
  const arrived = new Promise<void>((resolve) => { requestArrived = resolve; });
  const inference = createServer(async (_request, response) => {
    calls += 1;
    if (calls === 1) {
      requestArrived?.();
      await new Promise<void>((resolve) => { releaseResponse = resolve; });
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      model: 'fixture-checkpoint', routing: { model: 'fixture-checkpoint' }, usage: {},
      answers: { interest: { type: 'choice', choice: 'continue', probabilities: { continue: 0.9, leave: 0.1 } } },
    }));
  });
  await new Promise<void>((resolve, reject) => { inference.once('error', reject); inference.listen(0, '127.0.0.1', resolve); });
  t.after(async () => new Promise<void>((resolve) => inference.close(() => resolve())));
  const address = inference.address();
  assert.ok(address && typeof address === 'object');
  const request = {
    kind: 'poll',
    respondents: [{ id: 'reader-a', intent: 'Understand', context: 'New reader', desired_outcome: 'Choose', engagement_cues: 'Examples', friction_cues: 'Hype' }],
    material: [{ id: 'opening', text: 'A short passage.' }],
    questions: [{ type: 'choice', id: 'interest', instructions: 'Would you continue?', options: { continue: 'Continue', leave: 'Leave' } }],
    maxCalls: 2,
    provider: { kind: 'laya', baseUrl: `http://127.0.0.1:${address.port}`, checkpoint: 'fixture-checkpoint', contextLimit: 4096, headLimit: 512, tokenizerJsonPath: tokenizerPath, tokenizerSha256, timeoutMs: 10_000 },
  };
  const env = { ...(process.env as Record<string, string>), SHEG_DATA_DIR: dataRoot };
  const clientA = new Client({ name: 'interruption-a', version: '1.0.0' });
  const transportA = new StdioClientTransport({ command: process.execPath, args: [path.join(plugin, 'dist', 'mcp.js')], cwd: plugin, env });
  await clientA.connect(transportA);
  let workerPid = 0;
  try {
    const started = await clientA.callTool({ name: 'run_start', arguments: { submissionId: randomUUID(), request } });
    const runId = (started.structuredContent as { runId: string }).runId;
    await arrived;
    const db = new DatabaseSync(path.join(dataRoot, 'runs.sqlite'));
    try {
      const owner = db.prepare('SELECT owner_pid, owner_token, reserved_calls FROM runs WHERE run_id = ?').get(runId) as { owner_pid?: number; owner_token?: string; reserved_calls?: number } | undefined;
      assert.ok(owner?.owner_token, 'The run must have a live fenced worker owner.');
      assert.equal(owner.reserved_calls, 1);
      workerPid = Number(owner.owner_pid);
      assert.ok(Number.isInteger(workerPid) && workerPid > 0 && isPidAlive(workerPid));
    } finally { db.close(); }
    killPid(workerPid);
    await waitForPidExit(workerPid);
    const expire = new DatabaseSync(path.join(dataRoot, 'runs.sqlite'));
    try { expire.prepare('UPDATE runs SET lease_expires_ms = 0 WHERE run_id = ?').run(runId); }
    finally { expire.close(); }
    releaseResponse?.();
    await killMcpConnection(clientA, transportA);

    const clientB = new Client({ name: 'interruption-b', version: '1.0.0' });
    const transportB = new StdioClientTransport({ command: process.execPath, args: [path.join(plugin, 'dist', 'mcp.js')], cwd: plugin, env });
    try {
      await clientB.connect(transportB);
      const status = await clientB.callTool({ name: 'run_get', arguments: { runId, view: 'status' } });
      const view = status.structuredContent as { status: string; usedCalls: number; reservedCalls: number };
      assert.equal(view.status, 'interrupted');
      assert.equal(view.usedCalls, 1);
      assert.equal(view.reservedCalls, 0);
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(calls, 1, 'A status read must not launch a replacement worker.');
      const resumed = await clientB.callTool({ name: 'run_resume', arguments: { runId } });
      assert.equal(resumed.isError ?? false, false);
      assert.equal((resumed.structuredContent as { runId: string }).runId, runId);
      await waitForCompleted(dataRoot, runId);
      assert.equal(calls, 2, 'Resume may spend only the one call left in the original ceiling.');
      const answers = await clientB.callTool({ name: 'run_get', arguments: { runId, view: 'answers' } });
      const answerItems = (answers.structuredContent as { items: Array<{ status: string; result?: { choice?: string } }> }).items;
      assert.equal(answerItems.length, 1);
      assert.equal(answerItems[0]?.status, 'answered');
      assert.equal(answerItems[0]?.result?.choice, 'continue');
    } finally { await killMcpConnection(clientB, transportB); }
  } finally {
    releaseResponse?.();
    if (workerPid) killPid(workerPid);
  }
});

async function killMcpConnection(client: Client, transport: StdioClientTransport): Promise<void> {
  const pid = transport.pid;
  if (pid && isPidAlive(pid)) killPid(pid);
  try { await client.close(); } catch { /* A deliberately terminated process closes its transport with an error. */ }
  try { await transport.close(); } catch { /* Process is already gone. */ }
}

function killPid(pid: number): void { try { process.kill(pid, 'SIGTERM'); } catch { /* Test cleanup tolerates an already exited owned child. */ } }
function isPidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

async function waitForPidExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Owned worker ${pid} did not exit after termination.`);
}

async function waitForCompleted(dataRoot: string, runId: string): Promise<void> {
  const store = openRunStore(dataRoot);
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (store.getStatus(runId).status === 'completed') return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(`Run ${runId} did not complete after its requesting MCP exited.`);
  } finally { store.close(); }
}

async function exists(filePath: string): Promise<boolean> {
  try { await readFile(filePath); return true; } catch { return false; }
}

async function assertSkillLinksResolve(skillDirectory: string, pluginDirectory: string): Promise<void> {
  for (const relativePath of await readdir(skillDirectory, { recursive: true })) {
    if (!relativePath.endsWith('.md')) continue;
    const markdownPath = path.join(skillDirectory, relativePath);
    const markdown = await readFile(markdownPath, 'utf8');
    for (const [, target] of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (!target || /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('#')) continue;
      const localPath = target.split('#', 1)[0]?.split('?', 1)[0];
      if (!localPath) continue;
      const resolvedPath = path.resolve(path.dirname(markdownPath), localPath);
      const pluginRelativePath = path.relative(pluginDirectory, resolvedPath);
      assert.ok(
        !path.isAbsolute(pluginRelativePath) && pluginRelativePath !== '..' && !pluginRelativePath.startsWith(`..${path.sep}`),
        `Skill link escapes plugin: ${target}`,
      );
      assert.equal(await exists(resolvedPath), true, `Broken packaged skill link in ${relativePath}: ${target}`);
    }
  }
}
