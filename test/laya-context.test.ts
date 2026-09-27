import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DecisionRequest } from '../src/domain/decision/decision.js';
import { LayaProvider, measureLayaContext, type LayaConfig } from '../src/providers/laya.js';

const tokenizerJsonPath = fileURLToPath(new URL('./fixtures/laya-tokenizer.json', import.meta.url));
const tokenizerSha256 = createHash('sha256').update(readFileSync(tokenizerJsonPath)).digest('hex');
const config: LayaConfig = {
  kind: 'laya',
  baseUrl: 'http://127.0.0.1:8787',
  checkpoint: 'laya-typed-decisions',
  contextLimit: 1024,
  headLimit: 192,
  tokenizerJsonPath,
  tokenizerSha256,
  timeoutMs: 1_000,
};
const request: DecisionRequest = {
  state: { respondent: { profile: { intent: 'Understand the passage.' } }, encounteredItems: [{ id: 'opening', text: 'A short passage.' }], trajectory: { version: 1, eventCount: 0 } },
  question: { id: 'continue', instructions: 'What should happen?', options: { continue: 'Continue reading', stop: 'Stop reading' } },
  optionIds: ['continue', 'stop'],
};

test('uses the pinned Laya tokenizer and sequence helper with its effective limits', async () => {
  const measurement = await measureLayaContext(request, config);
  assert.equal(measurement.provider, 'laya');
  assert.equal(measurement.status, 'fits');
  assert.equal(measurement.method, 'laya-ts@ec8409e542941bb4bb649d5fec00d4cec96ae024');
  assert.equal(measurement.tokenCount, 'measured');
  assert.equal(measurement.contextLimit, 1024);
  assert.equal(measurement.headroomTokens, 0);
  assert.equal(measurement.effectiveLimit, 1024);
  assert.equal(measurement.modelIdentity, config.checkpoint);
  assert.equal(measurement.details.tokenizerSha256, tokenizerSha256);
  assert.equal(typeof measurement.details.headTokens, 'number');
  assert.equal(typeof measurement.details.stateTokens, 'number');
});

test('reports state, option, and question-head truncation before inference', async () => {
  const longState = await measureLayaContext({ ...request, state: { text: 'x'.repeat(2_000) } }, config);
  assert.equal(longState.status, 'overflow');
  assert.equal(longState.reason, 'state-would-be-truncated');

  const longOptionRequest = {
    ...request,
    question: { ...request.question, options: { continue: 'x'.repeat(60), stop: 'Stop' } },
    optionIds: ['continue', 'stop'],
  };
  const longOption = await measureLayaContext(longOptionRequest, config);
  assert.equal(longOption.status, 'overflow');
  assert.equal(longOption.reason, 'option-would-be-truncated');

  const longInstructions = await measureLayaContext({ ...request, question: { ...request.question, instructions: 'x'.repeat(300) } }, { ...config, headLimit: 32 });
  assert.equal(longInstructions.status, 'overflow');
  assert.equal(longInstructions.reason, 'instructions-or-options-would-be-truncated');
});

test('refuses a tokenizer checksum mismatch and never calls inference for an oversized packet', async () => {
  const mismatch = await measureLayaContext(request, { ...config, tokenizerSha256: '0'.repeat(64) });
  assert.equal(mismatch.status, 'unavailable');
  assert.equal(mismatch.reason, 'tokenizer-checksum-mismatch');

  let calls = 0;
  const provider = new LayaProvider(config, { fetchRequest: async () => { calls += 1; throw new Error('unexpected inference'); } });
  await assert.rejects(provider.decide({ ...request, state: { text: 'x'.repeat(2_000) } }, 1), /state-would-be-truncated/i);
  assert.equal(calls, 0);
});

test('rechecks a cached tokenizer when its file changes', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sheg-laya-tokenizer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'tokenizer.json');
  await copyFile(tokenizerJsonPath, filePath);
  const fileConfig = { ...config, tokenizerJsonPath: filePath };
  assert.equal((await measureLayaContext(request, fileConfig)).status, 'fits');
  await writeFile(filePath, `${await readFile(filePath, 'utf8')} `);
  const changed = await measureLayaContext(request, fileConfig);
  assert.equal(changed.status, 'unavailable');
  assert.equal(changed.reason, 'tokenizer-checksum-mismatch');
});
