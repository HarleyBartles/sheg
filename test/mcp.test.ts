import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { DecisionProvider } from '../src/domain/decision/provider.js';
import type { InlineRunRequest } from '../src/domain/run/request.js';
import { createRunServiceForStore as createRunService } from './helpers/run-service.js';
import { openRunStore, splitRunStore } from '../src/infrastructure/run-store.js';
import { createPollingServer } from '../src/entrypoints/mcp.js';
import { CredentialStoreError } from '../src/infrastructure/credentials/windows.js';
import { seedWorkflowState } from '../scripts/skill-testing/workflow-seeds.js';
import { createControlledRecoveryProvider } from '../scripts/skill-testing/controlled-recovery.js';
import { executeQuestionRun } from '../src/application/question-worker.js';
import { createStaticImageCodec } from '../src/infrastructure/images/codecs.js';
import { runCli } from '../src/entrypoints/cli.js';
import { ClefProvider } from '../src/providers/clef.js';
import { openImageAssetRepository } from '../src/infrastructure/sqlite/image-assets.js';
import type { ProviderConfigInput } from '../src/providers/config.js';

const packageVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

async function localImageCodec(root: string) {
  const directory = path.join(root, 'codec-assets');
  await mkdir(directory);
  const packages = fileURLToPath(new URL('../node_modules/@jsquash/', import.meta.url));
  const assets = [
    ['png/codec/pkg/squoosh_png_bg.wasm', 'squoosh_png_bg.wasm'],
    ['jpeg/codec/dec/mozjpeg_dec.wasm', 'mozjpeg_dec.wasm'],
    ['jpeg/codec/enc/mozjpeg_enc.wasm', 'mozjpeg_enc.wasm'],
    ['webp/codec/dec/webp_dec.wasm', 'webp_dec.wasm'],
    ['webp/codec/enc/webp_enc_simd.wasm', 'webp_enc_simd.wasm'],
    ['resize/lib/resize/pkg/squoosh_resize_bg.wasm', 'squoosh_resize_bg.wasm'],
  ];
  await Promise.all(assets.map(([source, target]) => copyFile(path.join(packages, source!), path.join(directory, target!))));
  return createStaticImageCodec(directory);
}

function request(): InlineRunRequest {
  return { kind: 'poll', respondents: [{ id: 'reader-a', intent: 'Understand', context: 'New reader', desired_outcome: 'Choose', engagement_cues: 'Examples', friction_cues: 'Hype' }], material: [{ id: 'opening', text: 'A short passage.' }], questions: [{ type: 'choice', id: 'interest', instructions: 'Would you continue?', options: { continue: 'Continue', leave: 'Leave' } }], provider: { kind: 'jev', route: 'openrouter', model: 'typesafe/jev-1.13' }, maxCalls: 1 };
}

function journeyRequest() {
  return {
    kind: 'journey' as const,
    respondents: request().respondents,
    journey: {
      id: 'article', label: 'Article journey', items: [{ id: 'opening', text: 'The opening.' }],
      tasks: [{ id: 'interest', type: 'choice' as const, instructions: 'Would you continue?', options: { continue: 'Continue', leave: 'Leave' } }],
      presentation: { kind: 'sequence' as const },
    },
    provider: { kind: 'jev' as const, route: 'openrouter' as const, model: 'typesafe/jev-1.13' },
    maxCalls: 2,
  };
}

async function connectedFixture(assertProviderReady: () => Promise<void> = async () => undefined, imageCodec?: Parameters<typeof createPollingServer>[2], credentialStore?: Parameters<typeof createPollingServer>[3]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-mcp-'));
  const store = openRunStore(root);
  const fit = { provider: 'jev' as const, status: 'fits' as const, method: 'test', modelIdentity: 'typesafe/jev-1.13', tokenCount: 'estimated' as const, tokens: 10, contextLimit: 1000, headroomTokens: 100, effectiveLimit: 900, details: {} };
  const calls = { providerFactory: 0, measure: 0, infer: 0, launch: 0, credentials: 0 };
  const provider: DecisionProvider = { measure() { calls.measure += 1; return fit; }, measureBatch() { calls.measure += 1; return fit; }, async decide() { calls.infer += 1; throw new Error('MCP admission must not infer.'); }, async decideBatch() { calls.infer += 1; throw new Error('MCP admission must not infer.'); } };
  const service = createRunService(store, root, () => { calls.providerFactory += 1; return provider; }, { async launch() { calls.launch += 1; } }, { assertProviderReady: async () => { calls.credentials += 1; await assertProviderReady(); } });
  const server = createPollingServer(service, root, imageCodec, credentialStore);
  const client = new Client({ name: 'sheg-mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { root, store, service, calls, server, client, close: async () => { await client.close(); await server.close(); store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('MCP advertises the package product version', async () => {
  const f = await connectedFixture();
  try {
    assert.equal(f.client.getServerVersion()?.version, packageVersion);
  } finally {
    await f.close();
  }
});

test('MCP provider credential status, setup and removal use the fixed Clef route and never return key material', async () => {
  const calls: string[] = [];
  let availability: 'available' | 'missing' = 'missing';
  const credentialStore = {
    async availability(route: string) { calls.push(`status:${route}`); return availability; },
    async setup(route: string) { calls.push(`setup:${route}`); availability = 'available'; },
    async remove(route: string) { calls.push(`remove:${route}`); availability = 'missing'; },
  };
  const f = await connectedFixture(async () => undefined, undefined, credentialStore);
  try {
    const tools = await f.client.listTools();
    assert.ok(tools.tools.some(({ name }) => name === 'provider_credential'));
    const status = await f.client.callTool({ name: 'provider_credential', arguments: { route: 'clef', operation: 'status' } });
    assert.deepEqual(status.structuredContent, { route: 'clef', operation: 'status', availability: 'missing' });
    const setup = await f.client.callTool({ name: 'provider_credential', arguments: { route: 'clef', operation: 'setup' } });
    assert.deepEqual(setup.structuredContent, { route: 'clef', operation: 'setup', availability: 'available' });
    const remove = await f.client.callTool({ name: 'provider_credential', arguments: { route: 'clef', operation: 'remove' } });
    assert.deepEqual(remove.structuredContent, { route: 'clef', operation: 'remove', availability: 'missing' });
    const arbitrary = await f.client.callTool({ name: 'provider_credential', arguments: { route: 'clef', operation: 'status', endpoint: 'https://attacker.invalid' } });
    assert.equal(arbitrary.isError, true);
    assert.equal(calls.some((call) => call.includes('attacker.invalid')), false);
    assert.equal(JSON.stringify([status, setup, remove]).includes('token'), false);
    assert.deepEqual(calls, ['status:clef', 'setup:clef', 'status:clef', 'remove:clef', 'status:clef']);
  } finally { await f.close(); }
});

test('MCP imports an image, scales its saved reference on a later connection, and CLI explicitly exports it', async () => {
  const codecRoot = await mkdtemp(path.join(os.tmpdir(), 'sheg-image-codec-'));
  const baseCodec = await localImageCodec(codecRoot);
  let decodeCalls = 0;
  const codec = { ...baseCodec, async decode(bytes: Uint8Array) { decodeCalls += 1; return baseCodec.decode(bytes); } };
  const f = await connectedFixture(async () => undefined, codec);
  const source = path.join(f.root, 'source.png');
  const original = new URL('./fixtures/images/four-corners-transparent.png', import.meta.url);
  let secondClient: Client | undefined;
  let secondServer: ReturnType<typeof createPollingServer> | undefined;
  try {
    await copyFile(original, source);
    const bytes = await readFile(source);
    const relative = await f.client.callTool({ name: 'image_import', arguments: { source: { path: 'source.png', sha256: createHash('sha256').update(bytes).digest('hex') } } });
    assert.equal(relative.isError, true);
    assert.equal((relative.structuredContent as { error: { code: string } }).error.code, 'image_source_path_invalid');
    const imported = await f.client.callTool({ name: 'image_import', arguments: { source: { path: source, sha256: createHash('sha256').update(bytes).digest('hex') } } });
    assert.equal(imported.isError ?? false, false, JSON.stringify(imported.structuredContent));
    const sourceAsset = (imported.structuredContent as { assetId: string }).assetId;
    await f.client.close();
    await f.server.close();
    await unlink(source);

    secondServer = createPollingServer(f.service, f.root, codec);
    secondClient = new Client({ name: 'sheg-image-test-next-connection', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([secondServer.connect(serverTransport), secondClient.connect(clientTransport)]);
    decodeCalls = 0;
    const missing = await secondClient.callTool({ name: 'image_scale', arguments: { source: { assetId: `sha256:${'f'.repeat(64)}` }, maxWidth: 40 } });
    assert.equal(missing.isError, true);
    assert.equal((missing.structuredContent as { error: { code: string } }).error.code, 'image_asset_not_found');
    assert.equal(decodeCalls, 0);
    const extraControl = await secondClient.callTool({ name: 'image_scale', arguments: { source: { assetId: sourceAsset }, maxWidth: 40, quality: 50 } });
    assert.equal(extraControl.isError, true);
    const scaled = await secondClient.callTool({ name: 'image_scale', arguments: { source: { assetId: sourceAsset }, maxWidth: 40 } });
    assert.equal(scaled.isError ?? false, false);
    const prepared = scaled.structuredContent as { source: { assetId: string }; candidate: { assetId: string; width: number; height: number } };
    assert.equal(prepared.source.assetId, sourceAsset);
    assert.deepEqual([prepared.candidate.width, prepared.candidate.height], [40, 20]);
    const metadata = await secondClient.callTool({ name: 'image_get', arguments: { assetId: prepared.candidate.assetId } });
    assert.equal(metadata.isError ?? false, false);
    assert.equal((metadata.structuredContent as { asset: { assetId: string } }).asset.assetId, prepared.candidate.assetId);
    const previewRoot = path.join(f.root, 'asset-previews');
    await assert.rejects(access(previewRoot), { code: 'ENOENT' });

    await secondClient.close();
    await secondServer.close();
    secondClient = undefined;
    secondServer = undefined;
    const requestPath = path.join(f.root, 'get.json');
    await writeFile(requestPath, JSON.stringify({ assetId: prepared.candidate.assetId, export: true }));
    const output: string[] = []; const errors: string[] = [];
    const status = await runCli(['image-get', '--request', requestPath, '--data-root', f.root], { out: (value) => { output.push(value); return true; }, error: (value) => { errors.push(value); return true; } }, f.service, codec);
    assert.equal(status, 0, errors.join('\n'));
    const exported = JSON.parse(output[0] ?? '{}') as { asset: { assetId: string }; path: string };
    assert.equal(exported.asset.assetId, prepared.candidate.assetId);
    const exportedBytes = await readFile(exported.path);
    assert.equal(createHash('sha256').update(exportedBytes).digest('hex'), (metadata.structuredContent as { asset: { sha256: string } }).asset.sha256);
    assert.equal((await codec.decode(exportedBytes)).width, 40);
    assert.deepEqual(f.calls, { providerFactory: 0, measure: 0, infer: 0, launch: 0, credentials: 0 });
  } finally {
    if (secondClient) await secondClient.close();
    if (secondServer) await secondServer.close();
    await f.client.close().catch(() => undefined);
    await f.server.close().catch(() => undefined);
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
    await rm(codecRoot, { recursive: true, force: true });
  }
});

test('MCP imports a source, inspects and accepts a Clef visual poll, then executes from retained bytes after source deletion', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-mcp-clef-'));
  const store = openRunStore(root);
  const imageRepository = openImageAssetRepository(root);
  const codec = await localImageCodec(root);
  let releaseDispatch!: () => void;
  let dispatchStarted!: () => void;
  const dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
  const dispatched = new Promise<void>((resolve) => { dispatchStarted = resolve; });
  let workerPromise: Promise<void> | undefined;
  let requestUrl = '';
  let requestImages: string[] = [];
  const credentials = { async readForAuthentication(route: string) { assert.equal(route, 'clef'); return 'fixture-clef-secret'; } };
  const fetchRequest = (async (url: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(url);
    const body = JSON.parse(String(init?.body)) as { images: string[] };
    requestImages = body.images;
    dispatchStarted();
    await dispatchGate;
    return Response.json({ success: true, result: { model: 'clef', answers: { 'image-fit': { type: 'choice', choice: 'yes', probabilities: { yes: 0.9, no: 0.1 } } }, usage: { input_tokens: 20, output_tokens: 0 } }, errors: [], messages: [] });
  }) as typeof fetch;
  const resolver = { resolve: (assetId: string) => ({ metadata: imageRepository.metadata(assetId), bytes: imageRepository.bytes(assetId) }) };
  const providerFactory = (config: ProviderConfigInput) => {
    if (config.kind !== 'clef') throw new Error('This fixture accepts only Clef.');
    return new ClefProvider(config, fetchRequest, { credentialStore: credentials, imageResolver: resolver });
  };
  const service = createRunService(store, root, providerFactory, { async launch(_dataRoot, runId) { workerPromise = executeQuestionRun(splitRunStore(store), runId, providerFactory); } });
  const server = createPollingServer(service, root, codec, { async availability() { return 'available'; }, async setup() {}, async remove() {} });
  const client = new Client({ name: 'sheg-mcp-clef-visual-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const source = path.join(root, 'source.png');
  const original = await readFile(new URL('./fixtures/images/four-corners-transparent.png', import.meta.url));
  await copyFile(new URL('./fixtures/images/four-corners-transparent.png', import.meta.url), source);
  t.after(async () => { releaseDispatch(); await client.close(); await server.close(); imageRepository.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const imported = await client.callTool({ name: 'image_import', arguments: { source: { path: source, sha256: createHash('sha256').update(original).digest('hex') } } });
  assert.equal(imported.isError ?? false, false, JSON.stringify(imported.structuredContent));
  const image = imported.structuredContent as { assetId: string; sha256: string; width: number; height: number; bytes: number; format: 'png' };
  const request: InlineRunRequest = {
    kind: 'poll', respondents: [{ id: 'reader', intent: 'Read the recommendation', context: 'Curious', desired_outcome: 'Understand the proposal', engagement_cues: 'Examples', friction_cues: 'Distraction' }],
    material: [{ id: 'section-four', text: 'The recommendation follows.' }, { id: 'portrait', type: 'image', text: '', altText: 'A determined specialist in a teal coat checks a ledger.', caption: 'Writ prepares the records.', asset: image }],
    questions: [{ type: 'choice', id: 'image-fit', instructions: 'Does the image support the recommendation?', options: { yes: 'It supports the section', no: 'It distracts from the section' }, visual: { mode: 'pixels', materialIds: ['portrait'] } }],
    provider: { kind: 'clef', accountId: '3327878972ea82e6b454069bba62f3d9', model: 'clef', timeoutMs: 1000 }, maxCalls: 1,
  };
  const inspection = await client.callTool({ name: 'run_inspect', arguments: { request } });
  assert.equal((inspection.structuredContent as { valid: boolean }).valid, true, JSON.stringify(inspection.structuredContent));
  const accepted = await client.callTool({ name: 'run_start', arguments: { submissionId: randomUUID(), request } });
  assert.equal(accepted.isError ?? false, false, JSON.stringify(accepted.structuredContent));
  const runId = (accepted.structuredContent as { runId: string }).runId;
  const frozen = await client.callTool({ name: 'run_get', arguments: { runId, view: 'request' } });
  const frozenRequest = frozen.structuredContent as { evaluations: Array<{ packet: { visualMaterials?: Array<{ asset: { assetId: string }; altText: string }> } }> };
  assert.equal(frozenRequest.evaluations[0]?.packet.visualMaterials?.[0]?.asset.assetId, image.assetId);
  assert.equal(frozenRequest.evaluations[0]?.packet.visualMaterials?.[0]?.altText, 'A determined specialist in a teal coat checks a ledger.');
  await dispatched;
  await unlink(source);
  releaseDispatch();
  await workerPromise;
  assert.equal(requestUrl, 'https://api.cloudflare.com/client/v4/accounts/3327878972ea82e6b454069bba62f3d9/ai/run/@cf/cloudflare/clef');
  assert.deepEqual(requestImages, [`data:image/png;base64,${original.toString('base64')}`]);
  const recalled = await client.callTool({ name: 'run_get', arguments: { runId, view: 'answers' } });
  assert.equal((recalled.structuredContent as { items: Array<{ status: string; execution: { provider: string; model: string } }> }).items[0]?.execution.provider, 'clef');
  assert.equal((recalled.structuredContent as { items: Array<{ status: string }> }).items[0]?.status, 'answered');
  assert.equal(store.attempts(runId).items.length, 1);
});

test('missing image codec is bounded and leaves storage maintenance usable', async () => {
  const f = await connectedFixture();
  const source = fileURLToPath(new URL('./fixtures/images/four-corners-transparent.png', import.meta.url));
  const bytes = await readFile(source);
  const missingCodecRoot = await mkdtemp(path.join(os.tmpdir(), 'sheg-missing-codec-'));
  const server = createPollingServer(f.service, f.root, createStaticImageCodec(missingCodecRoot));
  const client = new Client({ name: 'sheg-missing-image-codec-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: 'image_import', arguments: { source: { path: source, sha256: createHash('sha256').update(bytes).digest('hex') } } });
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as { error: { code: string } }).error.code, 'image_codec_unavailable');
    const storage = await client.callTool({ name: 'run_storage', arguments: { operation: 'inspect' } });
    assert.equal(storage.isError ?? false, false);
    assert.equal((storage.structuredContent as { recoveryRequired: boolean }).recoveryRequired, false);
  } finally {
    await client.close();
    await server.close();
    await f.close();
    await rm(missingCodecRoot, { recursive: true, force: true });
  }
});

test('MCP accepts, discovers, reads, and cancels durable direct requests with structured errors', async () => {
  const f = await connectedFixture();
  try {
    const tools = await f.client.listTools();
    assert.deepEqual(tools.tools.map(({ name }) => name).sort(), ['image_get', 'image_import', 'image_scale', 'provider_credential', 'provider_settings', 'run_cancel', 'run_delete', 'run_get', 'run_inspect', 'run_list', 'run_query', 'run_resume', 'run_start', 'run_storage']);
    assert.match(tools.tools.find(({ name }) => name === 'run_resume')?.description ?? '', /partial journey/i);
    const inspected = await f.client.callTool({ name: 'run_inspect', arguments: { request: request() } });
    assert.equal(inspected.isError ?? false, false);
    assert.equal((inspected.structuredContent as { valid: boolean }).valid, true);

    const submissionId = randomUUID();
    const started = await f.client.callTool({ name: 'run_start', arguments: { submissionId, request: request() } });
    const run = started.structuredContent as { runId: string; status: string };
    assert.equal(run.status, 'prepared');
    const repeated = await f.client.callTool({ name: 'run_start', arguments: { submissionId, request: request() } });
    assert.equal((repeated.structuredContent as { runId: string }).runId, run.runId);

    const listing = await f.client.callTool({ name: 'run_list', arguments: { status: 'prepared', limit: 5 } });
    assert.equal((listing.structuredContent as { items: unknown[] }).items.length, 1);
    const storedRequest = await f.client.callTool({ name: 'run_get', arguments: { runId: run.runId, view: 'request' } });
    assert.equal((storedRequest.structuredContent as { request: { material: Array<{ text: string }> } }).request.material[0]?.text, 'A short passage.');
    const answers = await f.client.callTool({ name: 'run_get', arguments: { runId: run.runId, view: 'answers', limit: 1 } });
    const answerPage = answers.structuredContent as { items: Array<{ evaluationId: string; status: string; contextId: string }> };
    assert.equal(answerPage.items[0]?.status, 'pending');
    assert.ok(answerPage.items[0]?.contextId);
    const context = await f.client.callTool({ name: 'run_get', arguments: { runId: run.runId, view: 'context', evaluationId: answerPage.items[0]!.evaluationId, contextId: answerPage.items[0]!.contextId } });
    assert.equal(context.isError ?? false, false);
    const detail = context.structuredContent as { evaluationId: string; contextId: string; respondentId: string; packet: { question: { id: string }; state: { encounteredItems: Array<{ id: string; text: string }> } }; provenance: { contextFingerprint: string }; evaluations?: unknown[] };
    assert.equal(detail.evaluationId, answerPage.items[0]!.evaluationId);
    assert.equal(detail.contextId, answerPage.items[0]!.contextId);
    assert.equal(detail.respondentId, 'reader-a');
    assert.equal(detail.packet.question.id, 'interest');
    assert.deepEqual(detail.packet.state.encounteredItems, [{ id: 'opening', text: 'A short passage.' }]);
    assert.ok(detail.provenance.contextFingerprint);
    assert.equal(detail.evaluations, undefined);
    const mismatchedContext = await f.client.callTool({ name: 'run_get', arguments: { runId: run.runId, view: 'context', evaluationId: answerPage.items[0]!.evaluationId, contextId: randomUUID() } });
    assert.equal(mismatchedContext.isError, true);
    assert.equal((mismatchedContext.structuredContent as { error: { code: string } }).error.code, 'context_not_found');
    const queried = await f.client.callTool({ name: 'run_query', arguments: { sourceRunId: run.runId, criteria: { materialId: 'opening' }, limit: 1 } });
    assert.equal(queried.isError ?? false, false);
    const evidence = queried.structuredContent as { items: unknown[]; totalMatches: number; sourceStatus: string; sourceComplete: boolean };
    assert.equal(evidence.totalMatches, 1);
    assert.equal(evidence.sourceStatus, 'prepared');
    assert.equal(evidence.sourceComplete, false);
    const cancelled = await f.client.callTool({ name: 'run_cancel', arguments: { runId: run.runId } });
    assert.equal((cancelled.structuredContent as { status: string }).status, 'cancelled');

    const unknown = await f.client.callTool({ name: 'run_get', arguments: { runId: randomUUID(), view: 'status' } });
    assert.equal(unknown.isError, true);
    assert.equal((unknown.structuredContent as { error: { code: string } }).error.code, 'run_not_found');
    const extra = await f.client.callTool({ name: 'run_get', arguments: { runId: run.runId, view: 'status', cursor: 'ignored' } });
    assert.equal(extra.isError, true);
  } finally { await f.close(); }
});

test('MCP inspects and accepts an inline journey, then exposes its initial durable turn handles', async () => {
  const f = await connectedFixture();
  try {
    const request = journeyRequest();
    const inspected = await f.client.callTool({ name: 'run_inspect', arguments: { request } });
    assert.equal(inspected.isError ?? false, false);
    assert.equal((inspected.structuredContent as { valid: boolean }).valid, true);

    const submissionId = randomUUID();
    const started = await f.client.callTool({ name: 'run_start', arguments: { submissionId, request } });
    assert.equal(started.isError ?? false, false);
    const run = started.structuredContent as { runId: string; status: string };
    assert.equal(run.status, 'prepared');

    const frozen = await f.client.callTool({ name: 'run_get', arguments: { runId: run.runId, view: 'request' } });
    assert.equal((frozen.structuredContent as { request: { kind: string } }).request.kind, 'journey');

    const details = await f.client.callTool({ name: 'run_get', arguments: { runId: run.runId, view: 'journey' } });
    assert.equal(details.isError ?? false, false);
    const data = details.structuredContent as { request: { kind: string }; respondents: Array<{ status: string; currentTurnId: string | null; currentContextId: string | null; events: unknown[] }>; evaluations: Array<{ status: string; turnId: string; contextId: string; nodeId: string }> };
    assert.equal(data.request.kind, 'journey');
    assert.equal(data.respondents.length, 1);
    assert.ok(data.respondents.every((respondent) => respondent.status === 'active' && respondent.currentTurnId && respondent.currentContextId));
    assert.equal(data.evaluations.length, 1);
    assert.ok(data.evaluations.every((evaluation) => evaluation.status === 'pending' && evaluation.turnId && evaluation.contextId && evaluation.nodeId === 'sequence-ask-interest'));
    const retry = await f.client.callTool({ name: 'run_start', arguments: { submissionId, request } });
    assert.equal((retry.structuredContent as { runId: string }).runId, run.runId);
    assert.equal(retry.isError ?? false, false);
    assert.equal(f.store.list({}).items.length, 1);
  } finally { await f.close(); }
});

test('MCP reports eligible respondent-local journey recovery and resumes only on run_resume', async () => {
  const f = await connectedFixture();
  try {
    const started = await f.client.callTool({ name: 'run_start', arguments: { submissionId: randomUUID(), request: journeyRequest() } });
    const runId = (started.structuredContent as { runId: string }).runId;
    const claim = f.store.claim(runId, Date.now(), 1234);
    assert.ok(claim);
    const reservation = f.store.reserveNext(claim, Date.now());
    assert.ok(reservation);
    const journey = f.store.getJourneyRun(runId);
    const failedTurn = journey.evaluations[0]!.turnId;
    const respondent = journey.respondents[0]!;
    f.store.settleJourney(claim, reservation.attemptId, { kind: 'failed', code: 'decision_failed', message: 'The answer did not validate.', scope: 'evaluation' }, {
      respondentId: respondent.respondentId,
      expectedRevision: respondent.revision,
      state: { ...respondent, status: 'failed', currentNodeId: null, currentTurnId: null, currentContextId: null, revision: respondent.revision + 1 },
    });
    assert.equal(f.store.finish(claim).status, 'partial');

    const before = await f.client.callTool({ name: 'run_get', arguments: { runId, view: 'status' } });
    const beforeData = before.structuredContent as { status: string; lifecycle: { resume: { eligible: boolean } } };
    assert.equal(beforeData.status, 'partial');
    assert.deepEqual(beforeData.lifecycle.resume, { eligible: true });
    assert.equal(f.store.getJourneyRun(runId).respondents[0]?.status, 'failed');

    const resumed = await f.client.callTool({ name: 'run_resume', arguments: { runId } });
    const resumedData = resumed.structuredContent as { runId: string; status: string };
    assert.equal(resumedData.runId, runId);
    assert.equal(resumedData.status, 'prepared');
    const after = f.store.getJourneyRun(runId);
    assert.equal(after.respondents[0]?.status, 'active');
    assert.equal(after.respondents[0]?.currentTurnId, failedTurn);
    assert.equal(after.evaluations[0]?.status, 'pending');
    assert.deepEqual(f.store.attempts(runId).items.map(({ status }) => status), ['failed']);
  } finally {
    await f.close();
  }
});

test('MCP controlled recovery resumes the saved journey before the next workflow turn reads it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-mcp-controlled-resume-'));
  const seeded = await seedWorkflowState({ kind: 'partial-journey-recovery', version: 1 }, root);
  const store = openRunStore(root);
  const provider = createControlledRecoveryProvider({ kind: 'jev', route: 'typesafe', model: 'jev-latest' });
  const service = createRunService(store, root, () => provider, {
    async launch(_dataRoot, runId) { await executeQuestionRun(splitRunStore(store), runId, () => provider); },
  }, { assertProviderReady: async () => undefined });
  const server = createPollingServer(service);
  const client = new Client({ name: 'sheg-controlled-recovery-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const before = await client.callTool({ name: 'run_get', arguments: { runId: seeded.runId, view: 'status' } });
    assert.equal((before.structuredContent as { status: string }).status, 'partial');
    const resumed = await client.callTool({ name: 'run_resume', arguments: { runId: seeded.runId } });
    const status = resumed.structuredContent as { runId: string; status: string; usedCalls: number; maxCalls: number };
    assert.equal(status.runId, seeded.runId);
    assert.equal(status.status, 'completed');
    assert.equal(status.usedCalls, 4);
    assert.equal(status.maxCalls, 8);
    const journey = await client.callTool({ name: 'run_get', arguments: { runId: seeded.runId, view: 'journey' } });
    const data = journey.structuredContent as { respondents: Array<{ respondentId: string; status: string; route: Array<{ nodeId: string; toNodeId: string }> }> ; evaluations: Array<{ respondentId: string; questionId: string; status: string }> };
    assert.deepEqual(data.respondents.map(({ respondentId, status }) => [respondentId, status]), [['reader-a', 'completed'], ['reader-b', 'completed']]);
    assert.deepEqual(data.respondents.find(({ respondentId }) => respondentId === 'reader-b')?.route.map(({ nodeId, toNodeId }) => [nodeId, toNodeId]), [['ask-interest', 'evidence-node'], ['ask-clarity', 'clear']]);
    assert.deepEqual(store.attempts(seeded.runId).items.map(({ status }) => status), ['answered', 'answered', 'failed', 'answered']);
    assert.equal(data.evaluations.filter(({ respondentId, questionId }) => respondentId === 'reader-a' && questionId === 'interest').length, 1);
  } finally {
    await client.close();
    await server.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP queries typed evidence and starts a context-preserving follow-on', async () => {
  const f = await connectedFixture();
  try {
    const sourceRequest = { ...request(), material: [{ id: 'candidate-leave', text: 'The exact section that lost interest.', sourceId: 'article-section-3', sourceSha256: 'a'.repeat(64) }], questions: [{ type: 'choice' as const, id: 'interest', instructions: 'Which section lost your interest?', options: { candidate: 'The exact section that lost interest.', no_fit: 'No section' }, materialOptions: { candidate: 'candidate-leave' } }] };
    const started = await f.client.callTool({ name: 'run_start', arguments: { submissionId: randomUUID(), request: sourceRequest } });
    const sourceRunId = (started.structuredContent as { runId: string }).runId;
    const claim = f.store.claim(sourceRunId, Date.now(), 1234);
    assert.ok(claim);
    const attempt = f.store.reserveNext(claim, Date.now());
    assert.ok(attempt);
    f.store.settle(claim, attempt.attemptId, { kind: 'answered', result: {
      type: 'choice', choice: 'candidate', probabilities: { candidate: 0.85, no_fit: 0.15 }, confidence: 0.85,
      attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {},
    } });
    f.store.finish(claim);
    const queried = await f.client.callTool({ name: 'run_query', arguments: { sourceRunId, criteria: { answer: { type: 'choice', choiceId: 'candidate' } } } });
    assert.equal(queried.isError ?? false, false);
    const evidence = queried.structuredContent as { items: Array<{ evaluationId: string; contextId: string; selectedMaterial?: { materialId: string; text: string; sourceId: string; sourceSha256: string; textSha256: string } }>; sourceComplete: boolean };
    assert.equal(evidence.items.length, 1);
    assert.equal(evidence.sourceComplete, true);
    assert.deepEqual(evidence.items[0]?.selectedMaterial, { materialId: 'candidate-leave', text: 'The exact section that lost interest.', sourceId: 'article-section-3', sourceSha256: 'a'.repeat(64), textSha256: 'e57345e163461c497cd65d51f8a09f40f01329bfb31a181276f2fb1f3e408060' });
    const followOn = {
      kind: 'follow-on', sourceRunId, selection: { references: [{ evaluationId: evidence.items[0]!.evaluationId, contextId: evidence.items[0]!.contextId }] },
      context: { mode: 'continue', materialIds: [evidence.items[0]!.selectedMaterial!.materialId] }, questions: [{ type: 'noul', id: 'why-left', instructions: 'Did the selected section cause you to leave?' }],
      provider: request().provider, maxCalls: 1,
    };
    const inspected = await f.client.callTool({ name: 'run_inspect', arguments: { request: followOn } });
    assert.equal((inspected.structuredContent as { valid: boolean }).valid, true);
    const accepted = await f.client.callTool({ name: 'run_start', arguments: { submissionId: randomUUID(), request: followOn } });
    assert.equal(accepted.isError ?? false, false);
    const followOnRunId = (accepted.structuredContent as { runId: string }).runId;
    const saved = await f.client.callTool({ name: 'run_get', arguments: { runId: followOnRunId, view: 'request' } });
    const data = saved.structuredContent as { request: { kind: string; context: { materialIds?: string[] } }; lineage: { sourceRunId: string; selections: Array<{ sourceContextId: string }> } };
    assert.equal(data.request.kind, 'follow-on');
    assert.deepEqual(data.request.context.materialIds, ['candidate-leave']);
    assert.equal(data.lineage.sourceRunId, sourceRunId);
    assert.equal(data.lineage.selections.length, 1);
    assert.equal(data.lineage.selections[0]?.sourceContextId, evidence.items[0]?.contextId);
  } finally { await f.close(); }
});

test('MCP exposes mixed independent question groups and lets an agent continue from one explicitly selected answer', async () => {
  const f = await connectedFixture();
  try {
    const sourceRequest = { ...request(), maxCalls: 1, questions: [request().questions[0]!,
      { type: 'score' as const, id: 'clarity', instructions: 'How clear was the passage?', rubric: ['Unclear', 'Mixed', 'Clear'] },
      { type: 'noul' as const, id: 'interest-loss', instructions: 'Did anything make you lose interest?' }] };
    const inspected = await f.client.callTool({ name: 'run_inspect', arguments: { request: sourceRequest } });
    assert.equal((inspected.structuredContent as { valid: boolean }).valid, true);
    const inspection = inspected.structuredContent as { minimumCalls: number; fits: Array<{ groupId?: string; contextId?: string; questionIds?: string[] }> };
    assert.equal(inspection.minimumCalls, 1);
    assert.deepEqual(inspection.fits[0]?.questionIds, ['interest', 'clarity', 'interest-loss']);
    const started = await f.client.callTool({ name: 'run_start', arguments: { submissionId: randomUUID(), request: sourceRequest } });
    const sourceRunId = (started.structuredContent as { runId: string }).runId;
    const prepared = f.store.getRequest(sourceRunId); const group = prepared.groups![0]!;
    const claim = f.store.claim(sourceRunId, Date.now(), 1234); assert.ok(claim);
    const reservation = f.store.reserveBatch(claim, group.groupId, prepared.evaluations.map(({ evaluationId }) => evaluationId), Date.now()); assert.ok(reservation);
    f.store.settleBatch(claim, reservation.attemptId, { kind: 'answered', result: {
      execution: { attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {} }, answers: [
        { questionId: 'interest', value: { type: 'choice', choice: 'leave', probabilities: { continue: 0.1, leave: 0.9 } } },
        { questionId: 'clarity', value: { type: 'score', score: 1, legend: { 0: 'Unclear', 1: 'Mixed', 2: 'Clear' }, probabilities: { 0: 0.1, 1: 0.8, 2: 0.1 } } },
        { questionId: 'interest-loss', value: { type: 'noul', noul: 0.7 } },
      ],
    } });
    f.store.finish(claim);
    const interest = await f.client.callTool({ name: 'run_query', arguments: { sourceRunId, criteria: { questionId: 'interest' } } });
    const loss = await f.client.callTool({ name: 'run_query', arguments: { sourceRunId, criteria: { questionId: 'interest-loss' } } });
    const interestItem = (interest.structuredContent as { items: Array<{ evaluationId: string; contextId: string }> }).items[0]!;
    const lossItem = (loss.structuredContent as { items: Array<{ evaluationId: string; contextId: string; execution?: { provider: string } }> }).items[0]!;
    assert.notEqual(interestItem.evaluationId, lossItem.evaluationId);
    assert.equal(interestItem.contextId, lossItem.contextId);
    assert.equal(lossItem.execution?.provider, 'jev');

    const followOn = { kind: 'follow-on' as const, sourceRunId,
      selection: { references: [{ evaluationId: lossItem.evaluationId, contextId: lossItem.contextId }] },
      context: { mode: 'continue' as const }, questions: [{ type: 'choice' as const, id: 'continue-reading', instructions: 'Would you continue?', options: { yes: 'Yes', no: 'No' } }],
      provider: sourceRequest.provider, maxCalls: 1 };
    const accepted = await f.client.callTool({ name: 'run_start', arguments: { submissionId: randomUUID(), request: followOn } });
    const followRunId = (accepted.structuredContent as { runId: string }).runId;
    const followRequest = f.store.getRequest(followRunId) as unknown as { evaluations: Array<{ contextId: string; packet: { state: { trajectory: { responses: Array<{ taskId?: string; type?: string }> } } } }> };
    const responses = followRequest.evaluations[0]!.packet.state.trajectory.responses;
    assert.equal(responses.length, 1);
    assert.equal(responses[0]?.taskId, 'interest-loss');
    assert.equal(responses[0]?.type, 'noul');
    assert.notEqual(followRequest.evaluations[0]!.contextId, lossItem.contextId);
  } finally { await f.close(); }
});

test('run_storage exposes a path-free health report and explicit optimization', async () => {
  const f = await connectedFixture();
  try {
    const inspection = await f.client.callTool({ name: 'run_storage', arguments: { operation: 'inspect' } });
    assert.equal(inspection.isError ?? false, false);
    const info = inspection.structuredContent as { integrity: string; databaseBytes: number; runCount: number; evaluationCount: number; attemptCount: number; activeRunCount: number };
    assert.equal(info.integrity, 'ok');
    assert.ok(info.databaseBytes > 0);
    assert.deepEqual([info.runCount, info.evaluationCount, info.attemptCount, info.activeRunCount], [0, 0, 0, 0]);
    assert.doesNotMatch(JSON.stringify(info), /runs\.sqlite|[A-Z]:\\|SELECT|PRAGMA/i);
    const optimized = await f.client.callTool({ name: 'run_storage', arguments: { operation: 'optimize' } });
    assert.deepEqual(optimized.structuredContent, { optimized: true });
    const invalid = await f.client.callTool({ name: 'run_storage', arguments: { operation: 'vacuum' } });
    assert.equal(invalid.isError, true);
  } finally { await f.close(); }
});

test('run_delete previews active blockers and deletes only after explicit cancellation', async () => {
  const f = await connectedFixture();
  try {
    const started = await f.client.callTool({ name: 'run_start', arguments: { submissionId: randomUUID(), request: request() } });
    const runId = (started.structuredContent as { runId: string }).runId;
    const preview = await f.client.callTool({ name: 'run_delete', arguments: { runIds: [runId], dryRun: true } });
    const previewData = preview.structuredContent as { blockedByActiveWork: boolean; runs: Array<{ runId: string; status: string }> };
    assert.equal(previewData.blockedByActiveWork, true);
    assert.equal(previewData.runs[0]?.status, 'prepared');
    assert.equal(f.store.getStatus(runId).status, 'prepared');
    await f.client.callTool({ name: 'run_cancel', arguments: { runId } });
    const deleted = await f.client.callTool({ name: 'run_delete', arguments: { runIds: [runId] } });
    assert.equal(deleted.isError ?? false, false);
    assert.deepEqual((deleted.structuredContent as { deletedRunIds: string[] }).deletedRunIds, [runId]);
    const missing = await f.client.callTool({ name: 'run_get', arguments: { runId, view: 'status' } });
    assert.equal(missing.isError, true);
  } finally { await f.close(); }
});

test('MCP exposes explicit run_resume with a strict run identity input', async () => {
  const f = await connectedFixture();
  try {
    const started = await f.client.callTool({ name: 'run_start', arguments: { submissionId: randomUUID(), request: request() } });
    const runId = (started.structuredContent as { runId: string }).runId;
    const now = Date.now();
    assert.ok(f.store.claim(runId, now, 1234));
    f.store.reconcile(runId, now + 31_000);
    const resumed = await f.client.callTool({ name: 'run_resume', arguments: { runId } });
    assert.equal(resumed.isError ?? false, false);
    assert.equal((resumed.structuredContent as { runId: string }).runId, runId);
    const invalid = await f.client.callTool({ name: 'run_resume', arguments: { runId, maxCalls: 100 } });
    assert.equal(invalid.isError, true);
  } finally { await f.close(); }
});

test('MCP exposes uncertain physical attempts with their linked evaluation IDs', async () => {
  const f = await connectedFixture();
  try {
    const started = await f.client.callTool({ name: 'run_start', arguments: { submissionId: randomUUID(), request: request() } });
    const runId = (started.structuredContent as { runId: string }).runId;
    const now = Date.now();
    const claim = f.store.claim(runId, now, 4567);
    assert.ok(claim);
    const prepared = f.store.getRequest(runId);
    const reservation = f.store.reserveBatch(claim, prepared.groups![0]!.groupId, [prepared.evaluations[0]!.evaluationId], now);
    assert.ok(reservation);
    f.store.reconcile(runId, now + 31_000);

    const result = await f.client.callTool({ name: 'run_get', arguments: { runId, view: 'attempts', limit: 1 } });
    assert.equal(result.isError ?? false, false);
    const page = result.structuredContent as { items: Array<{ attemptId: string; evaluationIds: string[]; status: string; failure: { code: string } }> };
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.attemptId, reservation.attemptId);
    assert.deepEqual(page.items[0]?.evaluationIds, [prepared.evaluations[0]!.evaluationId]);
    assert.equal(page.items[0]?.status, 'uncertain');
    assert.equal(page.items[0]?.failure.code, 'worker_interrupted');
  } finally { await f.close(); }
});

test('MCP explains an unsupported stored credential encoding without accepting the run', async () => {
  const f = await connectedFixture(async () => { throw new CredentialStoreError('credential_malformed', 'openrouter'); });
  try {
    const result = await f.client.callTool({ name: 'run_start', arguments: { submissionId: randomUUID(), request: request() } });
    assert.equal(result.isError, true);
    const error = (result.structuredContent as { error: { code: string; message: string } }).error;
    assert.equal(error.code, 'provider_credential_malformed');
    assert.match(error.message, /OpenRouter secure credential is present but uses an unsupported encoding/i);
    assert.match(error.message, /UTF-8 or UTF-16LE/);
    assert.equal(f.store.list({}).items.length, 0);
  } finally { await f.close(); }
});
