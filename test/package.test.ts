import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

function closeTestServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

type JourneyDetailTestShape = { evaluations: Array<{ questionId: string; status: string; turnId: string; contextId: string; packet: { state: { trajectory: { responses: Array<{ taskId: string }> } } } }> };
type FollowOnRequestTestShape = {
  evaluations: Array<{ questionId: string; contextId: string; packet: { state: { encounteredItems: Array<{ id: string; text: string }>; trajectory: { responses: unknown[] } } } }>;
  lineage: { sourceAvailable: boolean; selections: Array<{ sourceContextId: string; selectedMaterial?: { materialId: string } }>; materialSnapshots: Array<{ materials: Array<{ id: string; text: string; sourceId?: string; sourceSha256?: string }> }> };
};

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
  await cp(path.resolve('plugins/sheg'), plugin, { recursive: true });
  await assertSkillLinksResolve(path.join(plugin, 'skills/stimulus-response-polling'), plugin);
  await assertSkillLinksResolve(path.join(plugin, 'skills/study-design'), plugin);
  assert.equal(await exists(path.join(plugin, 'dist/data/respondent-archetypes/story-craft-and-culture.json')), true);
  assert.equal(await exists(path.join(plugin, 'dist/migrations/0000_baseline_v9/migration.sql')), true);
  assert.equal(await exists(path.join(plugin, 'dist/licenses/drizzle-orm-Apache-2.0.txt')), true);
  assert.equal(await exists(path.join(plugin, 'dist/licenses/THIRD-PARTY-NOTICES.md')), true);
  const credentialHelper = path.join(plugin, 'dist/credentials/windows-credential.ps1');
  assert.equal(await exists(credentialHelper), true);
  if (process.platform === 'win32') {
    const status = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', credentialHelper,
      '-Operation', 'Status', '-TargetName', 'Sheg/Jev/TypeSafe',
    ], { encoding: 'utf8', windowsHide: true, shell: false });
    assert.equal(status.error, undefined);
    assert.ok(status.status === 0 || status.status === 3);
    assert.match(status.stdout.trim(), /^(AVAILABLE|MISSING)$/);
    assert.equal(status.stderr, '');
  }
  for (const contract of ['run-request.schema.json', 'respondent-archetype.schema.json', 'respondent-archetype-library.schema.json', 'respondent-profile.schema.json', 'respondent-cohort.schema.json', 'study-manifest.schema.json']) {
    assert.equal(await exists(path.join(plugin, 'skills/stimulus-response-polling/assets', contract)), true);
  }
  assert.equal(await exists(path.join(plugin, 'skills/stimulus-response-polling/assets/reader-archetype.schema.json')), false);
  assert.equal(await exists(path.join(plugin, 'skills/stimulus-response-polling/assets/reader-archetype-library.schema.json')), false);
  assert.equal(await exists(path.join(plugin, 'dist/skills/stimulus-response-polling/assets/respondent-archetypes')), false);
  assert.equal(await exists(path.join(plugin, 'node_modules')), false);
  assert.equal(await exists(path.join(plugin, 'src')), false);
  assert.equal(await exists(path.join(plugin, 'test')), false);
  assert.equal(await exists(path.join(plugin, 'plans')), false);
  assert.equal(await exists(path.join(plugin, 'LICENSE')), true);
  const manifest = JSON.parse(await readFile(path.join(plugin, 'plugin.json'), 'utf8')) as { name: string; version: string };
  const packageManifest = JSON.parse(await readFile(path.join(plugin, 'package.json'), 'utf8')) as { version: string };
  const mcp = JSON.parse(await readFile(path.join(plugin, 'mcp.json'), 'utf8')) as { mcpServers: Record<string, { type: string; command: string; args: string[]; cwd: string }> };
  assert.equal(manifest.name, 'sheg');
  assert.equal(manifest.version, packageManifest.version);
  assert.equal(mcp.mcpServers['sheg']?.type, 'stdio');
  assert.equal(mcp.mcpServers['sheg']?.args[0], '${PLUGIN_ROOT}/dist/mcp.js');
  assert.equal(mcp.mcpServers['sheg']?.cwd, '${PLUGIN_ROOT}');
  const tokenizerPath = path.join(sandbox, 'laya-tokenizer.json');
  await cp(path.resolve('test/fixtures/laya-tokenizer.json'), tokenizerPath);
  const pluginData = path.join(sandbox, 'plugin-data');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'SHEG_DATA_DIR')) as Record<string, string>;
  env.PLUGIN_DATA = pluginData;
  env.PLUGIN_ROOT = plugin;
  const client = new Client({ name: 'copied-plugin-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: 'node', args: [path.join(plugin, 'dist', 'mcp.js')], cwd: sandbox, env });
  cleanup.closeTransport = async () => {
    try {
      await client.close();
    } finally {
      await transport.close();
    }
  };
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.version, packageManifest.version);
  const result = await client.callTool({ name: 'run_inspect', arguments: { request: {
    kind: 'poll', respondents: [{ id: 'reader-a', intent: 'Understand', context: 'New reader', desired_outcome: 'Choose', engagement_cues: 'Examples', friction_cues: 'Hype' }],
    material: [{ id: 'opening', text: 'A short passage.' }], questions: [{ type: 'choice', id: 'interest', instructions: 'Would you continue?', options: { continue: 'Continue', leave: 'Leave' } }],
    maxCalls: 1, provider: { kind: 'laya', baseUrl: 'http://127.0.0.1:8000', checkpoint: 'unavailable-checkpoint', contextLimit: 4096, headLimit: 192, tokenizerJsonPath: tokenizerPath, tokenizerSha256: createHash('sha256').update(readFileSync(tokenizerPath)).digest('hex'), timeoutMs: 5000 },
  } } });
  assert.equal(result.isError ?? false, false);
  assert.equal((result.structuredContent as { valid?: boolean }).valid, true);
  assert.equal(await exists(path.join(pluginData, 'runs.sqlite')), true);
  assert.equal(await exists(path.join(plugin, 'runs.sqlite')), false);
  const initialized = new DatabaseSync(path.join(pluginData, 'runs.sqlite'), { readOnly: true });
  try { assert.equal((initialized.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 9); }
  finally { initialized.close(); }
  assert.equal(await exists(path.resolve(plugin, 'skills/stimulus-response-polling/references/../../../dist/data/respondent-archetypes/story-craft-and-culture.json')), true);
});

test('a packaged run survives its requesting MCP and can be recalled from a new MCP connection', async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sheg-cross-mcp-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const dataRoot = path.join(sandbox, 'data');
  const pluginBeforeUpdate = path.join(sandbox, 'plugin-before-update');
  const pluginAfterUpdate = path.join(sandbox, 'plugin-after-update');
  await cp(path.resolve('plugins/sheg'), pluginBeforeUpdate, { recursive: true });
  await cp(path.resolve('plugins/sheg'), pluginAfterUpdate, { recursive: true });
  const tokenizerPath = path.join(sandbox, 'laya-tokenizer.json');
  await cp(path.resolve('test/fixtures/laya-tokenizer.json'), tokenizerPath);
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
  t.after(() => closeTestServer(inference));
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
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'SHEG_DATA_DIR')) as Record<string, string>;
  env.PLUGIN_DATA = dataRoot;
  const clientA = new Client({ name: 'package-a', version: '1.0.0' });
  const transportA = new StdioClientTransport({ command: process.execPath, args: [path.join(pluginBeforeUpdate, 'dist', 'mcp.js')], cwd: pluginBeforeUpdate, env });
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
    const transportB = new StdioClientTransport({ command: process.execPath, args: [path.join(pluginAfterUpdate, 'dist', 'mcp.js')], cwd: pluginAfterUpdate, env });
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
  t.after(() => closeTestServer(inference));
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
      assert.equal(resumed.isError ?? false, false, JSON.stringify(resumed.structuredContent));
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

test('a copied MCP runs a journey across connections and resumes its saved turn without replay', async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sheg-journey-cross-mcp-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const dataRoot = path.join(sandbox, 'data');
  const plugin = path.join(sandbox, 'plugin');
  await mkdir(plugin, { recursive: true });
  await cp(path.resolve('dist'), path.join(plugin, 'dist'), { recursive: true });
  const tokenizerPath = path.resolve('test/fixtures/laya-tokenizer.json');
  const tokenizerSha256 = createHash('sha256').update(readFileSync(tokenizerPath)).digest('hex');
  const questions: string[] = [];
  let releaseFirst: (() => void) | undefined;
  let releaseSecond: (() => void) | undefined;
  let firstArrived: (() => void) | undefined;
  let secondArrived: (() => void) | undefined;
  const firstCall = new Promise<void>((resolve) => { firstArrived = resolve; });
  const secondCall = new Promise<void>((resolve) => { secondArrived = resolve; });
  const inference = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { questions: Record<string, unknown> };
    const questionId = Object.keys(body.questions)[0] ?? '';
    questions.push(questionId);
    if (questions.length === 1) {
      firstArrived?.();
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    }
    if (questions.length === 2) {
      secondArrived?.();
      await new Promise<void>((resolve) => { releaseSecond = resolve; });
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      model: 'fixture-checkpoint', routing: { model: 'fixture-checkpoint' }, usage: {},
      answers: { [questionId]: { type: 'choice', choice: 'continue', probabilities: { continue: 0.9, leave: 0.1 } } },
    }));
  });
  await new Promise<void>((resolve, reject) => { inference.once('error', reject); inference.listen(0, '127.0.0.1', resolve); });
  t.after(() => closeTestServer(inference));
  const address = inference.address();
  assert.ok(address && typeof address === 'object');
  const runRequest = {
    kind: 'journey',
    respondents: [{ id: 'reader-a', intent: 'Understand', context: 'New reader', desired_outcome: 'Choose', engagement_cues: 'Examples', friction_cues: 'Hype' }],
    journey: {
      id: 'article', label: 'Two section journey', items: [{ id: 'opening', text: 'The opening section.' }],
      tasks: [
        { id: 'first', type: 'choice', instructions: 'Would you continue?', options: { continue: 'Continue', leave: 'Leave' } },
        { id: 'second', type: 'choice', instructions: 'Did section two hold your interest?', options: { continue: 'Yes', leave: 'No' } },
      ],
      presentation: { kind: 'sequence' },
    },
    maxCalls: 3,
    provider: { kind: 'laya', baseUrl: `http://127.0.0.1:${address.port}`, checkpoint: 'fixture-checkpoint', contextLimit: 4096, headLimit: 512, tokenizerJsonPath: tokenizerPath, tokenizerSha256, timeoutMs: 10_000 },
  };
  const env = { ...(process.env as Record<string, string>), SHEG_DATA_DIR: dataRoot };
  const clientA = new Client({ name: 'journey-package-a', version: '1.0.0' });
  const transportA = new StdioClientTransport({ command: process.execPath, args: [path.join(plugin, 'dist', 'mcp.js')], cwd: plugin, env });
  await clientA.connect(transportA);
  let workerPid = 0;
  try {
    const inspected = await clientA.callTool({ name: 'run_inspect', arguments: { request: runRequest } });
    assert.equal((inspected.structuredContent as { valid: boolean }).valid, true);
    const started = await clientA.callTool({ name: 'run_start', arguments: { submissionId: randomUUID(), request: runRequest } });
    const runId = (started.structuredContent as { runId: string }).runId;
    await firstCall;
    await killMcpConnection(clientA, transportA);
    releaseFirst?.();
    await secondCall;

    const db = new DatabaseSync(path.join(dataRoot, 'runs.sqlite'));
    try {
      const owner = db.prepare('SELECT owner_pid, owner_token FROM runs WHERE run_id = ?').get(runId) as { owner_pid?: number; owner_token?: string } | undefined;
      assert.ok(owner?.owner_token, 'Journey must have a fenced worker while its second turn is in flight.');
      workerPid = Number(owner.owner_pid);
      assert.ok(Number.isInteger(workerPid) && workerPid > 0 && isPidAlive(workerPid));
    } finally { db.close(); }
    killPid(workerPid);
    await waitForPidExit(workerPid);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const expire = new DatabaseSync(path.join(dataRoot, 'runs.sqlite'));
    try { expire.prepare('UPDATE runs SET lease_expires_ms = 0 WHERE run_id = ?').run(runId); }
    finally { expire.close(); }
    releaseSecond?.();

    const clientB = new Client({ name: 'journey-package-b', version: '1.0.0' });
    const transportB = new StdioClientTransport({ command: process.execPath, args: [path.join(plugin, 'dist', 'mcp.js')], cwd: plugin, env });
    try {
      await clientB.connect(transportB);
      const status = await clientB.callTool({ name: 'run_get', arguments: { runId, view: 'status' } });
      assert.equal((status.structuredContent as { status: string }).status, 'interrupted');
      const beforeResume = await clientB.callTool({ name: 'run_get', arguments: { runId, view: 'journey' } });
      const saved = beforeResume.structuredContent as JourneyDetailTestShape;
      assert.equal(saved.evaluations.length, 2);
      assert.equal(saved.evaluations[0]?.status, 'answered');
      assert.equal(saved.evaluations[1]?.status, 'pending');
      assert.equal(saved.evaluations[1]?.questionId, 'second');
      assert.deepEqual(saved.evaluations[1]?.packet.state.trajectory.responses.map(({ taskId }) => taskId), ['first']);
      const savedSecondTurn = saved.evaluations[1]?.turnId;
      const savedSecondContext = saved.evaluations[1]?.contextId;
      const resumed = await clientB.callTool({ name: 'run_resume', arguments: { runId } });
      assert.equal(resumed.isError ?? false, false, JSON.stringify(resumed.structuredContent));
      await waitForCompleted(dataRoot, runId);
      assert.deepEqual(questions, ['first', 'second', 'second']);

      const afterResume = await clientB.callTool({ name: 'run_get', arguments: { runId, view: 'journey' } });
      const completed = afterResume.structuredContent as { evaluations: Array<{ questionId: string; status: string; turnId: string; contextId: string }>; respondents: Array<{ status: string; outcome?: string; route: Array<{ nodeId: string }> }> };
      assert.equal(completed.evaluations.length, 2);
      assert.deepEqual(completed.evaluations.map(({ status }) => status), ['answered', 'answered']);
      assert.equal(completed.evaluations[1]?.turnId, savedSecondTurn);
      assert.equal(completed.evaluations[1]?.contextId, savedSecondContext);
      assert.equal(completed.respondents[0]?.status, 'completed');
      assert.equal(completed.respondents[0]?.outcome, 'complete');
      assert.equal(completed.respondents[0]?.route.length, 2);
    } finally { await killMcpConnection(clientB, transportB); }
  } catch (error) {
    releaseFirst?.();
    releaseSecond?.();
    if (workerPid) killPid(workerPid);
    throw error;
  }
});

test('a copied MCP queries a typed departure reason, reuses its context, and retains follow-on evidence after source deletion', async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sheg-follow-on-package-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const dataRoot = path.join(sandbox, 'data');
  const plugin = path.join(sandbox, 'plugin');
  await mkdir(plugin, { recursive: true });
  await cp(path.resolve('dist'), path.join(plugin, 'dist'), { recursive: true });
  const tokenizerPath = path.resolve('test/fixtures/laya-tokenizer.json');
  const tokenizerSha256 = createHash('sha256').update(readFileSync(tokenizerPath)).digest('hex');
  const providerPayloads: string[] = [];
  const inference = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = Buffer.concat(chunks).toString('utf8');
    providerPayloads.push(payload);
    const body = JSON.parse(payload) as { questions: Record<string, unknown> };
    const questionId = Object.keys(body.questions)[0] ?? '';
    const answer = questionId === 'interest'
      ? { type: 'choice', choice: 'candidate-three', probabilities: { 'candidate-one': 0.05, 'candidate-two': 0.05, 'candidate-three': 0.85, 'no-fit': 0.05 } }
      : questionId === 'which-detail'
        ? { type: 'choice', choice: 'example', probabilities: { example: 0.7, style: 0.2, 'no-fit': 0.1 } }
        : questionId === 'strength'
          ? { type: 'score', score: 2, legend: { '0': 'Not at all', '1': 'A little', '2': 'A lot' }, probabilities: { '0': 0.05, '1': 0.15, '2': 0.8 } }
          : { type: 'noul', noul: questionId === 'why-interest' ? 0.82 : questionId === 'change' ? 0.65 : 0.4 };
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      model: 'fixture-checkpoint', routing: { model: 'fixture-checkpoint' }, usage: {}, answers: { [questionId]: answer },
    }));
  });
  await new Promise<void>((resolve, reject) => { inference.once('error', reject); inference.listen(0, '127.0.0.1', resolve); });
  t.after(() => closeTestServer(inference));
  const address = inference.address();
  assert.ok(address && typeof address === 'object');
  const env = { ...(process.env as Record<string, string>), SHEG_DATA_DIR: dataRoot };
  const localProvider = { kind: 'laya', baseUrl: `http://127.0.0.1:${address.port}`, checkpoint: 'fixture-checkpoint', contextLimit: 4096,
    headLimit: 512, tokenizerJsonPath: tokenizerPath, tokenizerSha256, timeoutMs: 10_000 };
  const journey = {
    kind: 'journey', respondents: [{ id: 'reader-a', intent: 'Understand the article', context: 'New reader', desired_outcome: 'Decide whether to continue', engagement_cues: 'Specific examples', friction_cues: 'Repetition' }],
    journey: { id: 'article', label: 'Section three interest', items: [
      { id: 'section-one', text: 'First section.', sourceId: 'article-section-1', sourceSha256: '1'.repeat(64) },
      { id: 'section-two', text: 'Second section.', sourceId: 'article-section-2', sourceSha256: '2'.repeat(64) },
      { id: 'section-three', text: 'Third section.', sourceId: 'article-section-3', sourceSha256: '3'.repeat(64) },
    ], tasks: [{ id: 'interest', type: 'choice', instructions: 'Which section lost your interest?', options: {
      'candidate-one': 'First section.', 'candidate-two': 'Second section.', 'candidate-three': 'Third section.', 'no-fit': 'No section lost my interest.',
    }, materialOptions: { 'candidate-one': 'section-one', 'candidate-two': 'section-two', 'candidate-three': 'section-three' } }],
    presentation: { kind: 'graph', entryNodeId: 'expose-one', maxDecisions: 1, nodes: [
      { id: 'expose-one', kind: 'expose', itemId: 'section-one' }, { id: 'expose-two', kind: 'expose', itemId: 'section-two' },
      { id: 'expose-three', kind: 'expose', itemId: 'section-three' }, { id: 'ask-interest', kind: 'ask', taskId: 'interest' },
      { id: 'left-lost-interest', kind: 'terminal', outcome: 'left-lost-interest' }, { id: 'continued', kind: 'terminal', outcome: 'continued' },
    ], transitions: [
      { fromNodeId: 'expose-one', toNodeId: 'expose-two' }, { fromNodeId: 'expose-two', toNodeId: 'expose-three' },
      { fromNodeId: 'expose-three', toNodeId: 'ask-interest' }, { fromNodeId: 'ask-interest', optionId: 'candidate-three', toNodeId: 'left-lost-interest' },
      { fromNodeId: 'ask-interest', optionId: 'candidate-one', toNodeId: 'continued' },
      { fromNodeId: 'ask-interest', optionId: 'candidate-two', toNodeId: 'continued' },
      { fromNodeId: 'ask-interest', optionId: 'no-fit', toNodeId: 'continued' },
    ] },
    }, maxCalls: 1, provider: localProvider,
  };
  const client = new Client({ name: 'follow-on-package', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(plugin, 'dist', 'mcp.js')], cwd: plugin, env });
  await client.connect(transport);
  try {
    const started = await client.callTool({ name: 'run_start', arguments: { submissionId: randomUUID(), request: journey } });
    assert.equal(started.isError ?? false, false, JSON.stringify(started.structuredContent));
    const sourceRunId = (started.structuredContent as { runId: string }).runId;
    await waitForCompleted(dataRoot, sourceRunId);
    const queried = await client.callTool({ name: 'run_query', arguments: { sourceRunId, criteria: {
      materialId: 'section-three', answer: { type: 'choice', choiceId: 'candidate-three' }, outcome: 'left-lost-interest',
    } } });
    assert.equal(queried.isError ?? false, false, JSON.stringify(queried.structuredContent));
    const evidence = queried.structuredContent as { items: Array<{ evaluationId: string; contextId: string; selectedMaterial?: { materialId: string; text: string; sourceId: string; sourceSha256: string; textSha256: string } }>; sourceComplete: boolean };
    assert.equal(evidence.sourceComplete, true);
    assert.equal(evidence.items.length, 1);
    assert.deepEqual(evidence.items[0]?.selectedMaterial, { materialId: 'section-three', text: 'Third section.', sourceId: 'article-section-3', sourceSha256: '3'.repeat(64), textSha256: createHash('sha256').update('Third section.', 'utf8').digest('hex') });
    const followOn = {
      kind: 'follow-on', sourceRunId, selection: { references: [{ evaluationId: evidence.items[0]!.evaluationId, contextId: evidence.items[0]!.contextId }] },
      context: { mode: 'omit-history', includeSelectedMaterial: true },
      questions: [
        { type: 'noul', id: 'why-interest', instructions: 'Did the examples in section three reduce your interest?' },
        { type: 'choice', id: 'which-detail', instructions: 'Which aspect mattered most?', options: { example: 'The specific example', style: 'The writing style', 'no-fit': 'Neither' } },
        { type: 'score', id: 'strength', instructions: 'How strongly did this affect your interest?', rubric: ['Not at all', 'A little', 'A lot'] },
        { type: 'noul', id: 'change', instructions: 'Would adding a concrete example have kept your interest?' },
        { type: 'noul', id: 'continue', instructions: 'Would a concrete example help?', criteria: { true: 'Yes', false: 'No' } },
      ],
      provider: localProvider, maxCalls: 5,
    };
    const inspected = await client.callTool({ name: 'run_inspect', arguments: { request: followOn } });
    assert.equal((inspected.structuredContent as { valid: boolean }).valid, true, JSON.stringify(inspected.structuredContent));
    assert.deepEqual((inspected.structuredContent as { selectionCoverage: unknown }).selectionCoverage, {
      matched: 1, eligible: 1, excluded: { pending: 0, failed: 0, unreached: 0, nonChoice: 0, unmappedChoice: 0 },
    });
    const accepted = await client.callTool({ name: 'run_start', arguments: { submissionId: randomUUID(), request: followOn } });
    assert.equal(accepted.isError ?? false, false, JSON.stringify(accepted.structuredContent));
    const followOnRunId = (accepted.structuredContent as { runId: string }).runId;
    await waitForCompleted(dataRoot, followOnRunId);
    const beforeDelete = await client.callTool({ name: 'run_get', arguments: { runId: followOnRunId, view: 'request' } });
    const savedBeforeDelete = beforeDelete.structuredContent as FollowOnRequestTestShape;
    assert.equal(savedBeforeDelete.evaluations.length, 5);
    assert.deepEqual(savedBeforeDelete.evaluations.map(({ questionId }) => questionId), ['why-interest', 'which-detail', 'strength', 'change', 'continue']);
    assert.equal(new Set(savedBeforeDelete.evaluations.map(({ contextId }) => contextId)).size, 1);
    assert.ok(savedBeforeDelete.evaluations.every(({ packet }) => JSON.stringify(packet.state.encounteredItems) === JSON.stringify([{ id: 'section-three', text: 'Third section.' }])));
    assert.ok(savedBeforeDelete.evaluations.every(({ packet }) => packet.state.trajectory.responses.length === 0));
    assert.equal(savedBeforeDelete.lineage.sourceAvailable, true);
    assert.deepEqual(savedBeforeDelete.lineage.selections[0]?.sourceContextId, evidence.items[0]?.contextId);
    assert.equal(savedBeforeDelete.lineage.selections[0]?.selectedMaterial?.materialId, 'section-three');
    assert.deepEqual(savedBeforeDelete.lineage.materialSnapshots[0]?.materials, [
      { id: 'section-three', text: 'Third section.', sourceId: 'article-section-3', sourceSha256: '3'.repeat(64) },
    ]);
    assert.equal(providerPayloads.length, 6);
    assert.ok(providerPayloads.every((payload) => !/materialOptions|article-section-[123]|sourceSha256|[123]{64}/.test(payload)));
    const deleted = await client.callTool({ name: 'run_delete', arguments: { runIds: [sourceRunId] } });
    assert.equal(deleted.isError ?? false, false);
    const afterDelete = await client.callTool({ name: 'run_get', arguments: { runId: followOnRunId, view: 'request' } });
    const savedAfterDelete = afterDelete.structuredContent as { lineage: { sourceAvailable: boolean; sourceRecordState: string } };
    assert.equal(savedAfterDelete.lineage.sourceAvailable, false);
    assert.equal(savedAfterDelete.lineage.sourceRecordState, 'historical');
    const answer = await client.callTool({ name: 'run_get', arguments: { runId: followOnRunId, view: 'answers' } });
    const answerItems = (answer.structuredContent as { items: Array<{ questionId: string; status: string; result?: { type: string; noul?: number; choice?: string; score?: number } }> }).items;
    assert.equal(answerItems.length, 5);
    assert.ok(answerItems.every(({ status }) => status === 'answered'));
    assert.deepEqual(answerItems.map(({ questionId, result }) => [questionId, result?.type]), [
      ['why-interest', 'noul'], ['which-detail', 'choice'], ['strength', 'score'], ['change', 'noul'], ['continue', 'noul'],
    ]);
    assert.deepEqual(answerItems.map(({ result }) => result?.type === 'noul' ? result.noul : result?.type === 'choice' ? result.choice : result?.score), [0.82, 'example', 2, 0.65, 0.4]);
    const followOnPayloads = providerPayloads.slice(1).map((payload) => JSON.parse(payload) as { state: { encounteredItems: Array<{ id: string; text: string }>; trajectory: { responses: unknown[] } }; questions: Record<string, unknown> });
    assert.deepEqual(followOnPayloads.map(({ questions }) => Object.keys(questions)), [['why-interest'], ['which-detail'], ['strength'], ['change'], ['continue']]);
    assert.ok(followOnPayloads.every(({ state }) => JSON.stringify(state.encounteredItems) === JSON.stringify([{ id: 'section-three', text: 'Third section.' }]) && state.trajectory.responses.length === 0));
  } finally { await killMcpConnection(client, transport); }
});

test('a copied MCP splits local independent questions and resumes without replaying a saved sibling', async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sheg-question-group-package-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const dataRoot = path.join(sandbox, 'data');
  const plugin = path.join(sandbox, 'plugin');
  await mkdir(plugin, { recursive: true });
  await cp(path.resolve('dist'), path.join(plugin, 'dist'), { recursive: true });
  const tokenizerPath = path.resolve('test/fixtures/laya-tokenizer.json');
  const tokenizerSha256 = createHash('sha256').update(readFileSync(tokenizerPath)).digest('hex');
  const calls: string[] = [];
  let secondArrived: (() => void) | undefined;
  let releaseSecond: (() => void) | undefined;
  let finalArrived: (() => void) | undefined;
  let releaseFinal: (() => void) | undefined;
  const arrived = new Promise<void>((resolve) => { secondArrived = resolve; });
  const finalRequestArrived = new Promise<void>((resolve) => { finalArrived = resolve; });
  const inference = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { questions: Record<string, unknown> };
    const questionId = Object.keys(body.questions)[0] ?? '';
    calls.push(questionId);
    if (calls.length === 2) {
      secondArrived?.();
      await new Promise<void>((resolve) => { releaseSecond = resolve; });
    }
    if (questionId === 'why-interest') {
      finalArrived?.();
      await new Promise<void>((resolve) => { releaseFinal = resolve; });
    }
    const answer = questionId === 'interest'
      ? { type: 'choice', choice: 'leave', probabilities: { continue: 0.1, leave: 0.9 } }
      : questionId === 'severity'
        ? { type: 'score', score: 1, legend: { '0': 'Not at all', '1': 'A lot' }, probabilities: { '0': 0.2, '1': 0.8 } }
        : { type: 'noul', noul: 0.82 };
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      model: 'fixture-checkpoint', routing: { model: 'fixture-checkpoint' }, usage: {}, answers: { [questionId]: answer },
    }));
  });
  await new Promise<void>((resolve, reject) => { inference.once('error', reject); inference.listen(0, '127.0.0.1', resolve); });
  t.after(() => closeTestServer(inference));
  const address = inference.address();
  assert.ok(address && typeof address === 'object');
  const runRequest = {
    kind: 'poll',
    respondents: [{ id: 'reader-a', intent: 'Understand', context: 'New reader', desired_outcome: 'Decide', engagement_cues: 'Examples', friction_cues: 'Hype' }],
    material: [{ id: 'section-three', text: 'The third section.' }],
    questions: [
      { type: 'choice', id: 'interest', instructions: 'Would you continue?', options: { continue: 'Continue', leave: 'Leave' } },
      { type: 'score', id: 'severity', instructions: 'How strongly did interest change?', rubric: ['Not at all', 'A lot'] },
      { type: 'noul', id: 'why-interest', instructions: 'Did anything reduce your interest?' },
    ],
    maxCalls: 5,
    provider: { kind: 'laya', baseUrl: `http://127.0.0.1:${address.port}`, checkpoint: 'fixture-checkpoint', contextLimit: 4096, headLimit: 512, tokenizerJsonPath: tokenizerPath, tokenizerSha256, timeoutMs: 10_000 },
  };
  const env = { ...(process.env as Record<string, string>), SHEG_DATA_DIR: dataRoot };
  const clientA = new Client({ name: 'question-group-package-a', version: '1.0.0' });
  const transportA = new StdioClientTransport({ command: process.execPath, args: [path.join(plugin, 'dist', 'mcp.js')], cwd: plugin, env });
  await clientA.connect(transportA);
  let workerPid = 0;
  let resumedWorkerPid = 0;
  try {
    const inspected = await clientA.callTool({ name: 'run_inspect', arguments: { request: runRequest } });
    assert.equal((inspected.structuredContent as { valid: boolean }).valid, true, JSON.stringify(inspected.structuredContent));
    const started = await clientA.callTool({ name: 'run_start', arguments: { submissionId: randomUUID(), request: runRequest } });
    const runId = (started.structuredContent as { runId: string }).runId;
    await waitForSignal(arrived, 'second independent provider request');
    const db = new DatabaseSync(path.join(dataRoot, 'runs.sqlite'));
    try {
      const owner = db.prepare('SELECT owner_pid, owner_token FROM runs WHERE run_id = ?').get(runId) as { owner_pid?: number; owner_token?: string } | undefined;
      assert.ok(owner?.owner_token);
      workerPid = Number(owner.owner_pid);
      assert.ok(Number.isInteger(workerPid) && workerPid > 0 && isPidAlive(workerPid));
      await waitForEvaluationStatus(db, runId, 'interest', 'answered');
    } finally { db.close(); }
    killPid(workerPid);
    await waitForPidExit(workerPid);
    const expire = new DatabaseSync(path.join(dataRoot, 'runs.sqlite'));
    try { expire.prepare('UPDATE runs SET lease_expires_ms = 0 WHERE run_id = ?').run(runId); }
    finally { expire.close(); }
    releaseSecond?.();
    await killMcpConnection(clientA, transportA);

    const clientB = new Client({ name: 'question-group-package-b', version: '1.0.0' });
    const transportB = new StdioClientTransport({ command: process.execPath, args: [path.join(plugin, 'dist', 'mcp.js')], cwd: plugin, env });
    try {
      await clientB.connect(transportB);
      const interrupted = await clientB.callTool({ name: 'run_get', arguments: { runId, view: 'status' } });
      assert.equal((interrupted.structuredContent as { status: string; usedCalls: number }).status, 'interrupted');
      assert.equal((interrupted.structuredContent as { usedCalls: number }).usedCalls, 2);
      const resumed = await clientB.callTool({ name: 'run_resume', arguments: { runId } });
      assert.equal(resumed.isError ?? false, false, JSON.stringify(resumed.structuredContent));
      await waitForSignal(finalRequestArrived, 'resumed final provider request');
      const resumedOwner = new DatabaseSync(path.join(dataRoot, 'runs.sqlite'));
      try {
        const owner = resumedOwner.prepare('SELECT owner_pid FROM runs WHERE run_id = ?').get(runId) as { owner_pid?: number } | undefined;
        resumedWorkerPid = Number(owner?.owner_pid);
        assert.ok(Number.isInteger(resumedWorkerPid) && resumedWorkerPid > 0, 'The resumed run must have a live worker before its last answer is released.');
      } finally { resumedOwner.close(); }
      releaseFinal?.();
      await waitForCompleted(dataRoot, runId);
      await waitForPidExit(resumedWorkerPid);
      assert.deepEqual(calls, ['interest', 'severity', 'severity', 'why-interest']);
      const interest = await clientB.callTool({ name: 'run_query', arguments: { sourceRunId: runId, criteria: { questionId: 'interest' } } });
      const severity = await clientB.callTool({ name: 'run_query', arguments: { sourceRunId: runId, criteria: { questionId: 'severity' } } });
      assert.equal((interest.structuredContent as { items: unknown[] }).items.length, 1);
      assert.equal((severity.structuredContent as { items: unknown[] }).items.length, 1);
      const answers = await clientB.callTool({ name: 'run_get', arguments: { runId, view: 'answers' } });
      const items = (answers.structuredContent as { items: Array<{ questionId: string; status: string }> }).items;
      assert.equal(items.length, 3);
      assert.ok(items.every(({ status }) => status === 'answered'));
    } finally { await killMcpConnection(clientB, transportB); }
  } finally {
    releaseSecond?.();
    releaseFinal?.();
    if (workerPid) {
      killPid(workerPid);
      await waitForPidExit(workerPid);
    }
    if (resumedWorkerPid) {
      killPid(resumedWorkerPid);
      await waitForPidExit(resumedWorkerPid);
    }
    await killMcpConnection(clientA, transportA);
  }
});

async function killMcpConnection(client: Client, transport: StdioClientTransport): Promise<void> {
  const pid = transport.pid;
  if (pid && isPidAlive(pid)) {
    killPid(pid);
    await waitForPidExit(pid);
  }
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

async function waitForSignal(signal: Promise<void>, description: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), 10_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForCompleted(dataRoot: string, runId: string): Promise<void> {
  const store = openRunStore(dataRoot);
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (store.getStatus(runId).status === 'completed') return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(`Run ${runId} did not complete after its requesting MCP exited: ${JSON.stringify({ status: store.getStatus(runId), answers: store.answers(runId) })}`);
  } finally { store.close(); }
}

async function waitForEvaluationStatus(db: DatabaseSync, runId: string, questionId: string, expectedStatus: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let evaluations: Array<{ question_id: string; status: string }> = [];
  while (Date.now() < deadline) {
    evaluations = db.prepare('SELECT question_id, status FROM evaluations WHERE run_id = ? ORDER BY question_id').all(runId) as Array<{ question_id: string; status: string }>;
    if (evaluations.find(({ question_id }) => question_id === questionId)?.status === expectedStatus) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Evaluation ${questionId} did not reach ${expectedStatus}: ${JSON.stringify(evaluations)}`);
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
