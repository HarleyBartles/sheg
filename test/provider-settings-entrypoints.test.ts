import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createRunServiceForStore } from './helpers/run-service.js';
import { createPollingServer } from '../src/entrypoints/mcp.js';
import { runCli } from '../src/entrypoints/cli.js';
import { openRunStore } from '../src/infrastructure/run-store.js';
import type { RunService } from '../src/application/run-service.js';

const catalogue = { entries: [{
  id: 'local-reader', enabled: true,
  provider: { kind: 'laya', baseUrl: 'http://127.0.0.1:7071', checkpoint: 'reader-v1', contextLimit: 16_000, headLimit: 4_000,
    tokenizerJsonPath: 'C:/models/tokenizer.json', tokenizerSha256: 'a'.repeat(64), timeoutMs: 30_000 },
  execution: 'local', capabilities: ['text'], questionTypes: ['choice', 'score', 'noul'], pricing: { kind: 'no-provider-invoice' },
}] };

test('provider settings have one revisioned, secret-free application contract shared by CLI and MCP', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-provider-settings-entrypoints-'));
  const store = openRunStore(root);
  const service = createRunServiceForStore(store, root, () => { throw new Error('Settings operations must not construct or call a model.'); }, { async launch() {} }) as RunService;
  const requestPath = path.join(root, 'settings.json');
  const output: string[] = [];
  const errors: string[] = [];
  const io = { out(value: string) { output.push(value); }, error(value: string) { errors.push(value); } };
  const server = createPollingServer(service, root);
  const client = new Client({ name: 'provider-settings-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    const operation = (input: unknown) => service.providerSettings(input);
    const get = () => operation({ operation: 'get' });
    const initial = get() as { catalogue: { revision: number; entries: unknown[] }; preferences: unknown };
    assert.equal(initial.catalogue.revision, 0);
    assert.deepEqual(initial.catalogue.entries, []);

    await writeFile(requestPath, JSON.stringify({ operation: 'set', expectedRevision: 0, catalogue, preferences: { preferredOrder: ['local-reader'] } }));
    assert.equal(await runCli(['provider-settings', '--request', requestPath, '--data-root', root], io, service), 0, errors.join('\n'));
    assert.equal((JSON.parse(output.pop()!) as { catalogue: { revision: number } }).catalogue.revision, 1);

    const mcpRead = await client.callTool({ name: 'provider_settings', arguments: { operation: 'get' } });
    assert.equal(mcpRead.content[0]?.type, 'text');
    const afterCli = JSON.parse(mcpRead.content[0]!.type === 'text' ? mcpRead.content[0].text : '') as { catalogue: { revision: number }; preferences: { preferredOrder: string[] } };
    assert.equal(afterCli.catalogue.revision, 1);
    assert.deepEqual(afterCli.preferences.preferredOrder, ['local-reader']);

    const update = await client.callTool({ name: 'provider_settings', arguments: { operation: 'set', expectedRevision: 1,
      catalogue, preferences: { preferredOrder: [] } } });
    assert.equal(update.isError, undefined);
    await writeFile(requestPath, JSON.stringify({ operation: 'get' }));
    assert.equal(await runCli(['provider-settings', '--request', requestPath, '--data-root', root], io, service), 0, errors.join('\n'));
    const afterMcp = JSON.parse(output.pop()!) as { catalogue: { revision: number }; preferences: { preferredOrder: string[] } };
    assert.equal(afterMcp.catalogue.revision, 2);
    assert.deepEqual(afterMcp.preferences.preferredOrder, []);

    assert.throws(() => operation({ operation: 'set', expectedRevision: 2, catalogue, preferences: { preferredOrder: [] }, apiKey: 'never-accept-secrets' }), /Provider settings operation is invalid/);
    assert.equal((await client.callTool({ name: 'provider_settings', arguments: { operation: 'set', expectedRevision: 2, catalogue, preferences: { preferredOrder: [] }, apiKey: 'never-accept-secrets' } })).isError, true);
    assert.equal(await client.callTool({ name: 'provider_settings', arguments: { operation: 'set', expectedRevision: 0, catalogue, preferences: { preferredOrder: [] } } }).then((result) => result.isError), true);
    assert.doesNotMatch(JSON.stringify(await client.listTools()), /"(?:apiKey|tokenValue)"/i);
  } finally {
    await client.close();
    await server.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
