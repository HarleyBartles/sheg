import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

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
  const plugin = path.join(sandbox, 'installed', 'system-one-polling');
  await mkdir(path.dirname(plugin), { recursive: true });
  for (const item of ['plugin.json', 'mcp.json', 'dist', 'skills']) await cp(path.resolve(item), path.join(plugin, item), { recursive: true });
  assert.equal(await exists(path.join(plugin, 'node_modules')), false);
  const manifest = JSON.parse(await readFile(path.join(plugin, 'plugin.json'), 'utf8')) as { name: string };
  const mcp = JSON.parse(await readFile(path.join(plugin, 'mcp.json'), 'utf8')) as { mcpServers: Record<string, { type: string; command: string; args: string[]; cwd: string }> };
  assert.equal(manifest.name, 'system-one-polling');
  assert.equal(mcp.mcpServers['system-one-polling']?.type, 'stdio');
  assert.equal(mcp.mcpServers['system-one-polling']?.args[0], '${PLUGIN_ROOT}/dist/mcp.js');
  assert.equal(mcp.mcpServers['system-one-polling']?.cwd, '${PLUGIN_ROOT}');
  const inputs = path.join(sandbox, 'user-study');
  await mkdir(inputs);
  for (const fixture of ['article.json', 'cohort.json', 'article-source.md']) await cp(path.resolve('test/fixtures', fixture), path.join(inputs, fixture));
  const client = new Client({ name: 'copied-plugin-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: 'node', args: [path.join(plugin, 'dist', 'mcp.js')], cwd: plugin });
  cleanup.closeTransport = async () => {
    try {
      await client.close();
    } finally {
      await transport.close();
    }
  };
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 8);
  const result = await client.callTool({ name: 'poll_check', arguments: { config: {
    manifestPath: path.join(inputs, 'article.json'), cohortPath: path.join(inputs, 'cohort.json'), outputDirectory: path.join(sandbox, 'runs'),
    maxCalls: 10, provider: { kind: 'laya', baseUrl: 'http://127.0.0.1:8000', checkpoint: 'unavailable-checkpoint', contextLimit: 4096, timeoutMs: 5000 },
  } } });
  assert.equal(result.isError ?? false, false);
  assert.equal((result.structuredContent as { valid?: boolean }).valid, true);
  const skill = await readFile(path.join(plugin, 'skills/simulated-reader-polling/SKILL.md'), 'utf8');
  assert.match(skill, /references\/prepare-and-trace\.md/);
  assert.match(skill, /references\/run-and-recovery\.md/);
  assert.match(skill, /references\/interpret-results\.md/);
  assert.match(skill, /poll_check` before `poll_start`/);
  const runGuidance = await readFile(path.join(plugin, 'skills/simulated-reader-polling/references/run-and-recovery.md'), 'utf8');
  assert.match(runGuidance, /explicit user authorization/);
  const resultsGuidance = await readFile(path.join(plugin, 'skills/simulated-reader-polling/references/interpret-results.md'), 'utf8');
  assert.match(resultsGuidance, /simulation of profile-conditioned judgments/);
});

async function exists(filePath: string): Promise<boolean> {
  try { await readFile(filePath); return true; } catch { return false; }
}
