import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { DecisionProvider, ProviderContextFit } from '../src/domain/decision/provider.js';
import type { InlineRunRequest } from '../src/domain/run/request.js';
import { prepareRun } from '../src/application/run-inspection.js';
import { openRunStore } from '../src/infrastructure/run-store.js';
import { CredentialStoreError } from '../src/infrastructure/credentials/windows.js';
import { createRunService, RunServiceError } from '../src/application/run-service.js';

function request(text = 'Section three') : InlineRunRequest {
  return {
    kind: 'poll',
    respondents: [{ id: 'reader-a', intent: 'Learn a process', context: 'New buyer', desired_outcome: 'Choose a product', engagement_cues: 'Examples', friction_cues: 'Hype' }],
    material: [{ id: 'section-three', text }],
    questions: [{ type: 'choice', id: 'interest', instructions: 'Would you continue?', options: { continue: 'Continue', leave: 'Leave' } }],
    provider: { kind: 'jev', route: 'openrouter', model: 'typesafe/jev-1.13' },
    maxCalls: 1,
  };
}

function provider(status: ProviderContextFit['status'] = 'fits', counters = { measures: 0, decisions: 0 }): DecisionProvider {
  return {
    measure() {
      counters.measures += 1;
      return { provider: 'jev', status, method: 'test', modelIdentity: 'typesafe/jev-1.13', tokenCount: 'estimated', tokens: 20, contextLimit: 1000, headroomTokens: 100, effectiveLimit: 900, details: {} };
    },
    async decide() { counters.decisions += 1; throw new Error('Service admission never runs inference.'); },
  };
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-run-service-'));
  const store = openRunStore(root);
  return { root, store, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('context admission failure is reported before any durable run or worker launch', async () => {
  const fixture = await setup();
  const calls = { measures: 0, decisions: 0 };
  let launches = 0;
  try {
    const service = createRunService(fixture.store, fixture.root, () => provider('overflow', calls), { async launch() { launches += 1; } }, { assertProviderReady: async () => undefined });
    await assert.rejects(service.start(randomUUID(), request()), (error: unknown) => error instanceof RunServiceError && error.code === 'admission_failed');
    assert.equal(fixture.store.list({}).items.length, 0);
    assert.equal(calls.measures, 1);
    assert.equal(calls.decisions, 0);
    assert.equal(launches, 0);
  } finally { await fixture.close(); }
});

test('an exact submission retry returns its durable run before rechecking credentials or fit', async () => {
  const fixture = await setup();
  const calls = { measures: 0, decisions: 0 };
  let readinessChecks = 0;
  let available = true;
  let launches = 0;
  const service = createRunService(fixture.store, fixture.root, () => provider('fits', calls), { async launch() { launches += 1; } }, {
    assertProviderReady: async () => { readinessChecks += 1; if (!available) throw new RunServiceError('provider_credential_unavailable', 'Provider credential is unavailable.'); },
  });
  try {
    const submissionId = randomUUID();
    const accepted = await service.start(submissionId, request());
    available = false;
    const retry = await service.start(submissionId, request());
    assert.equal(retry.runId, accepted.runId);
    assert.equal(readinessChecks, 1);
    assert.equal(calls.measures, 1);
    assert.equal(launches, 1);
  } finally { await fixture.close(); }
});

test('a present malformed provider credential is reported before durable acceptance', async () => {
  const fixture = await setup();
  try {
    const service = createRunService(fixture.store, fixture.root, () => provider(), { async launch() { throw new Error('must not launch'); } }, {
      assertProviderReady: async () => { throw new CredentialStoreError('credential_malformed', 'openrouter'); },
    });
    await assert.rejects(service.start(randomUUID(), request()), (error: unknown) => {
      assert.ok(error instanceof RunServiceError);
      assert.equal(error.code, 'provider_credential_malformed');
      assert.match(error.message, /UTF-8 or UTF-16LE/);
      assert.doesNotMatch(error.message, /fixture-secret|73 bytes/);
      return true;
    });
    assert.equal(fixture.store.list({}).items.length, 0);
  } finally { await fixture.close(); }
});

test('racing identical submissions persist and launch only one run', async () => {
  const fixture = await setup();
  const calls = { measures: 0, decisions: 0 };
  let launches = 0;
  try {
    const service = createRunService(fixture.store, fixture.root, () => provider('fits', calls), { async launch() { launches += 1; } }, { assertProviderReady: async () => undefined });
    const submissionId = randomUUID();
    const [first, second] = await Promise.all([service.start(submissionId, request()), service.start(submissionId, request())]);
    assert.equal(first.runId, second.runId);
    assert.equal(fixture.store.list({}).items.length, 1);
    assert.equal(launches, 1);
  } finally { await fixture.close(); }
});

test('a changed request cannot reuse a submission ID', async () => {
  const fixture = await setup();
  const service = createRunService(fixture.store, fixture.root, () => provider(), { async launch() {} }, { assertProviderReady: async () => undefined });
  try {
    const submissionId = randomUUID();
    await service.start(submissionId, request());
    await assert.rejects(service.start(submissionId, request('Changed section')), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'submission_conflict');
    assert.equal(fixture.store.list({}).items.length, 1);
  } finally { await fixture.close(); }
});

test('worker launch failure returns the retained run identity and failed status', async () => {
  const fixture = await setup();
  try {
    const service = createRunService(fixture.store, fixture.root, () => provider(), { async launch() { throw new Error('host path detail'); } }, { assertProviderReady: async () => undefined });
    const run = await service.start(randomUUID(), request());
    assert.equal(run.status, 'failed');
    assert.equal(run.failure?.code, 'worker_launch_failed');
    assert.equal(run.failure?.message.includes('host path detail'), false);
    assert.equal(fixture.store.getRequest(run.runId).request.material[0]!.text, 'Section three');
  } finally { await fixture.close(); }
});

test('run reads reconcile interruption without launching or constructing a provider', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-run-service-'));
  let nowMs = 5_000;
  const first = openRunStore(root, { now: () => nowMs });
  const prepared = await prepareRun(request(), provider());
  assert.ok(prepared.prepared);
  const accepted = first.accept(randomUUID(), prepared.prepared);
  const second = openRunStore(root, { now: () => nowMs });
  let launches = 0;
  let constructions = 0;
  try {
    assert.ok(first.claim(accepted.run.runId, nowMs, 1234));
    nowMs += 31_000;
    const service = createRunService(second, root, () => { constructions += 1; return provider(); }, { async launch() { launches += 1; } });
    assert.equal(service.getStatus(accepted.run.runId).status, 'interrupted');
    assert.equal((service.answers(accepted.run.runId, undefined, 1)).items[0]!.status, 'pending');
    assert.equal(launches, 0);
    assert.equal(constructions, 0);
  } finally {
    first.close(); second.close();
    await rm(root, { recursive: true, force: true });
  }
});
