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

export type ProviderComparisonLockInput = {
  id: string;
  equality: { provider: 'same' | 'vary'; model: 'same' | 'vary' };
  members: ProviderSelectionInput[];
};
export type ProviderComparisonLockResult = {
  id: string;
  memberIds: string[];
  treatmentDimensions: Array<'provider' | 'model'>;
  decisionReason: string;
  selected?: ProviderCandidateEvidence;
  candidates: ProviderCandidateEvidence[];
  members?: Array<{ unitId: string; selection: ProviderSelectionResult }>;
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

export function selectProviderComparisonLock(input: ProviderComparisonLockInput): ProviderComparisonLockResult {
  const memberIds = input.members.map(({ unitId }) => unitId);
  const treatmentDimensions = [
    ...(input.equality.provider === 'vary' ? ['provider' as const] : []),
    ...(input.equality.model === 'vary' ? ['model' as const] : []),
  ];
  if (input.members.length < 2 || new Set(memberIds).size !== memberIds.length) {
    return { id: input.id, memberIds, treatmentDimensions, decisionReason: 'comparison_members_invalid', candidates: [] };
  }
  if (treatmentDimensions.length) {
    const dimensions = (entry: ProviderCatalogueEntry) => {
      const providerConfig = { ...entry.provider } as Record<string, unknown>;
      const model = providerConfig.model ?? providerConfig.checkpoint;
      delete providerConfig.model;
      delete providerConfig.checkpoint;
      return { provider: JSON.stringify(providerConfig), model: typeof model === 'string' ? model : '' };
    };
    const shared = (['provider', 'model'] as const).filter((dimension) => input.equality[dimension] === 'same');
    const first = input.members[0]!;
    const keys = [...new Set(first.catalogue.entries.map((entry) => JSON.stringify(shared.map((dimension) => dimensions(entry)[dimension]))))];
    const viableGroups: Array<{ selections: NonNullable<ProviderComparisonLockResult['members']>; rank: number[]; key: string }> = [];
    for (const key of keys) {
      const groupEntries = first.catalogue.entries.filter((entry) => JSON.stringify(shared.map((dimension) => dimensions(entry)[dimension])) === key);
      const selections = input.members.map((member) => {
        if (member.catalogue.revision !== first.catalogue.revision || JSON.stringify(member.catalogue.entries) !== JSON.stringify(first.catalogue.entries)) {
          return { unitId: member.unitId, selection: { candidates: [], decisionReason: 'comparison_catalogue_mismatch' } as ProviderSelectionResult };
        }
        const candidateIds = new Set(groupEntries.map(({ id }) => id));
        return { unitId: member.unitId, selection: selectProvider({ ...member, candidates: member.candidates.filter(({ id }) => candidateIds.has(id)) }) };
      });
      if (selections.every(({ selection }) => selection.selected)) {
        const preferencePenalty = selections.reduce((sum, { selection }) => sum + (selection.decisionReason === 'request_preference' ? 0 : selection.decisionReason === 'saved_user_preference' ? 1 : 2), 0);
        const variedProviderCount = input.equality.provider === 'vary' ? new Set(selections.map(({ selection }) => {
          const selected = first.catalogue.entries.find(({ id }) => id === selection.selected!.id)!;
          return dimensions(selected).provider;
        })).size : 0;
        const variedModelCount = input.equality.model === 'vary' ? new Set(selections.map(({ selection }) => {
          const selected = first.catalogue.entries.find(({ id }) => id === selection.selected!.id)!;
          return dimensions(selected).model;
        })).size : 0;
        viableGroups.push({ selections, key, rank: [preferencePenalty, -(variedProviderCount + variedModelCount)] });
      }
    }
    viableGroups.sort((left, right) => left.rank[0]! - right.rank[0]! || left.rank[1]! - right.rank[1]! || keys.indexOf(left.key) - keys.indexOf(right.key));
    const chosenGroup = viableGroups[0];
    if (chosenGroup) {
      const selectedIds = chosenGroup.selections.map(({ selection }) => selection.selected!.id);
      const displayCandidates = [...new Set(selectedIds)].map((id) => {
        const entry = first.catalogue.entries.find((candidate) => candidate.id === id)!;
        const fit = chosenGroup.selections.find(({ selection }) => selection.selected?.id === id)?.selection.selected?.fit;
        const cost = aggregateCandidateCost(input.members.map((member) => member.candidates.find((candidate) => candidate.id === id)?.cost));
        return { id, provider: entry.provider, eligible: true, selected: selectedIds[0] === id,
          ...(fit === undefined ? {} : { fit }), ...(cost === undefined ? {} : { cost }) };
      });
      return { id: input.id, memberIds, treatmentDimensions, decisionReason: 'comparison_treatment_dimensions_locked',
        selected: displayCandidates.find(({ id: candidateId }) => candidateId === selectedIds[0])!, candidates: displayCandidates, members: chosenGroup.selections };
    }
    return { id: input.id, memberIds, treatmentDimensions, decisionReason: 'comparison_treatment_ineligible', candidates: [],
      members: input.members.map((member) => ({ unitId: member.unitId, selection: { candidates: [], decisionReason: 'no_common_comparison_lock' } })) };
  }
  const pins = [...new Set(input.members.map((member) => member.unitOverride ?? member.unitOverrides?.[member.unitId]).filter((id): id is string => id !== undefined))];
  if (pins.length > 1) return { id: input.id, memberIds, treatmentDimensions, decisionReason: 'binding_comparison_pins_conflict', candidates: [] };
  const first = input.members[0]!;
  const catalogue = first.catalogue;
  const requiredCapabilities = [...new Set(input.members.flatMap(({ requiredCapabilities: required }) => required))];
  const questionTypes = [...new Set(input.members.map(({ questionType }) => questionType))];
  const candidates = catalogue.entries.map((entry) => {
    const memberSelections = input.members.map((member) => selectProvider({ ...member, unitOverride: entry.id }));
    const eligibleForAll = memberSelections.every((selection) => selection.selected?.id === entry.id) &&
      input.members.every(({ catalogue: memberCatalogue }) => memberCatalogue.revision === catalogue.revision &&
        JSON.stringify(memberCatalogue.entries) === JSON.stringify(catalogue.entries));
    const fits = memberSelections.map(({ selected }) => selected?.fit);
    const rejectedFit = memberSelections.map(({ candidates: memberCandidates }) => memberCandidates.find(({ id }) => id === entry.id)?.fit).find((fit) => fit?.status !== 'fits');
    const fit = eligibleForAll && fits.every((value): value is ProviderContextFit => value?.status === 'fits')
      ? { ...fits[0]!, tokens: fits.reduce((sum, value) => sum + value.tokens, 0), details: { lockMembers: fits.length, totalInputTokens: fits.reduce((sum, value) => sum + value.tokens, 0) } }
      : rejectedFit && rejectedFit.status !== 'fits' ? rejectedFit : undefined;
    const plans = input.members.map((member) => member.candidates.find(({ id }) => id === entry.id));
    const plannedCalls = plans.every((plan) => plan !== undefined) ? plans.reduce((sum, plan) => sum + plan!.plannedCalls, 0) : 0;
    const cost = aggregateCandidateCost(plans.map((plan) => plan?.cost));
    const ready = eligibleForAll ? true : memberSelections.every((selection) => selection.candidates.find(({ id }) => id === entry.id)?.exclusion?.code !== 'provider_unavailable' &&
      selection.candidates.find(({ id }) => id === entry.id)?.exclusion?.code !== 'provider_readiness_unverified');
    return { id: entry.id, ready, ...(fit === undefined ? {} : { fit }), plannedCalls, ...(cost === undefined ? {} : { cost }) };
  });
  const remainingCalls = Math.min(...input.members.map(({ remainingCalls: remaining }) => remaining));
  const selectionInput: ProviderSelectionInput = { ...first, requiredCapabilities, questionType: questionTypes[0]!, remainingCalls, candidates };
  delete selectionInput.unitOverride;
  delete selectionInput.unitOverrides;
  if (pins[0]) selectionInput.unitOverride = pins[0];
  const result = selectProvider(selectionInput);
  return { id: input.id, memberIds, treatmentDimensions, decisionReason: result.decisionReason,
    ...(result.selected === undefined ? {} : { selected: result.selected }), candidates: result.candidates };
}

function aggregateCandidateCost(costs: Array<CandidateCost | undefined>): CandidateCost | undefined {
  if (costs.some((cost) => cost === undefined)) return undefined;
  if (costs.every((cost) => cost?.kind === 'no-provider-invoice')) return { kind: 'no-provider-invoice', basis: 'provider pricing contract' };
  const estimates = costs.filter((cost): cost is Extract<CandidateCost, { kind: 'estimate' }> => cost?.kind === 'estimate');
  if (estimates.length === costs.length && new Set(estimates.map(({ currency }) => currency)).size === 1) {
    const first = estimates[0]!;
    return { ...first, amount: estimates.reduce((sum, { amount }) => sum + amount, 0), basis: 'published-rate estimate' };
  }
  return { kind: 'unknown', basis: new Set(estimates.map(({ currency }) => currency)).size > 1 ? 'incomparable currency' : 'unverified' };
}
