import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareRun } from '../src/application/run-inspection.js';
import type { DecisionProvider, ProviderContextFit } from '../src/domain/decision/provider.js';
import type { DecisionResult } from '../src/domain/decision/decision.js';
import type { InlineRunRequest, PreparedRun } from '../src/domain/run/request.js';
import { openRunStore, RunStoreError } from '../src/infrastructure/run-store.js';

const input: InlineRunRequest = {
  kind: 'poll',
  respondents: [
    { id: 'reader-a', intent: 'Understand the product', context: 'New buyer', desired_outcome: 'Choose a tool', engagement_cues: 'Examples', friction_cues: 'Hype' },
    { id: 'reader-b', intent: 'Compare options', context: 'Returning buyer', desired_outcome: 'Save time', engagement_cues: 'Evidence', friction_cues: 'Repetition' },
  ],
  material: [{ id: 'section-three', text: 'Exact authored section' }],
  questions: [{ type: 'choice', id: 'interest', instructions: 'Would you keep reading?', options: { continue: 'Continue', leave: 'Leave' } }],
  provider: { kind: 'laya', baseUrl: 'http://127.0.0.1:7071', checkpoint: 'test-model', contextLimit: 4096, headLimit: 2048, tokenizerJsonPath: 'tokenizer.json', tokenizerSha256: 'a'.repeat(64), timeoutMs: 1000 },
  maxCalls: 2,
};

const fit: ProviderContextFit = {
  provider: 'laya', status: 'fits', method: 'test', modelIdentity: 'test-model', tokenCount: 'measured',
  tokens: 12, contextLimit: 4096, headroomTokens: 128, effectiveLimit: 3968, details: {},
};

const provider: DecisionProvider = {
  measure: () => fit,
  async decide(): Promise<DecisionResult> { throw new Error('This fixture only prepares requests.'); },
};

async function preparedRun(value: InlineRunRequest = input): Promise<PreparedRun> {
  const result = await prepareRun(value, provider);
  assert.ok(result.prepared);
  return result.prepared;
}

const savedAnswer: DecisionResult = {
  type: 'choice', choice: 'continue', probabilities: { continue: 0.9, leave: 0.1 },
  attempts: 1, provider: 'laya', model: 'test-model', latencyMs: 1, usage: {},
};

async function resumableFixture(value: InlineRunRequest = input) {
  const root = await temporaryRoot();
  let nowMs = 10_000;
  const store = openRunStore(root, { now: () => nowMs });
  const accepted = store.accept(randomUUID(), await preparedRun(value));
  return {
    root, store, runId: accepted.run.runId, request: value,
    now: () => nowMs,
    advance: (milliseconds: number) => { nowMs += milliseconds; },
    close: async () => { store.close(); await rm(root, { recursive: true, force: true }); },
  };
}

async function temporaryRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'sheg-run-store-'));
}

test('acceptance survives a second connection and matching submission retries share one run ID', async () => {
  const root = await temporaryRoot();
  const first = openRunStore(root);
  const second = openRunStore(root);
  try {
    const request = await preparedRun();
    const submissionId = randomUUID();
    const accepted = first.accept(submissionId, request);
    const retry = second.accept(submissionId, request);
    assert.equal(accepted.created, true);
    assert.equal(retry.created, false);
    assert.equal(retry.run.runId, accepted.run.runId);
    assert.equal(second.getRequest(accepted.run.runId).request.material[0]!.text, 'Exact authored section');
  } finally {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('two processes can initialize the same fresh datastore concurrently', async () => {
  const root = await temporaryRoot();
  const moduleUrl = new URL('../src/infrastructure/run-store.ts', import.meta.url).href;
  const script = `import { openRunStore } from ${JSON.stringify(moduleUrl)}; const store = openRunStore(process.env.SHEG_TEST_ROOT); store.close();`;
  const launch = () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, SHEG_TEST_ROOT: root },
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Initializer exited with ${code}.`)));
  });
  try {
    await Promise.all([launch(), launch()]);
    const store = openRunStore(root);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resume preserves the run and saved answer and uses a fresh claim window', async () => {
  const f = await resumableFixture();
  try {
    const claim = f.store.claim(f.runId, f.now(), 1234);
    assert.ok(claim);
    const first = f.store.reserveNext(claim, f.now());
    assert.ok(first);
    f.store.settle(claim, first.attemptId, { kind: 'answered', result: savedAnswer });
    f.advance(30_001);
    assert.equal(f.store.getStatus(f.runId).status, 'interrupted');

    const resumed = f.store.resume(f.runId, f.now());
    assert.equal(resumed.started, true);
    assert.equal(resumed.run.runId, f.runId);
    assert.equal(resumed.run.status, 'prepared');
    assert.equal(resumed.run.usedCalls, 1);
    assert.equal(resumed.run.maxCalls, f.request.maxCalls);
    assert.equal(f.store.answers(f.runId).items[0]?.status, 'answered');
    assert.deepEqual(f.store.getRequest(f.runId).request, f.request);

    assert.equal(f.store.resume(f.runId, f.now()).started, false, 'a second resume must not claim or launch the prepared run again');
    const resumedClaim = f.store.claim(f.runId, f.now(), 5678);
    assert.ok(resumedClaim, 'an old run must use the fresh resume launch window');
  } finally { await f.close(); }
});

test('resume consumes an uncertain attempt once and never increases the original call limit', async () => {
  const f = await resumableFixture();
  try {
    const claim = f.store.claim(f.runId, f.now(), 1234);
    assert.ok(claim);
    const reservation = f.store.reserveNext(claim, f.now());
    assert.ok(reservation);
    f.advance(30_001);
    const interrupted = f.store.getStatus(f.runId);
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.usedCalls, 1);
    assert.equal(interrupted.reservedCalls, 0);
    const history = new DatabaseSync(path.join(f.root, 'runs.sqlite'));
    try {
      const attempts = history.prepare('SELECT status FROM attempts WHERE run_id = ?').all(f.runId) as Array<{ status: string }>;
      assert.deepEqual(attempts.map(({ status }) => status), ['uncertain']);
    } finally { history.close(); }

    const resumed = f.store.resume(f.runId, f.now());
    assert.equal(resumed.started, true);
    assert.equal(resumed.run.usedCalls, 1);
    assert.equal(resumed.run.maxCalls, f.request.maxCalls);
    assert.equal(f.store.answers(f.runId).items[0]?.status, 'pending');
    const resumedClaim = f.store.claim(f.runId, f.now(), 5678);
    assert.ok(resumedClaim);
    assert.ok(f.store.reserveNext(resumedClaim, f.now()));
    assert.equal(f.store.reserveNext(resumedClaim, f.now()), null);
  } finally { await f.close(); }
});

test('resume reopens only a run-scoped failed evaluation and retains its failed attempt', async () => {
  const f = await resumableFixture();
  try {
    const claim = f.store.claim(f.runId, f.now(), 1234);
    assert.ok(claim);
    const reservation = f.store.reserveNext(claim, f.now());
    assert.ok(reservation);
    f.store.settle(claim, reservation.attemptId, { kind: 'failed', code: 'provider_unavailable', message: 'Provider access failed.', scope: 'run' });
    assert.equal(f.store.finish(claim).status, 'failed');

    const resumed = f.store.resume(f.runId, f.now());
    assert.equal(resumed.started, true);
    assert.equal(resumed.run.runId, f.runId);
    assert.equal(resumed.run.usedCalls, 1);
    assert.equal(f.store.answers(f.runId).items[0]?.status, 'pending');
    const history = new DatabaseSync(path.join(f.root, 'runs.sqlite'));
    try {
      const attempts = history.prepare('SELECT status, failure_scope FROM attempts WHERE run_id = ?').all(f.runId) as Array<{ status: string; failure_scope: string }>;
      assert.deepEqual(attempts.map(({ status, failure_scope }) => ({ status, failure_scope })), [{ status: 'failed', failure_scope: 'run' }]);
    } finally { history.close(); }
  } finally { await f.close(); }
});

test('resume rejects a run-wide failure after the original call budget is exhausted', async () => {
  const f = await resumableFixture();
  try {
    const claim = f.store.claim(f.runId, f.now(), 1234);
    assert.ok(claim);
    const first = f.store.reserveNext(claim, f.now());
    assert.ok(first);
    f.store.settle(claim, first.attemptId, { kind: 'answered', result: savedAnswer });
    const second = f.store.reserveNext(claim, f.now());
    assert.ok(second);
    f.store.settle(claim, second.attemptId, { kind: 'failed', code: 'provider_unavailable', message: 'Provider access failed.', scope: 'run' });
    assert.equal(f.store.finish(claim).status, 'failed');
    const before = f.store.getStatus(f.runId);
    assert.equal(before.usedCalls, before.maxCalls);
    assert.throws(() => f.store.resume(f.runId, f.now()), (error: unknown) => error instanceof RunStoreError && error.code === 'run_not_resumable');
    assert.equal(f.store.getStatus(f.runId).status, 'failed');
  } finally { await f.close(); }
});

test('resumed work that misses its launch window becomes interrupted without a read relaunch', async () => {
  const f = await resumableFixture();
  try {
    f.advance(30_001);
    assert.equal(f.store.getStatus(f.runId).status, 'interrupted');
    const resumed = f.store.resume(f.runId, f.now());
    assert.equal(resumed.started, true);
    f.advance(30_001);
    assert.equal(f.store.getStatus(f.runId).status, 'interrupted');
    assert.equal(f.store.resume(f.runId, f.now()).started, true);
  } finally { await f.close(); }
});

test('a cancellation request prevents resuming after the worker lease expires', async () => {
  const f = await resumableFixture();
  try {
    assert.ok(f.store.claim(f.runId, f.now(), 1234));
    f.store.requestCancel(f.runId);
    f.advance(30_001);
    assert.equal(f.store.getStatus(f.runId).status, 'interrupted');
    assert.throws(() => f.store.resume(f.runId, f.now()), (error: unknown) => error instanceof RunStoreError && error.code === 'run_not_resumable');
    assert.equal(f.store.getStatus(f.runId).status, 'interrupted');
  } finally { await f.close(); }
});

test('resume rejects live and terminal runs without changing them', async () => {
  for (const target of ['running', 'cancelled', 'completed', 'partial']) {
    const f = await resumableFixture(target === 'partial' ? { ...input, maxCalls: 2 } : input);
    try {
      if (target === 'running') {
        assert.ok(f.store.claim(f.runId, f.now(), 1234));
      } else if (target === 'cancelled') {
        f.store.requestCancel(f.runId);
      } else {
        const claim = f.store.claim(f.runId, f.now(), 1234);
        assert.ok(claim);
        const first = f.store.reserveNext(claim, f.now());
        assert.ok(first);
        f.store.settle(claim, first.attemptId, target === 'completed'
          ? { kind: 'answered', result: savedAnswer }
          : { kind: 'failed', code: 'decision_failed', message: 'Evaluation failed.', scope: 'evaluation' });
        if (target === 'completed') {
          const second = f.store.reserveNext(claim, f.now());
          assert.ok(second);
          f.store.settle(claim, second.attemptId, { kind: 'answered', result: savedAnswer });
        } else {
          const second = f.store.reserveNext(claim, f.now());
          assert.ok(second);
          f.store.settle(claim, second.attemptId, { kind: 'answered', result: savedAnswer });
        }
        assert.equal(f.store.finish(claim).status, target);
      }
      const before = f.store.getStatus(f.runId);
      assert.throws(() => f.store.resume(f.runId, f.now()), (error: unknown) => error instanceof RunStoreError && error.code === 'run_not_resumable');
      assert.equal(f.store.getStatus(f.runId).status, before.status);
      assert.equal(f.store.getStatus(f.runId).usedCalls, before.usedCalls);
    } finally { await f.close(); }
  }
});

test('the same submission ID cannot be reused for changed request contents', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const submissionId = randomUUID();
    store.accept(submissionId, await preparedRun());
    const changed = await preparedRun({ ...input, material: [{ id: 'section-three', text: 'Changed authored section' }] });
    assert.throws(() => store.accept(submissionId, changed), (error: unknown) => error instanceof RunStoreError && error.code === 'submission_conflict');
    assert.equal(store.list({}).items.length, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('accepted JSON remains unchanged after caller objects mutate and the store reopens', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  let closed = false;
  const request = await preparedRun();
  const submissionId = randomUUID();
  try {
    const accepted = store.accept(submissionId, request);
    request.request.material[0]!.text = 'mutated after acceptance';
    request.request.respondents[0]!.intent = 'mutated after acceptance';
    store.close();
    closed = true;

    const reopened = openRunStore(root);
    try {
      const saved = reopened.getRequest(accepted.run.runId);
      assert.equal(saved.request.material[0]!.text, 'Exact authored section');
      assert.equal(saved.request.respondents[0]!.intent, 'Understand the product');
      assert.deepEqual(saved.evaluations[0]!.packet.state['encounteredItems'], [{ id: 'section-three', text: 'Exact authored section' }]);
    } finally { reopened.close(); }
  } finally {
    if (!closed) store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('answers paginate in stable evaluation order and identify pending work', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const accepted = store.accept(randomUUID(), await preparedRun());
    const first = store.answers(accepted.run.runId, undefined, 1);
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0]!.status, 'pending');
    assert.ok(first.nextCursor);
    const second = store.answers(accepted.run.runId, first.nextCursor, 1);
    assert.equal(second.items.length, 1);
    assert.equal(second.items[0]!.status, 'pending');
    assert.notEqual(second.items[0]!.evaluationId, first.items[0]!.evaluationId);
    assert.equal(second.nextCursor, undefined);
    assert.throws(() => store.answers(accepted.run.runId, 'not-a-cursor', 1), RunStoreError);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('malformed run-list cursor fields return invalid_cursor', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    for (const cursor of [
      { kind: 'runs' },
      { kind: 'runs', createdMs: 'today', runId: 'run-1' },
      { kind: 'runs', createdMs: 1, runId: 4 },
    ]) {
      const encoded = Buffer.from(JSON.stringify(cursor)).toString('base64url');
      assert.throws(() => store.list({ cursor: encoded }), (error: unknown) => error instanceof RunStoreError && error.code === 'invalid_cursor');
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('foreign key violations fail without corrupting the accepted run', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const accepted = store.accept(randomUUID(), await preparedRun());
    const otherConnection = new DatabaseSync(path.join(root, 'runs.sqlite'));
    otherConnection.exec('PRAGMA foreign_keys = ON');
    try {
      assert.throws(() => otherConnection.prepare("INSERT INTO evaluations (evaluation_id, run_id, ordinal, context_id, respondent_id, question_id, packet_json, packet_fingerprint, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), 'missing-run', 0, 'context', 'respondent', 'question', '{}', 'fingerprint', 'pending'));
    } finally { otherConnection.close(); }
    assert.equal(store.getStatus(accepted.run.runId).totalEvaluations, 2);
    assert.equal(store.list({}).items.length, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a stale reservation is consumed once and cannot be settled by the former owner', async () => {
  const root = await temporaryRoot();
  let nowMs = 1_000;
  const first = openRunStore(root, { now: () => nowMs });
  const second = openRunStore(root, { now: () => nowMs });
  try {
    const accepted = first.accept(randomUUID(), await preparedRun());
    const claim = first.claim(accepted.run.runId, nowMs, 1234);
    assert.ok(claim);
    assert.equal(second.claim(accepted.run.runId, nowMs, 5678), null);
    const reservation = first.reserveNext(claim, nowMs);
    assert.ok(reservation);
    assert.equal(first.getStatus(accepted.run.runId).usedCalls, 0);
    assert.equal(first.getStatus(accepted.run.runId).reservedCalls, 1);

    nowMs += 31_000;
    const interrupted = second.reconcile(accepted.run.runId, nowMs);
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.usedCalls, 1);
    assert.equal(interrupted.reservedCalls, 0);
    assert.equal(second.reconcile(accepted.run.runId, nowMs).usedCalls, 1);
    assert.equal(second.answers(accepted.run.runId, undefined, 1).items[0]!.status, 'pending');
    assert.throws(() => first.settle(claim, reservation.attemptId, { kind: 'failed', code: 'late', message: 'late result', scope: 'evaluation' }), RunStoreError);
  } finally {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the physical call ceiling bounds reservations and valid answers settle atomically', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const accepted = store.accept(randomUUID(), await preparedRun());
    const claim = store.claim(accepted.run.runId, Date.now(), 1234);
    assert.ok(claim);
    const first = store.reserveNext(claim, Date.now());
    assert.ok(first);
    assert.equal(store.reserveNext(claim, Date.now()), null);
    assert.equal(store.getStatus(accepted.run.runId).reservedCalls, 1);
    assert.throws(() => store.finish(claim), (error: unknown) => error instanceof RunStoreError && error.code === 'attempt_in_flight');

    const answer: DecisionResult = { type: 'choice', choice: 'continue', probabilities: { continue: 0.8, leave: 0.2 }, attempts: 1, provider: 'laya', model: 'test-model', latencyMs: 5, usage: {} };
    assert.throws(() => store.settle(claim, first.attemptId, { kind: 'answered', result: { ...answer, choice: 'not-offered' } }), /not offered/i);
    assert.equal(store.getStatus(accepted.run.runId).reservedCalls, 1);
    assert.equal(store.answers(accepted.run.runId, undefined, 1).items[0]!.status, 'pending');

    store.settle(claim, first.attemptId, { kind: 'answered', result: answer });
    assert.equal(store.getStatus(accepted.run.runId).usedCalls, 1);
    const second = store.reserveNext(claim, Date.now());
    assert.ok(second);
    store.settle(claim, second.attemptId, { kind: 'answered', result: answer });
    assert.equal(store.reserveNext(claim, Date.now()), null);
    assert.equal(store.getStatus(accepted.run.runId).usedCalls, 2);
    assert.equal(store.finish(claim).status, 'completed');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('run discovery reconciles stale workers before applying status filters', async () => {
  const root = await temporaryRoot();
  let nowMs = 10_000;
  const store = openRunStore(root, { now: () => nowMs });
  try {
    const accepted = store.accept(randomUUID(), await preparedRun());
    assert.ok(store.claim(accepted.run.runId, nowMs, 1234));
    nowMs += 31_000;
    const page = store.list({ status: 'interrupted' });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]!.runId, accepted.run.runId);
    assert.equal(page.items[0]!.status, 'interrupted');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
