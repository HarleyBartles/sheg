import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
  const listed = await client.listTools();
  for (const name of ['poll_check', 'poll_trace', 'poll_start', 'poll_status', 'poll_cancel', 'poll_resume', 'poll_report', 'poll_compare']) {
    assert.ok(listed.tools.some((tool) => tool.name === name), `Missing ${name}`);
  }
  const checked = await client.callTool({ name: 'poll_check', arguments: { config: {
    manifestPath: path.resolve('test/fixtures/article.json'), cohortPath: path.resolve('test/fixtures/cohort.json'), outputDirectory: directory,
    maxCalls: 10, maxUsd: 1, maxPerCallUsd: 0.1,
    provider: { kind: 'jev', model: 'jev-latest', keyEnv: 'POLL_TEST_MISSING_KEY', endpoint: 'https://api.typesafe.ai/v1/alpha/decisions', timeoutMs: 5000 },
  } } });
  assert.equal(checked.isError ?? false, false);
  assert.equal((checked.structuredContent as { valid?: boolean }).valid, true);
  const trace = await client.callTool({ name: 'poll_trace', arguments: {
    manifestPath: path.resolve('test/fixtures/article.json'), cohortPath: path.resolve('test/fixtures/cohort.json'), readerId: 'curious-outside-reader', choices: ['continue', 'continue'],
  } });
  assert.equal(JSON.parse((trace.content[0] as { text: string }).text).outcome, 'completed');
  const malformed = await client.callTool({ name: 'poll_check', arguments: { config: { manifestPath: 'missing.json', cohortPath: 'missing.json', outputDirectory: directory, maxCalls: 1, provider: { kind: 'laya', baseUrl: 'not-url', checkpoint: '', contextLimit: 0, timeoutMs: 0 } } } });
  assert.equal(malformed.isError, true);
});
