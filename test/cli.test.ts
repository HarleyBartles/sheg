import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../src/entrypoints/cli.js';
import { randomUUID } from 'node:crypto';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createPollingServer } from '../src/entrypoints/mcp.js';
import { createRunServiceForStore as createRunService } from './helpers/run-service.js';
import { openRunStore, splitRunStore } from '../src/infrastructure/run-store.js';
import { executeQuestionRun } from '../src/application/question-worker.js';
import type { InlineRunRequest } from '../src/domain/run/request.js';

test('CLI and MCP share durable execution, submission retries, recall and cancellation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-entrypoints-'));
  const store = openRunStore(root);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const request: InlineRunRequest = { kind: 'poll', respondents: [{ id: 'reader', intent: 'Learn', context: 'New reader', desired_outcome: 'Choose', engagement_cues: 'Examples', friction_cues: 'Hype' }], material: [{ id: 'opening', text: 'Exact text' }], questions: [{ type: 'choice', id: 'fit', instructions: 'Does it fit?', options: { yes: 'Yes', no: 'No' } }], provider: { kind: 'jev', route: 'openrouter', model: 'typesafe/jev-1.13' }, maxCalls: 1 };
  const fit = { provider: 'jev' as const, status: 'fits' as const, method: 'test', modelIdentity: 'typesafe/jev-1.13', tokenCount: 'estimated' as const, tokens: 10, contextLimit: 1000, headroomTokens: 100, effectiveLimit: 900, details: {} };
  const provider = { measure: () => fit, async decide() { return { type: 'choice' as const, choice: 'yes', probabilities: { yes: 1, no: 0 }, attempts: 1, provider: 'jev' as const, model: 'typesafe/jev-1.13', latencyMs: 1, usage: {} }; } };
  let launches = 0;
  const service = createRunService(store, root, () => provider, { async launch(_root, runId) { launches += 1; await executeQuestionRun(splitRunStore(store), runId, () => provider); } });
  const requestPath = path.join(root, 'request.json');
  await writeFile(requestPath, JSON.stringify(request));
  const output: string[] = []; const errors: string[] = [];
  const io = { out: (text: string) => { output.push(text); return true; }, error: (text: string) => { errors.push(text); return true; } };
  const submissionId = randomUUID();
  const args = ['start', '--request', requestPath, '--submission-id', submissionId];
  assert.equal(await runCli(args, io, service), 0, errors.join('\n'));
  const run = JSON.parse(output.pop()!);
  assert.equal(run.status, 'completed');
  assert.equal(await runCli(args, io, service), 0);
  assert.equal(JSON.parse(output.pop()!).runId, run.runId);
  assert.equal(launches, 1);
  const server = createPollingServer(service);
  const client = new Client({ name: 'cli-parity', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const recalled = await client.callTool({ name: 'run_get', arguments: { runId: run.runId, view: 'answers' } });
    const answers = recalled.structuredContent as { items: Array<{ result: { choice: string } }> };
    assert.equal(answers.items[0]?.result.choice, 'yes');
    const queryPath = path.join(root, 'query.json');
    await writeFile(queryPath, JSON.stringify({ sourceRunId: run.runId, criteria: { questionId: 'fit' } }));
    assert.equal(await runCli(['query', '--query', queryPath], io, service), 0);
    assert.equal(JSON.parse(output.pop()!).totalMatches, 1);
    assert.equal(await runCli(['cancel', '--run-id', run.runId], io, service), 0);
    assert.equal(JSON.parse(output.pop()!).status, 'completed');
  } finally { await client.close(); await server.close(); }
});

test('CLI help lists all supported workflow commands', async () => {
  const lines: string[] = [];
  const status = await runCli(['--help'], { out: (text) => { lines.push(text); return true; }, error: (text) => { lines.push(text); return true; } });
  assert.equal(status, 0);
  for (const command of ['inspect', 'preflight', 'trace', 'start', 'list', 'query', 'get', 'cancel', 'resume', 'storage']) assert.match(lines[0] ?? '', new RegExp(command));
});

test('CLI inspect validates current inline requests without starting a run', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sheg-cli-inspect-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requestPath = path.join(directory, 'request.json');
  await writeFile(requestPath, JSON.stringify({ kind: 'poll', respondents: [{ id: 'reader', intent: 'Learn', context: 'New', desired_outcome: 'Choose', engagement_cues: 'Examples', friction_cues: 'Hype' }], material: [{ id: 'opening', text: 'Exact text' }], questions: [{ type: 'choice', id: 'fit', instructions: 'Does it fit?', options: { yes: 'Yes' } }], provider: { kind: 'jev', route: 'openrouter', model: 'typesafe/jev-1.13' }, maxCalls: 1 }));
  const output: string[] = [];
  const service = { async inspect() { return { valid: true, respondentCount: 1 }; } } as never;
  const status = await runCli(['inspect', '--request', requestPath], { out: (text) => { output.push(text); return true; }, error: () => true }, service);
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(output[0] ?? '{}'), { valid: true, respondentCount: 1 });
});

test('CLI rejects unknown and duplicate options before reading input or calling the service', async () => {
  let inspections = 0;
  const service = { async inspect() { inspections += 1; return { valid: true }; } } as never;
  for (const [args, expected] of [
    [['inspect', '--request', 'request.json', '--unexpected', 'value'], /not supported by inspect/],
    [['inspect', '--request', 'request.json', '--request', 'other.json'], /supplied more than once/],
  ] as const) {
    const errors: string[] = [];
    const status = await runCli(args, { out: () => true, error: (text) => { errors.push(text); return true; } }, service);
    assert.equal(status, 1);
    assert.match(JSON.parse(errors[0] ?? '{}').error, expected);
  }
  assert.equal(inspections, 0);
});

test('CLI preflight reports incomplete fit evidence for variable response histories without provider calls', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'polling-preflight-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const providersPath = path.join(directory, 'providers.json');
  await writeFile(providersPath, JSON.stringify([{ kind: 'jev', model: 'typesafe/jev-1.13', endpoint: 'https://openrouter.ai/api/alpha/decisions', timeoutMs: 1000 }]));
  const output: string[] = []; const errors: string[] = [];
  const status = await runCli(['preflight', '--manifest', path.resolve('test/fixtures/article.json'), '--cohort', path.resolve('test/fixtures/cohort.json'), '--providers', providersPath], {
    out: (text) => { output.push(text); return true; }, error: (text) => { errors.push(text); return true; },
  });
  assert.equal(status, 0, errors.join('\n'));
  const result = JSON.parse(output[0] ?? '{}') as { providers: Array<{ status: string; packetCount: number; incompleteReason?: string }> };
  assert.equal(result.providers[0]?.status, 'unverified');
  assert.match(result.providers[0]?.incompleteReason ?? '', /response history/i);
  assert.ok((result.providers[0]?.packetCount ?? 0) > 0);
});

test('CLI preflight rejects an unknown mode instead of selecting frozen-cohort', async () => {
  const errors: string[] = [];
  const status = await runCli(['preflight', '--mode', 'maximum-profiles', '--manifest', 'study.json', '--providers', 'providers.json'], {
    out: () => true, error: (value) => { errors.push(value); return true; },
  });
  assert.equal(status, 1);
  assert.match(errors[0] ?? '', /mode/i);
});

test('CLI scripted trace is keyless and uses the shared graph runner', async () => {
  const output: string[] = [];
  const status = await runCli(['trace', '--manifest', path.resolve('test/fixtures/article.json'), '--cohort', path.resolve('test/fixtures/cohort.json'), '--arm', 'original', '--respondent', 'curious-outside-reader', '--choices', 'continue,continue'], {
    out: (text) => { output.push(text); return true; }, error: (text) => { output.push(text); return true; },
  });
  assert.equal(status, 0);
  assert.equal(JSON.parse(output[0] ?? '{}').outcome, 'completed');
});

test('CLI trace accepts typed response JSON while preserving the Choice trace path', async () => {
  const output: string[] = [];
  const status = await runCli(['trace', '--manifest', path.resolve('test/fixtures/article.json'), '--cohort', path.resolve('test/fixtures/cohort.json'), '--arm', 'original', '--respondent', 'curious-outside-reader', '--responses', JSON.stringify([{ type: 'choice', choice: 'continue' }, { type: 'choice', choice: 'continue' }])], {
    out: (text) => { output.push(text); return true; }, error: (text) => { output.push(text); return true; },
  });
  assert.equal(status, 0);
  assert.equal(JSON.parse(output[0] ?? '{}').outcome, 'completed');
});

test('CLI trace rejects missing or conflicting scripted response forms', async () => {
  for (const options of [[], ['--choices', 'continue', '--responses', '[]']]) {
    const errors: string[] = [];
    const status = await runCli(['trace', '--manifest', path.resolve('test/fixtures/article.json'), '--cohort', path.resolve('test/fixtures/cohort.json'), '--arm', 'original', '--respondent', 'curious-outside-reader', ...options], {
      out: () => true, error: (text) => { errors.push(text); return true; },
    });
    assert.equal(status, 1);
    assert.match(errors[0] ?? '', /exactly one/i);
  }
});

test('CLI returns a bounded JSON error for a supported command without exposing the input path', async () => {
  const errors: string[] = [];
  const secretPath = path.join(os.tmpdir(), 'POLL_TEST_MISSING_KEY', 'request.json');
  const status = await runCli(['inspect', '--request', secretPath], { out: () => true, error: (text) => { errors.push(text); return true; } });
  assert.equal(status, 1);
  assert.deepEqual(JSON.parse(errors[0] ?? '{}'), { error: 'The specified JSON file is missing or invalid.' });
  assert.doesNotMatch(errors[0] ?? '', /stack|undefined|POLL_TEST_MISSING_KEY/);
});
