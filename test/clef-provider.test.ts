import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { DecisionBatchRequest, DecisionRequest } from '../src/domain/decision/decision.js';
import { ClefProvider } from '../src/providers/clef.js';
import type { ClefImageResolver } from '../src/providers/clef/config.js';

const imageBytes = await readFile(new URL('./fixtures/images/four-corners-transparent.png', import.meta.url));
const sha256 = createHash('sha256').update(imageBytes).digest('hex');
const image = {
  id: 'patch', altText: 'A friendly teal robot with a black crossbody bag.', caption: 'Patch organizes the records.',
  asset: { assetId: `sha256:${sha256}`, sha256, format: 'png' as const, width: 80, height: 40, bytes: imageBytes.byteLength },
};
const imageResolver: ClefImageResolver = { resolve(assetId) { assert.equal(assetId, image.asset.assetId); return { metadata: image.asset, bytes: imageBytes }; } };
const credentials = { async readForAuthentication(route: string) { assert.equal(route, 'clef'); return 'fixture-native-token'; } };
const config = { kind: 'clef' as const, accountId: '3327878972ea82e6b454069bba62f3d9', model: 'clef' as const, timeoutMs: 5_000 };

function choiceRequest(): DecisionRequest & { visualMaterials: typeof image[] } {
  return {
    state: { respondent: { profile: { intent: 'read a story' } }, encounteredItems: [{ id: 'section-1', text: 'Patch entered the archive.' }], materialOrder: ['section-1', 'patch', 'section-2'] },
    question: { type: 'choice', id: 'continue', instructions: 'Would you keep reading?', options: { yes: 'Continue', no: 'Stop' }, visual: { mode: 'pixels', materialIds: ['patch'] } },
    optionIds: ['yes', 'no'], visualMaterials: [image],
  } as DecisionRequest & { visualMaterials: typeof image[] };
}

test('native Clef compiles the fixed REST route, image order, typed questions, and per-question visual references', async () => {
  let observedUrl = '';
  let observedInit: RequestInit | undefined;
  const provider = new ClefProvider(config, (async (url, init) => {
    observedUrl = String(url); observedInit = init;
    return Response.json({ success: true, result: { model: 'clef', answers: { continue: { type: 'choice', choice: 'yes', probabilities: { yes: 0.8, no: 0.2 } } }, usage: { input_tokens: 200, output_tokens: 0 } }, errors: [], messages: [] });
  }) as typeof fetch, { credentialStore: credentials, imageResolver });
  const result = await provider.decide(choiceRequest(), 1);
  assert.equal(observedUrl, 'https://api.cloudflare.com/client/v4/accounts/3327878972ea82e6b454069bba62f3d9/ai/run/@cf/cloudflare/clef');
  assert.equal(observedInit?.method, 'POST');
  assert.equal(observedInit?.redirect, 'error');
  assert.deepEqual(observedInit?.headers, { Authorization: 'Bearer fixture-native-token', 'Content-Type': 'application/json' });
  const body = JSON.parse(String(observedInit?.body)) as { images: string[]; state: { visualMaterials: Array<Record<string, unknown>> }; questions: Record<string, { instructions: string }> };
  assert.equal(body.images[0], `data:image/png;base64,${imageBytes.toString('base64')}`);
  assert.equal(body.state.visualMaterials[0]?.imageIndex, 0);
  assert.equal(body.state.visualMaterials[0]?.altText, undefined);
  assert.equal(body.state.visualMaterials[0]?.caption, image.caption);
  assert.match(body.questions.continue!.instructions, /image index 0/i);
  assert.equal(JSON.stringify(body).includes('fixture-native-token'), false);
  assert.equal(result.type, 'choice');
  assert.equal(result.provider, 'clef');
  assert.equal(result.model, 'clef');
  assert.equal(result.usage.inputTokens, 200);
});

test('Clef names the image index represented by each visual choice option', async () => {
  let body: Record<string, unknown> | undefined;
  const second = { ...image, id: 'reference' };
  const request: DecisionBatchRequest = {
    state: { materialOrder: ['patch', 'reference'] }, visualMaterials: [image, second], questions: [{
      type: 'choice', id: 'match', instructions: 'Which portrait best matches the brief?',
      options: { patch: 'Portrait A', reference: 'Portrait B' }, materialOptions: { patch: 'patch', reference: 'reference' },
      visual: { mode: 'pixels', materialIds: ['patch', 'reference'] },
    }],
  };
  const resolver: ClefImageResolver = { resolve() { return { metadata: image.asset, bytes: imageBytes }; } };
  const provider = new ClefProvider(config, (async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ success: true, result: { model: 'clef', answers: { match: { type: 'choice', choice: 'patch', probabilities: { patch: 0.8, reference: 0.2 } } }, usage: { input_tokens: 20 } } });
  }) as typeof fetch, { credentialStore: credentials, imageResolver: resolver });
  await provider.decideBatch(request, 1);
  const wireQuestions = body?.questions as Record<string, { instructions: string }>;
  assert.match(wireQuestions.match!.instructions, /option .*patch.*image index 0/i);
  assert.match(wireQuestions.match!.instructions, /option .*reference.*image index 1/i);
});

test('one malformed Clef answer remains local to that question while a valid sibling survives', async () => {
  const batch: DecisionBatchRequest = {
    state: {}, questions: [
      { type: 'choice', id: 'good', instructions: 'Pick one.', options: { a: 'A', b: 'B' } },
      { type: 'noul', id: 'bad', instructions: 'True?' },
    ],
  };
  const provider = new ClefProvider(config, (async () => Response.json({ success: true, result: {
    model: 'clef', answers: { good: { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 } }, bad: { type: 'noul', noul: 'not-a-number' } }, usage: { input_tokens: 12 },
  }, errors: [], messages: [] })) as typeof fetch, { credentialStore: credentials });
  const result = await provider.decideBatch(batch, 1);
  assert.equal(result.answers[0] && 'value' in result.answers[0] ? result.answers[0].value.type : undefined, 'choice');
  assert.equal(result.answers[1] && 'failure' in result.answers[1] ? result.answers[1].failure.code : undefined, 'invalid_answer');
  assert.equal(result.execution.attempts, 1);
});

test('Clef refuses a wrong served model at execution scope', async () => {
  const provider = new ClefProvider(config, (async () => Response.json({ success: true, result: {
    model: 'other-model', answers: { unknown: { type: 'noul', noul: 0.4 } }, usage: { input_tokens: 12 },
  }, errors: [], messages: [] })) as typeof fetch, { credentialStore: credentials, imageResolver });
  await assert.rejects(provider.decide(choiceRequest(), 1), (error: unknown) => {
    assert.equal((error as { failureScope?: string }).failureScope, 'run');
    assert.equal((error as { attempts?: number }).attempts, 1);
    assert.doesNotMatch((error as Error).message, /fixture-native-token/);
    return true;
  });
});

test('Clef refuses an unknown answer ID at execution scope', async () => {
  const provider = new ClefProvider(config, (async () => Response.json({ success: true, result: {
    model: 'clef', answers: { unexpected: { type: 'noul', noul: 0.4 } }, usage: { input_tokens: 12 },
  }, errors: [], messages: [] })) as typeof fetch, { credentialStore: credentials });
  await assert.rejects(provider.decideBatch({ state: {}, questions: [{ type: 'noul', id: 'expected', instructions: 'True?' }] }, 1), (error: unknown) => {
    assert.equal((error as { failureScope?: string }).failureScope, 'run');
    assert.match((error as Error).message, /unknown question ID/);
    return true;
  });
});
