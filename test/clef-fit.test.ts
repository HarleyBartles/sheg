import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { DecisionBatchRequest } from '../src/domain/decision/decision.js';
import { measureClefBatchFit } from '../src/providers/clef/fit.js';
import type { ClefImageResolver } from '../src/providers/clef/config.js';

const bytes = await readFile(new URL('./fixtures/images/four-corners-transparent.png', import.meta.url));
const sha256 = createHash('sha256').update(bytes).digest('hex');
const image = { id: 'hero', altText: 'A teal robot.', asset: { assetId: `sha256:${sha256}`, sha256, format: 'png' as const, width: 80, height: 40, bytes: bytes.byteLength } };
const resolver: ClefImageResolver = { resolve() { return { metadata: image.asset, bytes }; } };
const config = { kind: 'clef' as const, accountId: '3327878972ea82e6b454069bba62f3d9', model: 'clef' as const, timeoutMs: 1000 };
const question = { type: 'choice' as const, id: 'read', instructions: 'Continue?', options: { yes: 'Yes', no: 'No' }, visual: { mode: 'pixels' as const, materialIds: ['hero'] } };
const request: DecisionBatchRequest = { state: { article: 'A short story.' }, questions: [question], visualMaterials: [image] } as DecisionBatchRequest;

test('Clef fit distinguishes text estimate, image allowance, and exact final body size', () => {
  const fit = measureClefBatchFit(request, config, resolver);
  assert.equal(fit.status, 'fits');
  assert.equal(fit.provider, 'clef');
  assert.equal(fit.tokenCount, 'estimated');
  assert.equal(fit.details.imageCount, 1);
  assert.equal(fit.details.imageTokenAllowance, 1027);
  assert.equal(fit.details.serializedBodyBytes, fit.details.finalJsonBodyBytes);
  assert.equal(fit.details.altTextInPixelProjection, 0);
});

test('Clef fit refuses an over-budget text projection before transport', () => {
  const oversized: DecisionBatchRequest = { state: { article: 'x'.repeat(160_000) }, questions: [question], visualMaterials: [image] } as DecisionBatchRequest;
  const fit = measureClefBatchFit(oversized, config, resolver);
  assert.equal(fit.status, 'overflow');
  assert.equal(fit.reason, 'estimated-context-over-limit');
  assert.equal(fit.details.effectiveLimitTokens, 51_200);
});

test('Clef fit refuses more than four images and unverified asset bytes', () => {
  const materialIds = ['one', 'two', 'three', 'four', 'five'];
  const tooMany: DecisionBatchRequest = { state: {}, questions: [{ ...question, visual: { mode: 'pixels', materialIds } }], visualMaterials: materialIds.map((id) => ({ ...image, id })) } as DecisionBatchRequest;
  const fit = measureClefBatchFit(tooMany, config, { resolve() { return { metadata: image.asset, bytes }; } });
  assert.equal(fit.status, 'overflow');
  assert.equal(fit.reason, 'image-count-exceeded');
  const missing = measureClefBatchFit(request, config, { resolve() { throw new Error('secret path'); } });
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.reason, 'image-asset-unavailable');
});

test('Clef accepts four ordered image references but rejects a fifth before measuring or dispatch', () => {
  const ids = ['one', 'two', 'three', 'four'];
  const four: DecisionBatchRequest = { state: { materialOrder: ids }, questions: [{ ...question, visual: { mode: 'pixels', materialIds: ids } }], visualMaterials: ids.map((id) => ({ ...image, id })) } as DecisionBatchRequest;
  const fourFit = measureClefBatchFit(four, config, resolver);
  assert.equal(fourFit.status, 'fits');
  assert.equal(fourFit.details.imageCount, 4);
  const fiveIds = [...ids, 'five'];
  const five: DecisionBatchRequest = { state: {}, questions: [{ ...question, visual: { mode: 'pixels', materialIds: fiveIds } }], visualMaterials: fiveIds.map((id) => ({ ...image, id })) } as DecisionBatchRequest;
  const fiveFit = measureClefBatchFit(five, config, resolver);
  assert.equal(fiveFit.status, 'overflow');
  assert.equal(fiveFit.reason, 'image-count-exceeded');
});

test('Clef enforces 64 questions and the conservative text plus media token budget', () => {
  const questions = (count: number) => Array.from({ length: count }, (_, index) => ({ type: 'noul' as const, id: `q-${index}`, instructions: 'True?' }));
  const at64 = measureClefBatchFit({ state: {}, questions: questions(64) }, config);
  assert.equal(at64.status, 'fits');
  const at65 = measureClefBatchFit({ state: {}, questions: questions(65) }, config);
  assert.equal(at65.status, 'overflow');
  assert.equal(at65.reason, 'question-count-exceeded');
  const near = measureClefBatchFit({ state: { article: 'x'.repeat(151_000) }, questions: [questions(1)[0]!] }, config);
  assert.equal(near.status, 'fits');
  const over = measureClefBatchFit({ state: { article: 'x'.repeat(154_000) }, questions: [questions(1)[0]!] }, config);
  assert.equal(over.status, 'overflow');
  assert.equal(over.reason, 'estimated-context-over-limit');
});

test('Clef enforces per-image, aggregate decoded bytes, pixel, and final-body limits', () => {
  const make = (id: string, length: number, width = 80, height = 40) => {
    const data = Buffer.alloc(length, 7);
    const digest = createHash('sha256').update(data).digest('hex');
    return { data, material: { id, altText: `Image ${id}.`, asset: { assetId: `sha256:${digest}`, sha256: digest, format: 'png' as const, width, height, bytes: length } } };
  };
  const fitFor = (entries: ReturnType<typeof make>[]) => {
    const ids = entries.map(({ material }) => material.id);
    const input = { state: { materialOrder: ids }, questions: [{ ...question, visual: { mode: 'pixels' as const, materialIds: ids } }], visualMaterials: entries.map(({ material }) => material) } as DecisionBatchRequest;
    const byAsset = new Map(entries.map(({ data, material }) => [material.asset.assetId, { metadata: material.asset, bytes: data }]));
    return measureClefBatchFit(input, config, { resolve: (assetId) => byAsset.get(assetId)! });
  };
  assert.equal(fitFor([make('exact', 4 * 1024 * 1024)]).status, 'fits');
  const singleOver = fitFor([make('over', 4 * 1024 * 1024 + 1)]);
  assert.equal(singleOver.status, 'overflow');
  assert.equal(singleOver.reason, 'image-size-exceeded');
  const aggregateOver = fitFor([make('a', 3 * 1024 * 1024), make('b', 3 * 1024 * 1024), make('c', 3 * 1024 * 1024)]);
  assert.equal(aggregateOver.status, 'overflow');
  assert.equal(aggregateOver.reason, 'total-image-size-exceeded');
  const sixteenMp = fitFor([make('pixels', 64, 4_000, 4_000)]);
  assert.equal(sixteenMp.status, 'fits');
  const impossibleMetadata = fitFor([make('too-many-pixels', 64, 4_001, 4_000)]);
  assert.equal(impossibleMetadata.status, 'unavailable');
  assert.equal(impossibleMetadata.reason, 'request-projection-unavailable');
});
