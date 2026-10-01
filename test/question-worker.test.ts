import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { DecisionProvider } from '../src/domain/decision/provider.js';
import type { DecisionResult } from '../src/domain/decision/decision.js';
import type { InlineRunRequest } from '../src/domain/run/request.js';
import { prepareRun } from '../src/application/run-inspection.js';
import { executeQuestionRun } from '../src/application/question-worker.js';
import { JevCallError } from '../src/providers/jev.js';
import { LayaCallError } from '../src/providers/laya.js';
import { openRunStore } from '../src/infrastructure/run-store.js';

function request(respondents = 2): InlineRunRequest {
  return {
    kind: 'poll',
    respondents: Array.from({ length: respondents }, (_, index) => ({ id: `reader-${index + 1}`, intent: 'Learn', context: 'New buyer', desired_outcome: 'Choose', engagement_cues: 'Examples', friction_cues: 'Hype' })),
    material: [{ id: 'section-three', text: 'Section three' }],
    questions: [{ type: 'choice', id: 'interest', instructions: 'Would you continue?', options: { continue: 'Continue', leave: 'Leave' } }],
    provider: { kind: 'jev', route: 'openrouter', model: 'typesafe/jev-1.13' },
    maxCalls: respondents,
  };
}

function answer(): DecisionResult {
  return { type: 'choice', choice: 'continue', probabilities: { continue: 0.9, leave: 0.1 }, attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {} };
}

async function fixture(input = request()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-question-worker-'));
  const store = openRunStore(root);
  const prepared = await prepareRun(input, { measure: () => ({ provider: 'jev', status: 'fits', method: 'test', modelIdentity: 'typesafe/jev-1.13', tokenCount: 'estimated', tokens: 20, contextLimit: 1000, headroomTokens: 100, effectiveLimit: 900, details: {} }), async decide() { return answer(); } });
  assert.ok(prepared.prepared);
  const accepted = store.accept(randomUUID(), prepared.prepared);
  return { root, store, runId: accepted.run.runId, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

function factory(provider: DecisionProvider) { return () => provider; }

test('cancellation during an in-flight answer preserves it and stops the next respondent', async () => {
  const f = await fixture();
  let calls = 0;
  let attemptLimit = 0;
  try {
    const provider: DecisionProvider = {
      async decide(_request, maxAttempts) { calls += 1; attemptLimit = maxAttempts; f.store.requestCancel(f.runId); return answer(); },
    };
    await executeQuestionRun(f.store, f.runId, factory(provider));
    const status = f.store.getStatus(f.runId);
    const answers = f.store.answers(f.runId).items;
    assert.equal(status.status, 'cancelled');
    assert.equal(calls, 1);
    assert.equal(attemptLimit, 1);
    assert.equal(answers[0]?.status, 'answered');
    assert.equal(answers[1]?.status, 'pending');
    assert.equal(status.usedCalls, 1);
  } finally { await f.close(); }
});

test('a malformed answer fails only its respondent and the worker continues', async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const provider: DecisionProvider = {
      async decide() {
        calls += 1;
        if (calls === 1) return { ...answer(), choice: 'not-an-option' };
        return answer();
      },
    };
    await executeQuestionRun(f.store, f.runId, factory(provider));
    const status = f.store.getStatus(f.runId);
    assert.equal(status.status, 'partial');
    assert.equal(calls, 2);
    assert.deepEqual(f.store.answers(f.runId).items.map((item) => item.status), ['failed', 'answered']);
    assert.equal(status.usedCalls, 2);
  } finally { await f.close(); }
});

test('provider authentication failure ends the run without dispatching sibling respondents', async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const provider: DecisionProvider = {
      async decide() { calls += 1; throw new JevCallError('secret detail', 0, undefined, undefined, 'run'); },
    };
    await executeQuestionRun(f.store, f.runId, factory(provider));
    const status = f.store.getStatus(f.runId);
    assert.equal(status.status, 'failed');
    assert.equal(calls, 1);
    assert.equal(f.store.answers(f.runId).items[1]?.status, 'pending');
    assert.equal(status.failure?.message.includes('secret detail'), false);
  } finally { await f.close(); }
});

test('a run-wide Laya authorization failure stops before the next respondent', async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const provider: DecisionProvider = {
      async decide() { calls += 1; throw new LayaCallError('Laya local service returned HTTP 401.', 1, undefined, undefined, 'run'); },
    };
    await executeQuestionRun(f.store, f.runId, factory(provider));
    const status = f.store.getStatus(f.runId);
    assert.equal(status.status, 'failed');
    assert.equal(calls, 1);
    assert.equal(f.store.answers(f.runId).items[0]?.failure?.code, 'provider_unavailable');
    assert.equal(f.store.answers(f.runId).items[1]?.status, 'pending');
  } finally { await f.close(); }
});

test('an unclassified provider exception is charged as an uncertain failed evaluation', async () => {
  const f = await fixture({ ...request(1), maxCalls: 1 });
  let attemptLimit = 0;
  try {
    const provider: DecisionProvider = { async decide(_request, maxAttempts) { attemptLimit = maxAttempts; throw new Error('transport dropped after dispatch'); } };
    await executeQuestionRun(f.store, f.runId, factory(provider));
    const status = f.store.getStatus(f.runId);
    assert.equal(status.status, 'partial');
    assert.equal(status.usedCalls, 1);
    assert.equal(status.reservedCalls, 0);
    assert.equal(attemptLimit, 1);
    assert.equal(f.store.answers(f.runId).items[0]?.status, 'failed');
  } finally { await f.close(); }
});

test('a duplicate worker cannot execute the same run while the owner is active', async () => {
  const f = await fixture({ ...request(1), maxCalls: 1 });
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  try {
    const provider: DecisionProvider = {
      async decide() { started?.(); await new Promise<void>((resolve) => { release = resolve; }); return answer(); },
    };
    const owner = executeQuestionRun(f.store, f.runId, factory(provider));
    await entered;
    await executeQuestionRun(f.store, f.runId, factory({ async decide() { throw new Error('duplicate worker called provider'); } }));
    release?.();
    await owner;
    assert.equal(f.store.getStatus(f.runId).status, 'completed');
  } finally { release?.(); await f.close(); }
});
