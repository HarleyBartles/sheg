import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
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
  for (const item of ['plugin.json', 'mcp.json', 'dist']) await cp(path.resolve(item), path.join(plugin, item), { recursive: true });
  await cp(path.resolve('skills/simulated-reader-polling/SKILL.md'), path.join(plugin, 'skills/simulated-reader-polling/SKILL.md'), { recursive: true });
  await cp(path.resolve('skills/simulated-reader-polling/references'), path.join(plugin, 'skills/simulated-reader-polling/references'), { recursive: true });
  await cp(path.resolve('skills/simulated-reader-polling/assets'), path.join(plugin, 'skills/simulated-reader-polling/assets'), { recursive: true });
  await assertSkillLinksResolve(path.join(plugin, 'skills/simulated-reader-polling'), plugin);
  assert.equal(await exists(path.join(plugin, 'dist/data/reader-archetypes.json')), true);
  for (const contract of ['reader-archetype.schema.json', 'reader-archetype-library.schema.json', 'reader-profile.schema.json', 'frozen-cohort.schema.json', 'study-manifest.schema.json']) {
    assert.equal(await exists(path.join(plugin, 'skills/simulated-reader-polling/assets', contract)), true);
  }
  assert.equal(await exists(path.join(plugin, 'dist/skills/simulated-reader-polling/assets/reader-archetypes.json')), false);
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
  assert.match(skill, /author reader archetypes/);
  assert.match(skill, /references\/archetypes-and-cohorts\.md/);
  assert.match(skill, /references\/prepare-and-trace\.md/);
  assert.match(skill, /references\/run-and-recovery\.md/);
  assert.match(skill, /references\/interpret-results\.md/);
  assert.match(skill, /poll_check` before `poll_start`/);
  const runGuidance = await readFile(path.join(plugin, 'skills/simulated-reader-polling/references/run-and-recovery.md'), 'utf8');
  assert.match(runGuidance, /explicit user authorization/);
  const resultsGuidance = await readFile(path.join(plugin, 'skills/simulated-reader-polling/references/interpret-results.md'), 'utf8');
  assert.match(resultsGuidance, /simulation of profile-conditioned judgments/);
  const cohortGuidance = await readFile(path.join(plugin, 'skills/simulated-reader-polling/references/archetypes-and-cohorts.md'), 'utf8');
  assert.match(cohortGuidance, /Supply profiles directly/);
  assert.equal(await exists(path.resolve(plugin, 'skills/simulated-reader-polling/references/../../../dist/data/reader-archetypes.json')), true);
});

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
      assert.ok(resolvedPath.startsWith(pluginDirectory), `Skill link escapes plugin: ${target}`);
      assert.equal(await exists(resolvedPath), true, `Broken packaged skill link in ${relativePath}: ${target}`);
    }
  }
}
