import type { DecisionBatchRequest, DecisionQuestion, DecisionRequest } from '../domain/decision/decision.js';
import type { DecisionProvider, ProviderContextFit, ProviderKind } from '../domain/decision/provider.js';
import type { ProviderCatalogueEntry } from '../providers/config.js';
import { selectProvider, type CandidateCost, type ProviderSelectionInput, type ProviderSelectionResult } from './provider-selection.js';

export type ProviderBatchGroup = {
  groupId: string;
  contextId: string;
  respondentId: string;
  state: DecisionBatchRequest['state'];
  questions: readonly DecisionQuestion[];
  packets: readonly DecisionRequest[];
};
export type ProviderBatchFit = { questionIds: string[]; fit: ProviderContextFit };
export type ProviderBatchPlan = {
  batches: DecisionBatchRequest[];
  questionIdsByBatch: string[][];
  fits: ProviderBatchFit[];
  problems: Array<{ code: string; respondentId: string; message: string }>;
  minimumCalls: number;
  repeatedInputTokens: number | null;
  cost: CandidateCost;
  exceedsRemainingCalls: boolean;
};
export type ProviderBatchPlanInput = {
  group: ProviderBatchGroup;
  provider: DecisionProvider;
  providerKind: ProviderKind;
  modelIdentity: string;
  batching: 'automatic' | 'singleton';
  remainingCalls?: number;
  pricing?: ProviderCatalogueEntry['pricing'];
};
export type ProviderBatchCandidate = {
  id: string;
  provider: DecisionProvider;
  providerKind: ProviderKind;
  modelIdentity: string;
  ready: boolean;
};
export type ProviderBatchSelectionInput = Omit<ProviderSelectionInput, 'candidates'> & {
  group: ProviderBatchGroup;
  candidates: ProviderBatchCandidate[];
  batching: 'automatic' | 'singleton';
};
export type ProviderBatchSelection = { selection: ProviderSelectionResult; plans: Record<string, ProviderBatchPlan> };

function missingFit(provider: DecisionProvider, kind: ProviderKind, modelIdentity: string): ProviderContextFit {
  return { provider: kind, status: 'unavailable', method: 'unavailable', modelIdentity, tokenCount: 'estimated', tokens: 0,
    contextLimit: null, headroomTokens: null, effectiveLimit: null, details: {}, reason: provider.measure || provider.measureBatch ? 'provider-measurement-failed' : 'provider-measurement-unavailable' };
}

function fitProblem(respondentId: string, fit: ProviderContextFit): ProviderBatchPlan['problems'][number] | undefined {
  if (fit.status === 'fits') return undefined;
  return { code: fit.status === 'overflow' ? 'context_overflow' : 'context_unverified', respondentId,
    message: fit.reason ?? `Provider context ${fit.status}.` };
}

export async function assessProviderBatchPlan(input: ProviderBatchPlanInput): Promise<ProviderBatchPlan> {
  const { group, provider, providerKind, modelIdentity } = input;
  const { groupId, contextId, respondentId, state, questions, packets } = group;
  void groupId; void contextId;
  if (questions.length !== packets.length || questions.some((question, index) => question.id !== packets[index]?.question.id)) {
    throw new Error('Provider batch questions must match the ordered frozen packets.');
  }
  const materialsByQuestion = new Map(packets.map((packet) => [packet.question.id, packet.visualMaterials ?? []]));
  const visualFor = (batchQuestions: readonly DecisionQuestion[]) => {
    const byId = new Map<string, NonNullable<DecisionRequest['visualMaterials']>[number]>();
    for (const question of batchQuestions) for (const material of materialsByQuestion.get(question.id) ?? []) byId.set(material.id, material);
    return [...byId.values()];
  };
  const batchRequest = (selected: readonly DecisionQuestion[]): DecisionBatchRequest => {
    const visualMaterials = visualFor(selected);
    return { state, questions: [...selected], ...(visualMaterials.length ? { visualMaterials } : {}) };
  };
  const batches: DecisionBatchRequest[] = [];
  const fits: ProviderBatchFit[] = [];
  const problems: ProviderBatchPlan['problems'] = [];
  const record = (ids: string[], fit: ProviderContextFit) => {
    fits.push({ questionIds: ids, fit });
    const problem = fitProblem(respondentId, fit);
    if (problem) problems.push(problem);
  };
  const measureOne = async (index: number): Promise<ProviderContextFit> => {
    if (!provider.measure) return missingFit(provider, providerKind, modelIdentity);
    try { return await provider.measure(packets[index]!); }
    catch { return { ...missingFit(provider, providerKind, modelIdentity), reason: 'provider-measurement-failed' }; }
  };
  const singleton = input.batching === 'singleton' || !provider.measureBatch || !provider.decideBatch;
  if (singleton) {
    for (let index = 0; index < questions.length; index += 1) {
      const question = questions[index]!;
      const measured = await measureOne(index);
      record([question.id], measured);
      batches.push(batchRequest([question]));
    }
  } else {
    const measureBatch = async (batchQuestions: readonly DecisionQuestion[]): Promise<ProviderContextFit> => {
      try { return await provider.measureBatch!(batchRequest(batchQuestions)); }
      catch { return { ...missingFit(provider, providerKind, modelIdentity), reason: 'provider-measurement-failed' }; }
    };
    let start = 0;
    while (start < questions.length) {
      let end = start + 1;
      let lastFit: { end: number; fit: ProviderContextFit } | undefined;
      while (end <= questions.length) {
        const candidate = questions.slice(start, end);
        const measured = await measureBatch(candidate);
        if (measured.status === 'unavailable') {
          record(candidate.map(({ id }) => id), measured);
          return finish();
        }
        if (measured.status === 'overflow') {
          if (!lastFit) record(candidate.map(({ id }) => id), measured);
          break;
        }
        lastFit = { end, fit: measured };
        end += 1;
      }
      if (!lastFit) return finish();
      const selected = questions.slice(start, lastFit.end);
      batches.push(batchRequest(selected));
      record(selected.map(({ id }) => id), lastFit.fit);
      start = lastFit.end;
    }
  }
  return finish();

  function finish(): ProviderBatchPlan {
    const tokens = fits.filter(({ fit: measured }) => measured.status === 'fits').map(({ fit: measured }) => measured.tokens);
    const repeatedInputTokens = tokens.length === batches.length ? tokens.reduce((sum, value) => sum + value, 0) : null;
    const pricing = input.pricing;
    let cost: CandidateCost;
    if (pricing?.kind === 'no-provider-invoice') cost = { kind: 'no-provider-invoice', basis: 'provider pricing contract' };
    else if (pricing?.kind === 'published-rate' && repeatedInputTokens !== null) {
      cost = { kind: 'estimate', amount: pricing.amount * repeatedInputTokens / 1_000_000, currency: pricing.currency,
        basis: 'published-rate estimate', source: pricing.source, observedAt: pricing.observedAt };
    } else cost = { kind: 'unknown', basis: 'unverified' };
    const minimumCalls = batches.length;
    const remaining = input.remainingCalls ?? Number.MAX_SAFE_INTEGER;
    return { batches, questionIdsByBatch: batches.map(({ questions: selected }) => selected.map(({ id }) => id)), fits, problems, minimumCalls,
      repeatedInputTokens, cost, exceedsRemainingCalls: minimumCalls > remaining };
  }
}

export async function assessAndSelectProviderBatches(input: ProviderBatchSelectionInput): Promise<ProviderBatchSelection> {
  const plans = Object.fromEntries(await Promise.all(input.candidates.map(async (candidate) => {
    const entry = input.catalogue.entries.find(({ id }) => id === candidate.id);
    const plan = await assessProviderBatchPlan({ group: input.group, provider: candidate.provider, providerKind: candidate.providerKind,
      modelIdentity: candidate.modelIdentity, batching: input.batching, remainingCalls: input.remainingCalls, ...(entry ? { pricing: entry.pricing } : {}) });
    return [candidate.id, plan] as const;
  })));
  const candidates = input.candidates.map((candidate) => {
    const plan = plans[candidate.id]!;
    const fit = aggregateFit(input.group, plan, candidate.providerKind, candidate.modelIdentity);
    return { id: candidate.id, ready: candidate.ready, fit, plannedCalls: plan.minimumCalls, cost: plan.cost };
  });
  const selectionInput: Omit<ProviderSelectionInput, 'candidates'> = {
    catalogue: input.catalogue, preferences: input.preferences, unitId: input.unitId, requiredCapabilities: input.requiredCapabilities,
    questionType: input.questionType, remainingCalls: input.remainingCalls,
    ...(input.preferredOrder === undefined ? {} : { preferredOrder: input.preferredOrder }),
    ...(input.unitOverride === undefined ? {} : { unitOverride: input.unitOverride }),
    ...(input.unitOverrides === undefined ? {} : { unitOverrides: input.unitOverrides }),
  };
  return { selection: selectProvider({ ...selectionInput, candidates }), plans };
}

function aggregateFit(group: ProviderBatchGroup, plan: ProviderBatchPlan, provider: ProviderKind, modelIdentity: string): ProviderContextFit {
  const selectedFits = plan.questionIdsByBatch.map((ids) => plan.fits.find(({ questionIds }) =>
    questionIds.length === ids.length && questionIds.every((id, index) => id === ids[index]))?.fit);
  const covered = plan.questionIdsByBatch.flat();
  const complete = covered.length === group.questions.length && group.questions.every((question, index) => covered[index] === question.id);
  if (complete && selectedFits.length > 0 && selectedFits.every((fit) => fit?.status === 'fits')) {
    const measured = selectedFits as ProviderContextFit[];
    const first = measured[0]!;
    return { ...first, tokens: plan.repeatedInputTokens ?? measured.reduce((sum, fit) => sum + fit.tokens, 0),
      details: { plannedCalls: plan.minimumCalls, perBatchTokens: measured.map(({ tokens }) => tokens).join(',') } };
  }
  const rejected = plan.fits.find(({ fit }) => fit.status !== 'fits')?.fit;
  if (rejected) return rejected;
  return { provider, status: 'unavailable', method: 'unavailable', modelIdentity, tokenCount: 'estimated', tokens: 0,
    contextLimit: null, headroomTokens: null, effectiveLimit: null, details: {}, reason: 'provider-batch-plan-incomplete' };
}
