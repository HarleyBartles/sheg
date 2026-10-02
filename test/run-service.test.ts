import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { DecisionProvider, ProviderContextFit } from '../src/domain/decision/provider.js';
import type { FollowOnRunRequest, InlineRunRequest } from '../src/domain/run/request.js';
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

async function interruptedRun(fixture: Awaited<ReturnType<typeof setup>>) {
  const prepared = await prepareRun(request(), provider());
  assert.ok(prepared.prepared);
  const accepted = fixture.store.accept(randomUUID(), prepared.prepared);
  const now = Date.now();
  assert.ok(fixture.store.claim(accepted.run.runId, now, 1234));
  fixture.store.reconcile(accepted.run.runId, now + 31_000);
  return accepted.run;
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
    const saved = fixture.store.getRequest(run.runId);
    assert.equal(saved.request.kind, 'poll');
    if (saved.request.kind === 'poll') assert.equal(saved.request.material[0]!.text, 'Section three');
  } finally { await fixture.close(); }
});

test('follow-on inspection fits frozen saved context and acceptance retains source lineage', async () => {
  const fixture = await setup();
  const counters = { measures: 0, decisions: 0 };
  let launches = 0;
  try {
    const sourcePrepared = await prepareRun(request(), provider());
    assert.ok(sourcePrepared.prepared);
    const source = fixture.store.accept(randomUUID(), sourcePrepared.prepared).run;
    const claim = fixture.store.claim(source.runId, Date.now(), 1234);
    assert.ok(claim);
    const reservation = fixture.store.reserveNext(claim, Date.now());
    assert.ok(reservation);
    fixture.store.settle(claim, reservation.attemptId, { kind: 'answered', result: { type: 'choice', choice: 'leave', probabilities: { continue: 0.1, leave: 0.9 }, confidence: 0.9, attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {} } });
    fixture.store.finish(claim);
    const followOn: FollowOnRunRequest = {
      kind: 'follow-on', sourceRunId: source.runId,
      selection: { criteria: { answer: { type: 'choice', choiceId: 'leave' } } },
      context: { mode: 'recorded' },
      questions: [{ type: 'noul', id: 'why-leave', instructions: 'What caused you to leave?' }],
      provider: request().provider, maxCalls: 1,
    };
    const service = createRunService(fixture.store, fixture.root, () => provider('fits', counters), { async launch() { launches += 1; } }, { assertProviderReady: async () => undefined });
    const before = fixture.store.list({}).items.length;
    const inspection = await service.inspect(followOn);
    assert.equal(inspection.valid, true, JSON.stringify(inspection));
    assert.equal(inspection.respondentCount, 1);
    assert.equal(counters.measures, 1);
    assert.equal(counters.decisions, 0);
    assert.equal(fixture.store.list({}).items.length, before);
    const accepted = await service.start(randomUUID(), followOn);
    assert.equal(accepted.status, 'prepared');
    assert.equal(launches, 1);
    const saved = fixture.store.getRequest(accepted.runId);
    assert.equal(saved.request.kind, 'follow-on');
    if (saved.request.kind === 'follow-on') {
      assert.equal(saved.lineage?.sourceRunId, source.runId);
      assert.equal(saved.lineage?.sourceAvailable, true);
    }
    assert.deepEqual(fixture.store.list({ materialId: 'section-three' }).items.map(({ runId }) => runId).sort(), [source.runId, accepted.runId].sort());
    const preview = fixture.store.previewDelete([source.runId]);
    assert.deepEqual(preview.runs[0]?.retainedFollowOnRunIds, [accepted.runId]);
    const followOnClaim = fixture.store.claim(accepted.runId, Date.now(), 4321);
    assert.ok(followOnClaim);
    const followOnAttempt = fixture.store.reserveNext(followOnClaim, Date.now());
    assert.ok(followOnAttempt);
    fixture.store.settle(followOnClaim, followOnAttempt.attemptId, { kind: 'answered', result: {
      type: 'noul', noul: 0.6, attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {},
    } });
    fixture.store.finish(followOnClaim);
    fixture.store.deleteRuns([source.runId]);
    const retained = fixture.store.getRequest(accepted.runId);
    assert.equal(retained.request.kind, 'follow-on');
    if (retained.request.kind === 'follow-on') {
      assert.equal(retained.lineage?.sourceRunId, source.runId);
      assert.equal(retained.lineage?.sourceAvailable, false);
      assert.equal(retained.lineage?.sourceRecordState, 'historical');
    }
    assert.equal(fixture.store.answers(accepted.runId).items[0]?.result?.type, 'noul');
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

test('explicit resume returns the same run and launches it once', async () => {
  const fixture = await setup();
  const run = await interruptedRun(fixture);
  let launches = 0;
  let readinessChecks = 0;
  const service = createRunService(fixture.store, fixture.root, () => provider(), { async launch(_root, runId) { assert.equal(runId, run.runId); launches += 1; } }, { assertProviderReady: async () => { readinessChecks += 1; } });
  try {
    const resumed = await service.resume(run.runId);
    assert.equal(resumed.runId, run.runId);
    assert.equal(resumed.status, 'prepared');
    assert.equal(launches, 1);
    assert.equal(readinessChecks, 1);
  } finally { await fixture.close(); }
});

test('explicit resume reopens only failed questions in a partial grouped run', async () => {
  const fixture = await setup();
  const value = { ...request(), maxCalls: 2, questions: [request().questions[0]!, { type: 'noul' as const, id: 'interest-loss', instructions: 'Did anything reduce your interest?' }] };
  const fit: ProviderContextFit = { provider: 'jev', status: 'fits', method: 'test', modelIdentity: 'typesafe/jev-1.13', tokenCount: 'estimated', tokens: 20, contextLimit: 1000, headroomTokens: 100, effectiveLimit: 900, details: {} };
  try {
    const prepared = await prepareRun(value, { ...provider(), measureBatch: () => fit }); assert.ok(prepared.prepared);
    const accepted = fixture.store.accept(randomUUID(), prepared.prepared);
    const claim = fixture.store.claim(accepted.run.runId, Date.now(), 1234); assert.ok(claim);
    const batch = fixture.store.reserveBatch(claim, prepared.prepared.groups![0]!.groupId, prepared.prepared.evaluations.map(({ evaluationId }) => evaluationId), Date.now()); assert.ok(batch);
    fixture.store.settleBatch(claim, batch.attemptId, { kind: 'answered', result: {
      execution: { attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {} },
      answers: [
        { questionId: 'interest', value: { type: 'choice', choice: 'continue', probabilities: { continue: 0.9, leave: 0.1 } } },
        { questionId: 'interest-loss', failure: { code: 'invalid_answer', message: 'Answer did not match the question.' } },
      ],
    } });
    fixture.store.finish(claim);
    assert.equal(fixture.store.getStatus(accepted.run.runId).status, 'partial');
    let launches = 0;
    const service = createRunService(fixture.store, fixture.root, () => provider(), { async launch() { launches += 1; } }, { assertProviderReady: async () => undefined });
    const resumed = await service.resume(accepted.run.runId);
    assert.equal(resumed.status, 'prepared'); assert.equal(launches, 1);
    assert.deepEqual(fixture.store.answers(accepted.run.runId).items.map(({ status }) => status), ['answered', 'pending']);
  } finally { await fixture.close(); }
});

test('simultaneous resume calls launch at most one worker', async () => {
  const fixture = await setup();
  const run = await interruptedRun(fixture);
  let launches = 0;
  const service = createRunService(fixture.store, fixture.root, () => provider(), { async launch() { launches += 1; } }, { assertProviderReady: async () => undefined });
  try {
    const [first, second] = await Promise.all([service.resume(run.runId), service.resume(run.runId)]);
    assert.equal(first.runId, run.runId);
    assert.equal(second.runId, run.runId);
    assert.equal(launches, 1);
  } finally { await fixture.close(); }
});

test('resume readiness failure leaves the interrupted run unchanged', async () => {
  const fixture = await setup();
  const run = await interruptedRun(fixture);
  let launches = 0;
  const service = createRunService(fixture.store, fixture.root, () => provider(), { async launch() { launches += 1; } }, { assertProviderReady: async () => { throw new CredentialStoreError('credential_malformed', 'openrouter'); } });
  try {
    await assert.rejects(service.resume(run.runId), (error: unknown) => error instanceof RunServiceError && error.code === 'provider_credential_malformed');
    assert.equal(fixture.store.getStatus(run.runId).status, 'interrupted');
    assert.equal(launches, 0);
  } finally { await fixture.close(); }
});

test('resume does not relaunch prepared or running work and rejects terminal runs', async () => {
  const fixture = await setup();
  const prepared = await prepareRun(request(), provider());
  assert.ok(prepared.prepared);
  const accepted = fixture.store.accept(randomUUID(), prepared.prepared);
  let launches = 0;
  const service = createRunService(fixture.store, fixture.root, () => provider(), { async launch() { launches += 1; } }, { assertProviderReady: async () => undefined });
  try {
    assert.equal((await service.resume(accepted.run.runId)).status, 'prepared');
    assert.equal(launches, 0);
    assert.ok(fixture.store.claim(accepted.run.runId, Date.now(), 1234));
    await assert.rejects(service.resume(accepted.run.runId), (error: unknown) => error instanceof RunServiceError && error.code === 'run_not_resumable');
    assert.equal(launches, 0);
    fixture.store.requestCancel(accepted.run.runId);
    await assert.rejects(service.resume(accepted.run.runId), (error: unknown) => error instanceof RunServiceError && error.code === 'run_not_resumable');
    assert.equal(launches, 0);
  } finally { await fixture.close(); }
});

test('resume launch failure stays visible under the original run identity', async () => {
  const fixture = await setup();
  const run = await interruptedRun(fixture);
  const service = createRunService(fixture.store, fixture.root, () => provider(), { async launch() { throw new Error('host path detail'); } }, { assertProviderReady: async () => undefined });
  try {
    const resumed = await service.resume(run.runId);
    assert.equal(resumed.runId, run.runId);
    assert.equal(resumed.status, 'failed');
    assert.equal(resumed.failure?.code, 'worker_launch_failed');
    assert.equal(resumed.failure?.message.includes('host path detail'), false);
  } finally { await fixture.close(); }
});
