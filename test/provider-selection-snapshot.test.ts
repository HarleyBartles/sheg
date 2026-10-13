import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRunStore } from '../src/infrastructure/run-store.js';
import { providerCatalogueSchema, providerPreferenceSchema } from '../src/providers/config.js';
import { providerSelectionPolicySnapshotSchema, type ProviderSelectionPolicySnapshot } from '../src/domain/run/lifecycle.js';
import { prepareRun } from '../src/application/run-inspection.js';
import { createRunService } from '../src/application/run-service.js';
import type { DecisionProvider, ProviderContextFit } from '../src/domain/decision/provider.js';
import type { DecisionResult } from '../src/domain/decision/decision.js';

const catalogue = providerCatalogueSchema.parse({ revision: 0, entries: [{
  id: 'hosted-text', enabled: true, provider: { kind: 'jev', route: 'openrouter' }, execution: 'hosted',
  capabilities: ['text'], questionTypes: ['choice', 'score', 'noul'],
  pricing: { kind: 'published-rate', currency: 'USD', unit: 'million-input-tokens', amount: 0.08, source: 'https://provider.example/rates', observedAt: '2026-10-13' },
}] });
const preferences = providerPreferenceSchema.parse({ preferredOrder: ['hosted-text'] });
const request = {
  kind: 'poll' as const,
  respondents: [{ id: 'reader-a', intent: 'Read', context: 'Interested', desired_outcome: 'Decide', engagement_cues: 'Examples', friction_cues: 'Distraction' }],
  material: [{ id: 'opening', text: 'Opening.' }],
  questions: [{ type: 'choice' as const, id: 'continue', instructions: 'Continue?', options: { yes: 'Continue', no: 'Stop' } }],
  provider: { kind: 'jev' as const, route: 'openrouter' as const }, maxCalls: 1,
};
const fit: ProviderContextFit = { provider: 'jev', status: 'fits', method: 'test', modelIdentity: 'test-model', tokenCount: 'measured', tokens: 12, contextLimit: 4096, headroomTokens: 128, effectiveLimit: 3968, details: {} };
const provider: DecisionProvider = { measure: () => fit, async decide(): Promise<DecisionResult> { throw new Error('not dispatched'); } };
async function root(): Promise<string> { return mkdtemp(path.join(tmpdir(), 'sheg-provider-settings-')); }

function settingsApi(store: ReturnType<typeof openRunStore>) {
  const candidate = store as unknown as {
    getProviderSettings?: () => { catalogue: unknown; preferences: unknown };
    setProviderSettings?: (value: { catalogue: unknown; preferences: unknown }, expectedRevision: number) => { catalogue: unknown; preferences: unknown };
  };
  assert.equal(typeof candidate.getProviderSettings, 'function', 'run store must expose provider settings reads');
  assert.equal(typeof candidate.setProviderSettings, 'function', 'run store must expose transactional provider settings writes');
  if (!candidate.getProviderSettings || !candidate.setProviderSettings) throw new Error('Provider settings repository is unavailable.');
  return candidate as Required<typeof candidate>;
}

test('provider settings start empty and persist a validated revision across store reopen', async () => {
  const dataRoot = await root();
  let store: ReturnType<typeof openRunStore> | undefined;
  try {
    store = openRunStore(dataRoot);
    let api = settingsApi(store);
    assert.deepEqual(api.getProviderSettings(), { catalogue: { revision: 0, entries: [] }, preferences: { preferredOrder: [] } });
    const saved = api.setProviderSettings({ catalogue: { ...catalogue, revision: 0 }, preferences }, 0);
    assert.equal((saved.catalogue as { revision: number }).revision, 1);
    store.close();

    store = openRunStore(dataRoot);
    api = settingsApi(store);
    assert.deepEqual(api.getProviderSettings(), saved);
    store.close();
  } finally { store?.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test('stale provider settings revisions are rejected without overwriting the current catalogue', async () => {
  const dataRoot = await root();
  let store: ReturnType<typeof openRunStore> | undefined;
  try {
    store = openRunStore(dataRoot);
    const api = settingsApi(store);
    const saved = api.setProviderSettings({ catalogue, preferences }, 0);
    assert.throws(() => api.setProviderSettings({ catalogue: { revision: 1, entries: [] }, preferences: { preferredOrder: [] } }, 0), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'provider_settings_revision_conflict');
    assert.deepEqual(api.getProviderSettings(), saved);
    store.close();
  } finally { store?.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test('initial selection evidence rejects duplicate units and providers outside the frozen catalogue', () => {
  const snapshot = { version: 1, catalogueRevision: 1, catalogue: { entries: catalogue.entries }, preferences,
    policy: { batching: 'automatic' }, initialChoices: [
      { respondentId: 'reader-a', questionId: 'continue', providerId: 'missing', modelIdentity: 'jev-1', decisionReason: 'policy' },
      { respondentId: 'reader-a', questionId: 'continue', providerId: 'missing', modelIdentity: 'jev-1', decisionReason: 'policy' },
    ] };
  assert.equal(providerSelectionPolicySnapshotSchema.safeParse(snapshot).success, false);
});

test('acceptance stores the inspected secret-free selection snapshot with the request', async () => {
  const dataRoot = await root();
  let store: ReturnType<typeof openRunStore> | undefined;
  let reopenedStore: ReturnType<typeof openRunStore> | undefined;
  try {
    store = openRunStore(dataRoot);
    store.setProviderSettings({ catalogue: { entries: catalogue.entries }, preferences }, 0);
    const prepared = (await prepareRun(request, provider)).prepared;
    assert.ok(prepared);
    const snapshot: ProviderSelectionPolicySnapshot = { version: 1, catalogueRevision: 1,
      catalogue: { entries: catalogue.entries }, preferences, policy: { batching: 'automatic' },
      initialChoices: [{ respondentId: 'reader-a', questionId: 'continue', providerId: 'hosted-text', modelIdentity: 'openrouter/jev-1.13', decisionReason: 'lowest_comparable_published_rate_estimate' }] };
    const accepted = store.accept('provider-snapshot', { ...prepared, providerSelectionSnapshot: snapshot });
    assert.equal(accepted.created, true);
    store.setProviderSettings({ catalogue: { entries: [] }, preferences: { preferredOrder: [] } }, 1);
    const duplicate = store.accept('provider-snapshot', { ...prepared, providerSelectionSnapshot: snapshot });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.run.runId, accepted.run.runId);
    const reopened = store.getRequest(accepted.run.runId);
    assert.deepEqual(reopened.providerSelectionSnapshot, snapshot);
    store.close();
    reopenedStore = openRunStore(dataRoot);
    assert.deepEqual(reopenedStore.getRequest(accepted.run.runId).providerSelectionSnapshot, snapshot);
    reopenedStore.close();
  } finally { store?.close(); reopenedStore?.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test('acceptance rejects a catalogue snapshot changed after inspection before creating the run', async () => {
  const dataRoot = await root();
  let store: ReturnType<typeof openRunStore> | undefined;
  try {
    store = openRunStore(dataRoot);
    const activeStore = store;
    const prepared = (await prepareRun(request, provider)).prepared;
    assert.ok(prepared);
    const snapshot: ProviderSelectionPolicySnapshot = { version: 1, catalogueRevision: 0,
      catalogue: { entries: [] }, preferences: { preferredOrder: [] }, policy: { batching: 'automatic' } };
    activeStore.setProviderSettings({ catalogue: { entries: catalogue.entries }, preferences }, 0);
    assert.throws(() => activeStore.accept('stale-provider-snapshot', { ...prepared, providerSelectionSnapshot: snapshot }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'provider_settings_revision_conflict');
    assert.equal(activeStore.findSubmission('stale-provider-snapshot', prepared.requestFingerprint), null);
  } finally { store?.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test('automatic inspection fingerprint omits its own expected value and rejects settings changed before start', async () => {
  const dataRoot = await root();
  let store: ReturnType<typeof openRunStore> | undefined;
  try {
    store = openRunStore(dataRoot);
    let launches = 0;
    const service = createRunService({ reads: store, commands: store, close: store.close.bind(store) }, dataRoot, () => { throw new Error('automatic selection must reject stale settings before creating a provider'); }, {
      async launch() { launches += 1; },
    });
    const automatic = { ...request, provider: undefined, providerSelection: {} };
    delete (automatic as { provider?: unknown }).provider;
    const inspected = await service.inspect(automatic);
    assert.equal(typeof inspected.selectionFingerprint, 'string');
    const afterOwnFingerprint = await service.inspect({ ...automatic, expectedSelectionFingerprint: inspected.selectionFingerprint });
    assert.equal(afterOwnFingerprint.selectionFingerprint, inspected.selectionFingerprint);
    store.setProviderSettings({ catalogue: { entries: catalogue.entries }, preferences }, 0);
    await assert.rejects(service.start('stale-inspection', { ...automatic, expectedSelectionFingerprint: inspected.selectionFingerprint }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'provider_selection_fingerprint_stale');
    assert.equal(launches, 0);
    assert.equal(store.storageInfo().runCount, 0);
  } finally { store?.close(); await rm(dataRoot, { recursive: true, force: true }); }
});
