import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('MCP exposes the shared polling operations and keyless poll_check', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'polling-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new Client({ name: 'polling-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', path.resolve('src/entrypoints/mcp.ts')], cwd: process.cwd() });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  let inferenceRequests = 0;
  const inferenceServer = createServer((_request, response) => {
    inferenceRequests += 1;
    response.writeHead(500).end();
  });
  await new Promise<void>((resolve, reject) => {
    inferenceServer.once('error', reject);
    inferenceServer.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => new Promise<void>((resolve, reject) => inferenceServer.close((error) => error ? reject(error) : resolve())));
  const inferenceAddress = inferenceServer.address();
  assert.ok(inferenceAddress && typeof inferenceAddress === 'object');
  const listed = await client.listTools();
  for (const name of ['poll_preview', 'poll_check', 'poll_preflight', 'poll_trace', 'poll_start', 'poll_status', 'poll_cancel', 'poll_resume', 'poll_report', 'poll_compare', 'poll_compare_runs', 'poll_measure_packets']) {
    assert.ok(listed.tools.some((tool) => tool.name === name), `Missing ${name}`);
  }
  const preview = await client.callTool({ name: 'poll_preview', arguments: { manifestPath: path.resolve('test/fixtures/article.json') } });
  assert.equal(preview.isError ?? false, false);
  const previewContent = preview.structuredContent as { arms: Array<{ armId: string; presentation: string; nodes: Array<{ kind: string; id: string; routeContexts?: Array<{ exposedStimulusIds: string[]; priorChoices: Array<{ taskId: string; optionId: string; meaning: string }>; priorResponses: unknown[] }> }> }> };
  assert.equal(previewContent.arms[0]?.armId, 'original');
  assert.equal(previewContent.arms[0]?.presentation, 'graph');
  assert.ok(previewContent.arms[0]?.nodes.some((node) => node.id === 'choose-investigation' && node.kind === 'question'));
  const investigationPreview = previewContent.arms[0]?.nodes.find((node) => node.id === 'choose-investigation');
  assert.deepEqual(investigationPreview?.routeContexts, [{
    path: [{ nodeId: 'show-symptom' }, { nodeId: 'choose-entry', optionId: 'continue' }, { nodeId: 'show-investigation' }, { nodeId: 'choose-investigation' }],
    exposedStimulusIds: ['investigation'],
    priorChoices: [{ nodeId: 'choose-entry', taskId: 'entry-response', optionId: 'continue', meaning: 'Continue to the next item.', exposedItemIds: ['symptom'] }],
    priorResponses: [],
  }]);
  assert.equal(JSON.parse((preview.content[0] as { text: string }).text).arms[0]?.armId, 'original');
  const invalidPreview = await client.callTool({ name: 'poll_preview', arguments: { manifestPath: path.resolve('missing-manifest.json') } });
  assert.equal(invalidPreview.isError, true);
  const checked = await client.callTool({ name: 'poll_check', arguments: { config: {
    manifestPath: path.resolve('test/fixtures/article.json'), cohortPath: path.resolve('test/fixtures/cohort.json'), outputDirectory: directory,
    maxCalls: 5,
    provider: { kind: 'jev', route: 'typesafe', model: 'jev-latest', endpoint: 'https://api.typesafe.ai/v1/alpha/decisions', timeoutMs: 5000 },
  } } });
  assert.equal(checked.isError ?? false, false);
  assert.equal((checked.structuredContent as { valid?: boolean }).valid, true);
  const jevBounds = (checked.structuredContent as { runBounds: { minimumDecisionCalls: number; maximumDecisionCalls: number; maximumCallsConfigured: number; maximumCallsSufficient: boolean } }).runBounds;
  assert.deepEqual(jevBounds, {
    minimumDecisionCalls: 2,
    maximumDecisionCalls: 6,
    maximumCallsConfigured: 5,
    maximumCallsSufficient: false,
  });
  const tokenizerPath = path.resolve('test/fixtures/laya-tokenizer.json');
  const layaCheck = await client.callTool({ name: 'poll_check', arguments: { config: {
    manifestPath: path.resolve('test/fixtures/article.json'), cohortPath: path.resolve('test/fixtures/cohort.json'), outputDirectory: directory,
    maxCalls: 10,
    provider: { kind: 'laya', baseUrl: 'http://127.0.0.1:8000', checkpoint: 'check-only', contextLimit: 1024, headLimit: 192, tokenizerJsonPath: tokenizerPath, tokenizerSha256: createHash('sha256').update(readFileSync(tokenizerPath)).digest('hex'), timeoutMs: 1000 },
  } } });
  assert.equal(layaCheck.isError ?? false, false);
  const layaBounds = (layaCheck.structuredContent as { runBounds: Record<string, unknown> }).runBounds;
  assert.equal(layaBounds.minimumDecisionCalls, 2);
  assert.equal(layaBounds.maximumDecisionCalls, 6);
  assert.equal(layaBounds.maximumCallsSufficient, true);
  assert.equal(Object.hasOwn(layaBounds, 'spendCeilingUsd'), false);
  const preflight = await client.callTool({ name: 'poll_preflight', arguments: {
    manifestPath: path.resolve('test/fixtures/article.json'), cohortPath: path.resolve('test/fixtures/cohort.json'),
    providers: [{ kind: 'jev', model: 'typesafe/jev-1.13', endpoint: 'https://example.invalid/decisions', timeoutMs: 1000 }],
  } });
  assert.equal(preflight.isError ?? false, false);
  assert.equal((preflight.structuredContent as { providers: Array<{ status: string; incompleteReason?: string }> }).providers[0]?.status, 'unverified');
  assert.match((preflight.structuredContent as { providers: Array<{ incompleteReason?: string }> }).providers[0]?.incompleteReason ?? '', /response history/i);
  const layaProvider = {
    kind: 'laya', baseUrl: `http://127.0.0.1:${inferenceAddress.port}`, checkpoint: 'measurement-only', contextLimit: 1024, headLimit: 192,
    tokenizerJsonPath: path.resolve('test/fixtures/laya-tokenizer.json'),
    tokenizerSha256: createHash('sha256').update(readFileSync(path.resolve('test/fixtures/laya-tokenizer.json'))).digest('hex'), timeoutMs: 1000,
  };
  const packetVariants = {
    providers: [layaProvider], combination: 'paired',
    respondents: [{ id: 'reader-one', value: {
      intent: 'Understand the practical point.', context: 'Reads about software.', desired_outcome: 'Learn what changed.',
      engagement_cues: 'Concrete examples.', friction_cues: 'Unexplained jargon.',
    } }],
    stimuli: [{ id: 'opening', value: [{ id: 'opening', text: 'A short opening passage.' }] }],
    tasks: [
      { id: 'task-one', value: { id: 'question-one', instructions: 'What matters here?', options: { continue: 'Continue', stop: 'Stop' } } },
      { id: 'task-two', value: { id: 'question-two', instructions: 'What should happen next?', options: { continue: 'Continue', stop: 'Stop' } } },
    ],
    trajectories: [{ id: 'start', value: { version: 1, eventCount: 0, exposureCount: 0, decisionCount: 0, eventRange: null, choices: [], payloadUtf8Bytes: 0 } }],
  };
  const measured = await client.callTool({ name: 'poll_measure_packets', arguments: packetVariants });
  assert.equal(measured.isError ?? false, false);
  const measuredContent = measured.structuredContent as { complete: boolean; caseCount: number; cases: Array<{ measurements: Array<{ status: string; tokenCount: string; tokens: number }> }>; providers: Array<{ largestCase: { tokens: number } }> };
  assert.equal(measuredContent.complete, true);
  assert.equal(measuredContent.caseCount, 2);
  assert.equal(measuredContent.cases.length, 2);
  assert.ok(measuredContent.cases.every((item) => item.measurements[0]?.status === 'fits' && item.measurements[0]?.tokenCount === 'measured'));
  const largestTokens = measuredContent.providers[0]?.largestCase?.tokens;
  assert.ok(typeof largestTokens === 'number' && largestTokens > 0);
  assert.deepEqual(JSON.parse((measured.content[0] as { text: string }).text), measured.structuredContent);
  const trace = await client.callTool({ name: 'poll_trace', arguments: {
    manifestPath: path.resolve('test/fixtures/article.json'), cohortPath: path.resolve('test/fixtures/cohort.json'), armId: 'original', respondentId: 'curious-outside-reader', choices: ['continue', 'continue'],
  } });
  assert.equal(JSON.parse((trace.content[0] as { text: string }).text).outcome, 'completed');
  const typedTrace = await client.callTool({ name: 'poll_trace', arguments: {
    manifestPath: path.resolve('test/fixtures/article.json'), cohortPath: path.resolve('test/fixtures/cohort.json'), armId: 'original', respondentId: 'curious-outside-reader', responses: [{ type: 'choice', choice: 'continue' }, { type: 'choice', choice: 'continue' }],
  } });
  assert.equal(typedTrace.isError ?? false, false);
  assert.equal(JSON.parse((typedTrace.content[0] as { text: string }).text).outcome, 'completed');
  const conflictingTrace = await client.callTool({ name: 'poll_trace', arguments: {
    manifestPath: path.resolve('test/fixtures/article.json'), cohortPath: path.resolve('test/fixtures/cohort.json'), armId: 'original', respondentId: 'curious-outside-reader', choices: ['continue'], responses: [{ type: 'choice', choice: 'continue' }],
  } });
  assert.equal(conflictingTrace.isError, true);
  assert.equal(inferenceRequests, 0, 'MCP checks, previews, traces, and packet measurements must not call the inference endpoint.');
  const malformed = await client.callTool({ name: 'poll_check', arguments: { config: { manifestPath: 'missing.json', cohortPath: 'missing.json', outputDirectory: directory, maxCalls: 1, provider: { kind: 'laya', baseUrl: 'not-url', checkpoint: '', contextLimit: 0, timeoutMs: 0 } } } });
  assert.equal(malformed.isError, true);
});
