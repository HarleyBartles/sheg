import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const packageVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

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

async function connectedFixture(assertProviderReady: () => Promise<void> = async () => undefined) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-mcp-'));
  const store = openRunStore(root);
  const fit = { provider: 'jev' as const, status: 'fits' as const, method: 'test', modelIdentity: 'typesafe/jev-1.13', tokenCount: 'estimated' as const, tokens: 10, contextLimit: 1000, headroomTokens: 100, effectiveLimit: 900, details: {} };
  const provider: DecisionProvider = { measure: () => fit, measureBatch: () => fit, async decide() { throw new Error('MCP admission must not infer.'); }, async decideBatch() { throw new Error('MCP admission must not infer.'); } };
  const service = createRunService(store, root, () => provider, { async launch() {} }, { assertProviderReady });
  const server = createPollingServer(service);
  const client = new Client({ name: 'sheg-mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { root, store, server, client, close: async () => { await client.close(); await server.close(); store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('MCP advertises the package product version', async () => {
  const f = await connectedFixture();
  try {
    assert.equal(f.client.getServerVersion()?.version, packageVersion);
  } finally {
    await f.close();
  }
});

test('MCP accepts, discovers, reads, and cancels durable direct requests with structured errors', async () => {
  const f = await connectedFixture();
  try {
    const tools = await f.client.listTools();
    assert.deepEqual(tools.tools.map(({ name }) => name).sort(), ['run_cancel', 'run_delete', 'run_get', 'run_inspect', 'run_list', 'run_query', 'run_resume', 'run_start', 'run_storage']);
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
