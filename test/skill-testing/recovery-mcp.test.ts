import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import test from 'node:test';
import { seedWorkflowState } from '../../scripts/skill-testing/workflow-seeds.js';

test('dedicated recovery MCP resumes an isolated saved journey through real Sheg tools', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-recovery-mcp-'));
  const setup = { kind: 'partial-journey-recovery' as const, version: 1 as const };
  const seeded = await seedWorkflowState(setup, root);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', path.resolve('scripts/skill-testing/recovery-mcp.ts')],
    cwd: process.cwd(),
    env: { ...process.env, SHEG_DATA_DIR: root, PLUGIN_DATA: root },
  });
  const client = new Client({ name: 'sheg-recovery-harness-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(({ name }) => name === 'run_resume'));
    const before = await client.callTool({ name: 'run_get', arguments: { runId: seeded.runId, view: 'status' } });
    assert.equal((before.structuredContent as { status: string }).status, 'partial');
    const resumed = await client.callTool({ name: 'run_resume', arguments: { runId: seeded.runId } });
    const status = resumed.structuredContent as { runId: string; status: string; usedCalls: number };
    assert.equal(status.runId, seeded.runId);
    assert.equal(status.status, 'completed');
    assert.equal(status.usedCalls, 4);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
