import type { ProviderContextFit } from '../domain/decision/provider.js';
import type { ProviderPreference, ProviderCatalogue, ProviderCatalogueEntry } from '../providers/config.js';

export type CandidateCost =
  | { kind: 'no-provider-invoice'; basis: 'provider pricing contract' }
  | { kind: 'estimate'; amount: number; currency: string; basis: 'published-rate estimate'; source: string; observedAt: string }
  | { kind: 'unknown'; basis: 'unverified' | 'incomparable currency' };

export type ProviderCandidateAssessment = {
  id: string;
  fit?: ProviderContextFit;
  ready?: boolean;
  plannedCalls: number;
  cost?: CandidateCost;
};

export type ProviderSelectionInput = {
  catalogue: ProviderCatalogue;
  preferences: ProviderPreference;
  unitId: string;
  requiredCapabilities: string[];
  questionType: string;
  candidates: ProviderCandidateAssessment[];
  remainingCalls: number;
  preferredOrder?: string[];
  unitOverride?: string;
  unitOverrides?: Record<string, string>;
};

export type ProviderCandidateEvidence = {
  id: string;
  provider?: ProviderCatalogueEntry['provider'];
  eligible: boolean;
  selected: boolean;
  fit?: ProviderContextFit;
  cost?: CandidateCost;
  exclusion?: { code: string; message: string };
  preferenceRank?: { source: 'request' | 'saved'; index: number };
};

export type ProviderSelectionResult = {
  selected?: ProviderCandidateEvidence;
  candidates: ProviderCandidateEvidence[];
  decisionReason: string;
};

function estimateCost(entry: ProviderCatalogueEntry, fit?: ProviderContextFit): CandidateCost {
  if (entry.pricing.kind === 'no-provider-invoice') return { kind: 'no-provider-invoice', basis: 'provider pricing contract' };
  if (entry.pricing.kind === 'published-rate' && fit && fit.status === 'fits') {
    return { kind: 'estimate', amount: entry.pricing.amount * fit.tokens / 1_000_000, currency: entry.pricing.currency,
      basis: 'published-rate estimate', source: entry.pricing.source, observedAt: entry.pricing.observedAt };
  }
  return { kind: 'unknown', basis: 'unverified' };
}

function exclude(candidate: ProviderCandidateEvidence, code: string, message: string): void {
  candidate.eligible = false;
  candidate.exclusion = { code, message };
}

export function selectProvider(input: ProviderSelectionInput): ProviderSelectionResult {
  const entries = new Map(input.catalogue.entries.map((entry) => [entry.id, entry]));
  const candidates = input.candidates.map((assessment): ProviderCandidateEvidence => {
    const entry = entries.get(assessment.id);
    if (!entry) return { id: assessment.id, eligible: false, selected: false,
      exclusion: { code: 'unknown_provider', message: 'The candidate is absent from the frozen provider catalogue.' } };
    const candidate: ProviderCandidateEvidence = { id: entry.id, provider: entry.provider, eligible: true, selected: false,
      ...(assessment.fit === undefined ? {} : { fit: assessment.fit }), cost: assessment.cost ?? estimateCost(entry, assessment.fit) };
    if (!entry.enabled) exclude(candidate, 'provider_disabled', 'The provider is not explicitly enabled in the frozen catalogue.');
    else if (input.requiredCapabilities.some((capability) => !entry.capabilities.includes(capability as 'text' | 'pixels'))) exclude(candidate, 'missing_capability', 'The provider does not support every required capability.');
    else if (!entry.questionTypes.includes(input.questionType as 'choice' | 'score' | 'noul')) exclude(candidate, 'unsupported_question_type', `The provider does not support ${input.questionType} questions.`);
    else if (assessment.ready === false) exclude(candidate, 'provider_unavailable', 'The configured provider is not currently ready.');
    else if (assessment.ready !== true) exclude(candidate, 'provider_readiness_unverified', 'Current provider readiness was not established.');
    else if (!assessment.fit || assessment.fit.status === 'unavailable') exclude(candidate, 'fit_unavailable', assessment.fit?.reason ?? 'Provider fit could not be measured.');
    else if (assessment.fit.status === 'overflow') exclude(candidate, 'provider_overflow', assessment.fit.reason ?? 'The complete packet exceeds this provider’s context limit.');
    else if (!Number.isSafeInteger(assessment.plannedCalls) || assessment.plannedCalls < 1) exclude(candidate, 'call_plan_invalid', 'The candidate call plan is invalid.');
    else if (assessment.plannedCalls > input.remainingCalls) exclude(candidate, 'call_allowance_exceeded', 'The candidate plan exceeds the remaining study call allowance.');
    return candidate;
  });
  const eligible = candidates.filter(({ eligible: fits }) => fits);
  const unitOverride = input.unitOverride ?? input.unitOverrides?.[input.unitId];
  if (unitOverride) {
    const pinned = eligible.find(({ id }) => id === unitOverride);
    if (!pinned) return { candidates, decisionReason: 'binding_unit_override_ineligible' };
    pinned.selected = true;
    return { selected: pinned, candidates, decisionReason: 'binding_unit_override' };
  }
  if (eligible.length === 0) return { candidates, decisionReason: 'no_eligible_provider' };

  const requestOrder = input.preferredOrder ?? [];
  const savedOrder = input.preferences.preferredOrder;
  const requestMatch = requestOrder.map((id, index) => ({ candidate: eligible.find((value) => value.id === id), index })).find(({ candidate }) => candidate);
  const savedMatch = savedOrder.map((id, index) => ({ candidate: eligible.find((value) => value.id === id), index })).find(({ candidate }) => candidate);
  if (requestMatch?.candidate) {
    requestMatch.candidate.preferenceRank = { source: 'request', index: requestMatch.index };
    requestMatch.candidate.selected = true;
    return { selected: requestMatch.candidate, candidates, decisionReason: 'request_preference' };
  }
  if (savedMatch?.candidate) {
    savedMatch.candidate.preferenceRank = { source: 'saved', index: savedMatch.index };
    savedMatch.candidate.selected = true;
    return { selected: savedMatch.candidate, candidates, decisionReason: 'saved_user_preference' };
  }

  const local = eligible.find((candidate) => candidate.cost?.kind === 'no-provider-invoice');
  if (local) {
    local.selected = true;
    return { selected: local, candidates, decisionReason: 'local_execution_without_provider_invoice' };
  }
  const hosted = eligible.filter((candidate) => candidate.cost?.kind !== 'no-provider-invoice');
  const currencies = new Set(hosted.filter((candidate) => candidate.cost?.kind === 'estimate').map((candidate) => (candidate.cost as Extract<CandidateCost, { kind: 'estimate' }>).currency));
  let orderedHosted: ProviderCandidateEvidence[];
  if (hosted.length && hosted.every((candidate) => candidate.cost?.kind === 'estimate') && currencies.size === 1) {
    orderedHosted = [...hosted].sort((left, right) => (left.cost as Extract<CandidateCost, { kind: 'estimate' }>).amount - (right.cost as Extract<CandidateCost, { kind: 'estimate' }>).amount ||
      input.catalogue.entries.findIndex(({ id }) => id === left.id) - input.catalogue.entries.findIndex(({ id }) => id === right.id));
    for (const candidate of orderedHosted) if (candidate.cost?.kind === 'estimate') candidate.cost.basis = 'published-rate estimate';
  } else {
    if (currencies.size > 1) for (const candidate of hosted) candidate.cost = { kind: 'unknown', basis: 'incomparable currency' };
    orderedHosted = [...hosted].sort((left, right) => input.catalogue.entries.findIndex(({ id }) => id === left.id) - input.catalogue.entries.findIndex(({ id }) => id === right.id));
  }
  const selected = orderedHosted[0]!;
  selected.selected = true;
  return { selected, candidates, decisionReason: selected.cost?.kind === 'estimate' ? 'lowest_comparable_published_rate_estimate' : 'stable_catalogue_order_cost_unverified' };
}
