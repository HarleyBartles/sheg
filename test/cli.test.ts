import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../src/entrypoints/cli.js';
import { createHash, randomUUID } from 'node:crypto';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createPollingServer } from '../src/entrypoints/mcp.js';
import { createRunServiceForStore as createRunService } from './helpers/run-service.js';
import { openRunStore, splitRunStore } from '../src/infrastructure/run-store.js';
import { executeQuestionRun } from '../src/application/question-worker.js';
import type { InlineRunRequest } from '../src/domain/run/request.js';
import type { StaticImageCodec } from '../src/infrastructure/images/codecs.js';
import { ClefProvider } from '../src/providers/clef.js';
import { openImageAssetRepository } from '../src/infrastructure/sqlite/image-assets.js';
import type { ProviderConfigInput } from '../src/providers/config.js';
import { fileURLToPath } from 'node:url';
import { createStaticImageCodec } from '../src/infrastructure/images/codecs.js';

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
  for (const command of ['inspect', 'preflight', 'trace', 'start', 'list', 'query', 'get', 'cancel', 'resume', 'storage', 'image-import', 'image-scale', 'image-get', 'provider-credential']) assert.match(lines[0] ?? '', new RegExp(command));
});

test('CLI provider credential status, setup and removal share the fixed Clef route without accepting secret or endpoint values', async () => {
  const calls: string[] = [];
  let available: 'available' | 'missing' = 'missing';
  const credentialStore = {
    async availability(route: string) { calls.push(`status:${route}`); return available; },
    async setup(route: string) { calls.push(`setup:${route}`); available = 'available'; },
    async remove(route: string) { calls.push(`remove:${route}`); available = 'missing'; },
  };
  const output: string[] = []; const errors: string[] = [];
  const io = { out: (value: string) => { output.push(value); return true; }, error: (value: string) => { errors.push(value); return true; } };
  const run = (operation: string) => runCli(['provider-credential', '--route', 'clef', '--operation', operation], io, undefined, undefined, credentialStore);
  assert.equal(await run('status'), 0);
  assert.deepEqual(JSON.parse(output.pop()!), { route: 'clef', operation: 'status', availability: 'missing' });
  assert.equal(await run('setup'), 0);
  assert.deepEqual(JSON.parse(output.pop()!), { route: 'clef', operation: 'setup', availability: 'available' });
  assert.equal(await run('remove'), 0);
  assert.deepEqual(JSON.parse(output.pop()!), { route: 'clef', operation: 'remove', availability: 'missing' });
  assert.equal(await runCli(['provider-credential', '--route', 'clef', '--operation', 'status', '--endpoint', 'https://attacker.invalid'], io, undefined, undefined, credentialStore), 1);
  assert.equal(calls.includes('status:clef'), true);
  assert.equal(calls.some((call) => call.includes('attacker.invalid')), false);
  assert.equal(JSON.stringify(output).includes('secret'), false);
  assert.deepEqual(calls, ['status:clef', 'setup:clef', 'status:clef', 'remove:clef', 'status:clef']);
});

test('CLI resolves image paths against the request file and rejects edit controls', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-cli-image-'));
  const store = openRunStore(root);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const requestDirectory = path.join(root, 'requests');
  const imagesDirectory = path.join(root, 'images');
  await Promise.all([mkdir(requestDirectory), mkdir(imagesDirectory)]);
  const sourcePath = path.join(imagesDirectory, 'source.png');
  const sourceBytes = await readFile(new URL('./fixtures/images/four-corners-transparent.png', import.meta.url));
  await copyFile(new URL('./fixtures/images/four-corners-transparent.png', import.meta.url), sourcePath);
  const requestPath = path.join(requestDirectory, 'import.json');
  await writeFile(requestPath, JSON.stringify({ source: { path: '../images/source.png', sha256: createHash('sha256').update(sourceBytes).digest('hex') } }));
  let decodeCalls = 0;
  const codec = {
    async decode() { decodeCalls += 1; return { data: new Uint8ClampedArray(80 * 40 * 4), width: 80, height: 40, format: 'png' as const, orientation: 1 }; },
    async scale() { throw new Error('CLI import must not scale'); },
    async encode() { throw new Error('CLI import must not encode'); },
  } satisfies StaticImageCodec;
  const output: string[] = []; const errors: string[] = [];
  const io = { out: (value: string) => { output.push(value); return true; }, error: (value: string) => { errors.push(value); return true; } };
  const service = {} as never;
  const status = await runCli(['image-import', '--request', requestPath, '--data-root', root], io, service, codec);
  assert.equal(status, 0, errors.join('\n'));
  const result = JSON.parse(output[0] ?? '{}') as { sourcePath: string; asset: { assetId: string; sha256: string } };
  assert.equal(result.sourcePath, sourcePath);
  assert.equal(result.asset.sha256, createHash('sha256').update(sourceBytes).digest('hex'));
  assert.equal(decodeCalls, 1);

  await writeFile(requestPath, JSON.stringify({ source: { assetId: result.asset.assetId }, maxWidth: 20, quality: 70 }));
  assert.equal(await runCli(['image-scale', '--request', requestPath, '--data-root', root], io, service, codec), 1);
  assert.deepEqual(JSON.parse(errors.at(-1) ?? '{}'), { error: 'The image request is invalid.' });
  assert.equal(decodeCalls, 1);
});

test('CLI imports, inspects and accepts a Clef visual poll whose worker uses retained image bytes after source deletion', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-cli-clef-'));
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
  const source = path.join(root, 'source.png');
  const requestPath = path.join(root, 'import.json');
  const runRequestPath = path.join(root, 'visual-run.json');
  const getRequestPath = path.join(root, 'get.json');
  const original = await readFile(new URL('./fixtures/images/four-corners-transparent.png', import.meta.url));
  await copyFile(new URL('./fixtures/images/four-corners-transparent.png', import.meta.url), source);
  const credentials = { async readForAuthentication(route: string) { assert.equal(route, 'clef'); return 'fixture-clef-secret'; } };
  const fetchRequest = (async (url: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(url);
    requestImages = (JSON.parse(String(init?.body)) as { images: string[] }).images;
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
  const output: string[] = []; const errors: string[] = [];
  const io = { out: (value: string) => { output.push(value); return true; }, error: (value: string) => { errors.push(value); return true; } };
  const credentialStore = { async availability() { return 'available' as const; }, async setup() {}, async remove() {} };
  const run = (args: string[]) => runCli(args, io, service, codec, credentialStore);
  t.after(async () => { releaseDispatch(); await workerPromise; imageRepository.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(requestPath, JSON.stringify({ source: { path: 'source.png', sha256: createHash('sha256').update(original).digest('hex') } }));
  assert.equal(await run(['image-import', '--request', requestPath, '--data-root', root]), 0, errors.at(-1));
  const imported = JSON.parse(output.pop() ?? '{}') as { asset: { assetId: string; sha256: string; width: number; height: number; bytes: number; format: 'png' }; sourcePath: string };
  assert.equal(imported.sourcePath, source);
  const request: InlineRunRequest = {
    kind: 'poll', respondents: [{ id: 'reader', intent: 'Read the recommendation', context: 'Curious', desired_outcome: 'Understand the proposal', engagement_cues: 'Examples', friction_cues: 'Distraction' }],
    material: [{ id: 'section-four', text: 'The recommendation follows.' }, { id: 'portrait', type: 'image', text: '', altText: 'A determined specialist in a teal coat checks a ledger.', caption: 'Writ prepares the records.', asset: imported.asset }],
    questions: [{ type: 'choice', id: 'image-fit', instructions: 'Does the image support the recommendation?', options: { yes: 'It supports the section', no: 'It distracts from the section' }, visual: { mode: 'pixels', materialIds: ['portrait'] } }],
    provider: { kind: 'clef', accountId: '3327878972ea82e6b454069bba62f3d9', model: 'clef', timeoutMs: 30_000 }, maxCalls: 1,
  };
  await writeFile(runRequestPath, JSON.stringify(request));
  assert.equal(await run(['inspect', '--request', runRequestPath, '--data-root', root]), 0, errors.at(-1));
  assert.equal((JSON.parse(output.pop() ?? '{}') as { valid: boolean }).valid, true);
  assert.equal(await run(['start', '--request', runRequestPath, '--submission-id', randomUUID(), '--data-root', root]), 0, errors.at(-1));
  const accepted = JSON.parse(output.pop() ?? '{}') as { runId: string };
  await writeFile(getRequestPath, JSON.stringify({ runId: accepted.runId, view: 'request' }));
  assert.equal(await run(['get', '--request', getRequestPath, '--data-root', root]), 0, errors.at(-1));
  const frozen = JSON.parse(output.pop() ?? '{}') as { evaluations: Array<{ packet: { visualMaterials?: Array<{ asset: { assetId: string } }> } }> };
  assert.equal(frozen.evaluations[0]?.packet.visualMaterials?.[0]?.asset.assetId, imported.asset.assetId);
  await dispatched;
  await unlink(source);
  releaseDispatch();
  await workerPromise;
  assert.equal(requestUrl, 'https://api.cloudflare.com/client/v4/accounts/3327878972ea82e6b454069bba62f3d9/ai/run/@cf/cloudflare/clef');
  assert.deepEqual(requestImages, [`data:image/png;base64,${original.toString('base64')}`]);
  await writeFile(getRequestPath, JSON.stringify({ runId: accepted.runId, view: 'answers' }));
  assert.equal(await run(['get', '--request', getRequestPath, '--data-root', root]), 0, errors.at(-1));
  assert.equal((JSON.parse(output.pop() ?? '{}') as { items: Array<{ status: string; execution: { provider: string } }> }).items[0]?.execution.provider, 'clef');
  assert.equal(store.attempts(accepted.runId).items.length, 1);
  assert.equal(JSON.stringify(output).includes('fixture-clef-secret'), false);
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
