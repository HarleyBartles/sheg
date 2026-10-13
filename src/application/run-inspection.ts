import { createHash, randomUUID } from 'node:crypto';
import { compileDecisionPacket, compileDecisionRequest, emptyTrajectory, prepareFollowOnPacket, promptContractHash } from '../domain/decision/prompt.js';
import { decisionValueFromResult } from '../domain/decision/decision.js';
import type { DecisionProvider, ProviderContextFit } from '../domain/decision/provider.js';
import type { DecisionBatchRequest, DecisionQuestion, DecisionRequest } from '../domain/decision/decision.js';
import type { ProviderKind } from '../domain/decision/provider.js';
import { requireExplicitProvider, runRequestSchema, type FrozenEvaluation, type PreparedRun, type ParsedInlineRunRequest, type ParsedInlineJourneyRequest, type ParsedFollowOnRunRequest, type FollowOnSourceSet, type FollowOnLineage, type RunMaterialItem, type FollowOnSelectionExclusion, type SelectionCoverage } from '../domain/run/request.js';
import type { Inspection, RunProblem } from '../domain/run/lifecycle.js';
import type { JourneyRespondentState } from '../domain/run/lifecycle.js';
import type { PreparedJourneyRun } from '../domain/run/request.js';
import { hashCanonical } from '../infrastructure/identity.js';
import type { PreflightPacket } from '../domain/journey/packet-walker.js';
import { estimateRunDecisionCalls } from '../domain/journey/route-bounds.js';
import { journeyTopology } from '../domain/journey/topology.js';
import { isImageMaterial } from '../domain/study/stimulus.js';
import { assessProviderBatchPlan } from './provider-batch-planning.js';
import { assessAndSelectProviderBatches, type ProviderBatchCandidate, type ProviderBatchPlan } from './provider-batch-planning.js';
import { selectProvider, selectProviderComparisonLock, type ProviderSelectionInput, type ProviderSelectionResult } from './provider-selection.js';
import type { ProviderCatalogue, ProviderPreference } from '../providers/config.js';
import { providerModelIdentity } from '../providers/config.js';

export type { Inspection } from '../domain/run/lifecycle.js';
export type { FrozenEvaluation, InlineRunRequest, PreparedRun } from '../domain/run/request.js';
export type PreparedJourneyAdmission = { request: ParsedInlineJourneyRequest; requestFingerprint: string; compilerFingerprint: string; minimumCalls: number; maximumCalls: number; packets: PreflightPacket[] };
export type PreparedFollowOnAdmission = { prepared: PreparedRun; inspection: Inspection; sourceVersion: FollowOnSourceSet['version'] };
type QuestionGroup = { groupId: string; contextId: string; respondentId: string; state: DecisionBatchRequest['state']; questions: readonly DecisionQuestion[]; packets: readonly DecisionRequest[] };

function mergeMaterials(...collections: readonly (readonly RunMaterialItem[])[]): RunMaterialItem[] {
  const merged = new Map<string, RunMaterialItem>();
  for (const collection of collections) for (const item of collection) {
    const previous = merged.get(item.id);
    if (previous && (previous.text !== item.text || previous.sourceId && item.sourceId && previous.sourceId !== item.sourceId || previous.sourceSha256 && item.sourceSha256 && previous.sourceSha256 !== item.sourceSha256)) {
      throw new RunProblemError('follow_on_material_conflict', `Material ${item.id} has conflicting text or source provenance in the selected context.`);
    }
    merged.set(item.id, previous ? { ...previous, ...(item.sourceId === undefined ? {} : { sourceId: item.sourceId }), ...(item.sourceSha256 === undefined ? {} : { sourceSha256: item.sourceSha256 }) } : { ...item });
  }
  return [...merged.values()];
}

function validateFollowOnMaterialChoices(request: ParsedFollowOnRunRequest, materials: readonly RunMaterialItem[], evaluationId: string): void {
  const byId = new Map(materials.map((item) => [item.id, item]));
  for (const question of request.questions) {
    if (question.type !== 'choice' || !question.materialOptions) continue;
    for (const [optionId, materialId] of Object.entries(question.materialOptions)) {
      const candidate = byId.get(materialId);
      if (!candidate) throw new RunProblemError('follow_on_material_not_found', `Material ${materialId} is not available in evaluation ${evaluationId}.`);
      if (candidate.sourceId === undefined || candidate.sourceSha256 === undefined) throw new RunProblemError('follow_on_material_unprovenanced', `Material ${materialId} has no source identity and digest in evaluation ${evaluationId}.`);
      if (question.options[optionId] !== candidate.text) throw new RunProblemError('follow_on_material_mismatch', `Choice option ${optionId} does not exactly match material ${materialId} in evaluation ${evaluationId}.`);
    }
  }
}

export async function prepareFollowOnRun(request: ParsedFollowOnRunRequest, source: FollowOnSourceSet, provider: DecisionProvider): Promise<PreparedFollowOnAdmission> {
  const configured = requireExplicitProvider(request);
  const compilerFingerprint = promptContractHash();
  const fits: Inspection['fits'] = [];
  const problems: RunProblem[] = [];
  const evaluations: FrozenEvaluation[] = [];
  const preparedGroups: NonNullable<PreparedRun['groups']> = [];
  const groups = new Map<string, { representative: FollowOnSourceSet['turns'][number]; turns: FollowOnSourceSet['turns'] }>();
  const selectionExclusions: FollowOnSelectionExclusion[] = [];
  const excludedCounts: SelectionCoverage['excluded'] = { pending: 0, failed: 0, unreached: 0, nonChoice: 0, unmappedChoice: 0 };
  for (const turn of source.turns) {
    if (request.context.includeSelectedMaterial) {
      let reason: FollowOnSelectionExclusion['reason'] | undefined;
      if (turn.status === 'pending' || turn.status === 'failed' || turn.status === 'unreached') reason = turn.status;
      else if (turn.result?.type !== 'choice') reason = 'nonChoice';
      else if (!turn.selectedMaterial) reason = 'unmappedChoice';
      if (reason) {
        excludedCounts[reason] += 1;
        selectionExclusions.push({ sourceEvaluationId: turn.evaluationId, sourceContextId: turn.contextId, respondentId: turn.respondentId,
          status: turn.status, reason, ...(turn.result?.type === 'choice' ? { choiceId: turn.result.choice, choiceMeaning: turn.packet.question.type === 'choice' ? turn.packet.question.options[turn.result.choice] : undefined } : {}) });
        continue;
      }
    }
    const groupKey = request.context.includeSelectedMaterial ? `evaluation:${turn.evaluationId}:${turn.contextId}`
      : request.context.mode === 'continue' ? `evaluation:${turn.evaluationId}` : `context:${turn.respondentId}:${turn.contextId}`;
    const group = groups.get(groupKey) ?? { representative: turn, turns: [] };
    group.turns.push(turn);
    groups.set(groupKey, group);
  }
  const selections: FollowOnLineage['selections'] = [];
  const materialSnapshots: FollowOnLineage['materialSnapshots'] = [];
  let minimumCalls = 0;
  for (const { representative: turn, turns } of groups.values()) {
    let selectedMaterial = [...(request.material ?? [])];
    const sourceMaterials = mergeMaterials(turn.materials ?? [], turn.packet.state.encounteredItems);
    const catalog = mergeMaterials(sourceMaterials, request.material ?? []);
    validateFollowOnMaterialChoices(request, catalog, turn.evaluationId);
    if (request.context.materialIds) {
      const referencedMaterial: Array<{ id: string; text: string }> = [];
      for (const id of request.context.materialIds) {
        const item = catalog.find((candidate) => candidate.id === id);
        if (!item) throw new RunProblemError('follow_on_material_not_found', `Material ${id} is not available in evaluation ${turn.evaluationId}.`);
        referencedMaterial.push(item);
      }
      selectedMaterial = [...referencedMaterial, ...selectedMaterial];
    }
    if (request.context.includeSelectedMaterial && turn.selectedMaterial) {
      selectedMaterial = mergeMaterials(selectedMaterial, [{ id: turn.selectedMaterial.materialId, text: turn.selectedMaterial.text, sourceId: turn.selectedMaterial.sourceId, sourceSha256: turn.selectedMaterial.sourceSha256 }]);
    }
    const rawResult = turn.result ? decisionValueFromResult(turn.result) : undefined;
    const packets: DecisionRequest[] = [];
    try {
      for (const question of request.questions) {
        packets.push(prepareFollowOnPacket({ source: turn.packet, mode: request.context.mode, question,
          ...(request.context.mode === 'recorded' ? {} : { material: selectedMaterial }), ...(rawResult ? { result: rawResult } : {}) }));
      }
    } catch (error) {
      throw new RunProblemError('follow_on_context_invalid', error instanceof Error ? error.message : 'Follow-on context could not be prepared.');
    }
    const modelIdentity = configured.kind === 'jev' || configured.kind === 'clef' ? configured.model : configured.checkpoint;
    const contextId = randomUUID(); const groupId = randomUUID();
    const planned = await planQuestionBatches({ groupId, contextId, respondentId: turn.respondentId, state: packets[0]!.state, questions: request.questions, packets }, provider, configured.kind, modelIdentity, request.providerSelection?.batching ?? 'automatic');
    minimumCalls += planned.batches.length;
    fits.push(...planned.fits);
    problems.push(...planned.problems);
    const groupEvaluations: FrozenEvaluation[] = packets.map((packet) => {
      const evaluation = { groupId, evaluationId: randomUUID(), contextId, respondentId: turn.respondentId,
        questionId: packet.question.id, packet, packetFingerprint: hashCanonical({ packet, compilerFingerprint }) };
      evaluations.push(evaluation);
      return evaluation;
    });
    const linkedMaterialIds = new Set(request.questions.flatMap((question) => question.type === 'choice' ? Object.values(question.materialOptions ?? {}) : []));
    const linkedMaterials = [...linkedMaterialIds].map((id) => {
      const item = catalog.find((candidate) => candidate.id === id);
      if (!item) throw new RunProblemError('follow_on_material_not_found', `Material ${id} is not available in evaluation ${turn.evaluationId}.`);
      return item;
    });
    materialSnapshots.push({ contextId, respondentId: turn.respondentId,
      materials: request.context.includeSelectedMaterial ? mergeMaterials(selectedMaterial, linkedMaterials) : mergeMaterials(catalog, selectedMaterial) });
    preparedGroups.push({ groupId, contextId, respondentId: turn.respondentId, state: packets[0]!.state, questionIds: request.questions.map(({ id }) => id) });
    for (const sourceTurn of turns) for (const evaluation of groupEvaluations) {
      selections.push({ sourceEvaluationId: sourceTurn.evaluationId, sourceContextId: sourceTurn.contextId,
        respondentId: sourceTurn.respondentId, evaluationId: evaluation.evaluationId, contextId: evaluation.contextId,
        ...(request.context.includeSelectedMaterial && sourceTurn.selectedMaterial ? { selectedMaterial: sourceTurn.selectedMaterial } : {}) });
    }
  }
  if (groups.size === 0) problems.push({ code: 'no_follow_on_matches', message: 'No source evaluations match this follow-on selection.' });
  if (minimumCalls > request.maxCalls) problems.push({ code: 'insufficient_call_limit', message: `maxCalls (${request.maxCalls}) is below the planned physical request minimum (${minimumCalls}).` });
  const sourceWarning = source.sourceComplete ? undefined : {
    code: 'source_incomplete',
    message: ['prepared', 'running'].includes(source.sourceStatus)
      ? `${groups.size} respondent contexts match so far. Source run is ${source.sourceStatus}; more may match after it completes.`
      : `Source run is ${source.sourceStatus} and incomplete. This follow-on uses the evidence currently recorded.`,
  };
  const selectionCoverage: SelectionCoverage | undefined = request.context.includeSelectedMaterial ? {
    matched: source.turns.length, eligible: groups.size, excluded: excludedCounts,
  } : undefined;
  const inspection: Inspection = { valid: problems.length === 0, respondentCount: groups.size, minimumCalls, problems, fits,
    ...(selectionCoverage ? { selectionCoverage, selectionExclusions } : {}),
    ...(sourceWarning ? { warnings: [sourceWarning] } : {}) };
  const lineage: FollowOnLineage = { sourceRunId: source.sourceRunId, sourceStatusAtAcceptance: source.sourceStatus,
    sourceCompleteAtAcceptance: source.sourceComplete, sourceVersion: source.version, selections, materialSnapshots,
    ...(selectionCoverage ? { selectionCoverage } : {}), excludedSelections: selectionExclusions };
  return { sourceVersion: source.version, inspection,
    prepared: { request, requestFingerprint: hashCanonical({ request, compilerFingerprint }), compilerFingerprint, evaluations, groups: preparedGroups, lineage } };
}

class RunProblemError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'RunProblemError'; }
}

export function materializeJourneyRun(admission: PreparedJourneyAdmission): PreparedJourneyRun {
  const { request, requestFingerprint, compilerFingerprint, packets } = admission;
  const evaluations: PreparedJourneyRun['evaluations'] = [];
  const respondents: JourneyRespondentState[] = [];
  let ordinal = 0;
  for (const profile of request.respondents) {
    const firstPacket = packets.find((packet) => packet.respondentId === profile.id);
    if (!firstPacket) throw new Error(`Journey has no initial ask packet for respondent ${profile.id}.`);
    const evaluationId = randomUUID();
    const contextId = randomUUID();
    const turnId = randomUUID();
    const evaluation = {
      evaluationId, contextId, respondentId: profile.id, questionId: firstPacket.request.question.id,
      packet: firstPacket.request, packetFingerprint: hashCanonical({ packet: firstPacket.request, compilerFingerprint }),
      turnId, nodeId: firstPacket.nodeId, pathId: firstPacket.pathId, occurrence: 1, ordinal: ordinal++,
    };
    evaluations.push(evaluation);
    const events = initialJourneyPath(request.journey).events;
    respondents.push({
      respondentId: profile.id, status: 'active', currentNodeId: firstPacket.nodeId, currentTurnId: turnId,
      currentContextId: contextId, revision: 0, events, route: [],
    });
  }
  return { request, requestFingerprint, compilerFingerprint, evaluations, respondents };
}

function initialJourneyPath(arm: ParsedInlineJourneyRequest['journey']): { events: JourneyRespondentState['events']; nodeId: string; taskId: string } {
  const events: JourneyRespondentState['events'] = [];
  const graph = journeyTopology(arm);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  let current = graph.entryNodeId;
  while (true) {
    const node = nodes.get(current);
    if (!node) throw new Error(`Journey points to unknown node ${current}.`);
    if (node.kind === 'ask') return { events, nodeId: node.id, taskId: node.taskId };
    if (node.kind === 'terminal') throw new Error('Journey must reach an ask node before a terminal node.');
    events.push({ type: 'exposure', sequence: events.length, nodeId: node.id, itemId: node.itemId });
    const edge = graph.transitions.find((candidate) => candidate.fromNodeId === node.id);
    if (!edge) throw new Error(`Exposure node ${node.id} has no transition.`);
    current = edge.toNodeId;
  }
}

export function fingerprintRunRequest(input: unknown): string | undefined {
  const parsed = runRequestSchema.safeParse(input);
  if (!parsed.success) return undefined;
  return hashCanonical({ request: parsed.data, compilerFingerprint: promptContractHash() });
}

function invalidRequestInspection(input: unknown, message: string): Inspection {
  const respondents = typeof input === 'object' && input !== null && 'respondents' in input && Array.isArray(input.respondents)
    ? input.respondents
    : [];
  return {
    valid: false,
    respondentCount: respondents.length,
    minimumCalls: respondents.length,
    problems: [{ code: 'invalid_request', message }],
    fits: [],
  };
}

function missingMeasureFit(provider: DecisionProvider, kind: ProviderKind, modelIdentity: string): ProviderContextFit {
  return {
    provider: kind,
    status: 'unavailable',
    method: 'unavailable',
    modelIdentity,
    tokenCount: 'estimated',
    tokens: 0,
    contextLimit: null,
    headroomTokens: null,
    effectiveLimit: null,
    details: {},
    reason: 'provider-measurement-unavailable',
  };
}

function problemForFit(respondentId: string, fit: ProviderContextFit): RunProblem | undefined {
  if (fit.status === 'fits') return undefined;
  return {
    code: fit.status === 'overflow' ? 'context_overflow' : 'context_unavailable',
    respondentId,
    message: fit.reason ?? `Provider context ${fit.status}.`,
  };
}

export async function prepareRun(
  input: unknown,
  provider: DecisionProvider,
): Promise<{ inspection: Inspection; prepared?: PreparedRun; journey?: PreparedJourneyAdmission }> {
  const parsed = runRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { inspection: invalidRequestInspection(input, parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')) };
  }

  const request = parsed.data;
  if (request.kind === 'journey') return prepareJourneyAdmission(request, provider);
  if (request.kind === 'follow-on') {
    return { inspection: { valid: false, respondentCount: 0, minimumCalls: 0,
      problems: [{ code: 'follow_on_resolution_required', message: 'Follow-on requests must be resolved against their source run before provider fit inspection.' }], fits: [] } };
  }
  const configured = requireExplicitProvider(request);

  const compilerFingerprint = promptContractHash();
  const evaluations: FrozenEvaluation[] = [];
  const preparedGroups: NonNullable<PreparedRun['groups']> = [];
  const fits: Inspection['fits'] = [];
  const problems: RunProblem[] = [];
  let minimumCalls = 0;
  const kind = configured.kind;
  const modelIdentity = kind === 'jev' || kind === 'clef' ? configured.model : configured.checkpoint;

  for (const respondent of request.respondents) {
    const respondentProfile = {
      intent: respondent.intent,
      context: respondent.context,
      desired_outcome: respondent.desired_outcome,
      engagement_cues: respondent.engagement_cues,
      friction_cues: respondent.friction_cues,
    };
    const materialOrder = request.material.map(({ id }) => id);
    const packets = request.questions.map((question) => {
      const bound = new Set(question.visual?.materialIds ?? []);
      const visualMaterials = request.material.flatMap((item) => isImageMaterial(item) && bound.has(item.id)
        ? [{ id: item.id, asset: item.asset, altText: item.altText, ...(item.caption === undefined ? {} : { caption: item.caption }) }]
        : []);
      return compileDecisionRequest({ respondentProfile, encounteredItems: request.material.filter((item) => !isImageMaterial(item)).map(({ id, text }) => ({ id, text })),
        materialOrder, visualMaterials, trajectory: emptyTrajectory(), question });
    });
    const contextId = randomUUID();
    const groupId = randomUUID();
    preparedGroups.push({ groupId, contextId, respondentId: respondent.id, state: packets[0]!.state, questionIds: request.questions.map(({ id }) => id) });
    const planned = await planQuestionBatches({ groupId, contextId, respondentId: respondent.id, state: packets[0]!.state, questions: request.questions, packets }, provider, kind, modelIdentity, request.providerSelection?.batching ?? 'automatic');
    minimumCalls += planned.batches.length;
    fits.push(...planned.fits);
    problems.push(...planned.problems);
    for (const packet of packets) {
      evaluations.push({
        groupId, evaluationId: randomUUID(), contextId, respondentId: respondent.id,
        questionId: packet.question.id, packet,
        packetFingerprint: hashCanonical({ packet, compilerFingerprint }),
      });
    }
  }
  if (request.maxCalls < minimumCalls) {
    problems.push({ code: 'insufficient_call_limit', message: `maxCalls (${request.maxCalls}) is below the planned physical request minimum (${minimumCalls}).` });
  }

  const inspection: Inspection = {
    valid: problems.length === 0,
    respondentCount: request.respondents.length,
    minimumCalls,
    problems,
    fits,
  };
  if (!inspection.valid) return { inspection };

  const prepared: PreparedRun = {
    request,
    requestFingerprint: hashCanonical({ request, compilerFingerprint }),
    compilerFingerprint,
    evaluations,
    groups: preparedGroups,
  };
  return { inspection, prepared };
}

export async function prepareAutomaticallySelectedPoll(
  request: Extract<ParsedInlineRunRequest, { kind: 'poll' }>,
  settings: { catalogue: ProviderCatalogue; preferences: ProviderPreference },
  providerCandidates: ProviderBatchCandidate[],
): Promise<{ inspection: Inspection; prepared?: PreparedRun }> {
  const compilerFingerprint = promptContractHash();
  const batching = request.providerSelection?.batching ?? 'automatic';
  const groups: Array<QuestionGroup & { unitId: string; input: ProviderSelectionInput; plans: Record<string, ProviderBatchPlan> }> = [];
  const evaluations: FrozenEvaluation[] = [];
  const preparedGroups: NonNullable<PreparedRun['groups']> = [];
  const problems: RunProblem[] = [];
  for (const respondent of request.respondents) {
    const respondentProfile = { intent: respondent.intent, context: respondent.context, desired_outcome: respondent.desired_outcome,
      engagement_cues: respondent.engagement_cues, friction_cues: respondent.friction_cues };
    const materialOrder = request.material.map(({ id }) => id);
    const packets = request.questions.map((question) => {
      const bound = new Set(question.visual?.materialIds ?? []);
      const visualMaterials = request.material.flatMap((item) => isImageMaterial(item) && bound.has(item.id)
        ? [{ id: item.id, asset: item.asset, altText: item.altText, ...(item.caption === undefined ? {} : { caption: item.caption }) }]
        : []);
      return compileDecisionRequest({ respondentProfile, encounteredItems: request.material.filter((item) => !isImageMaterial(item)).map(({ id, text }) => ({ id, text })),
        materialOrder, visualMaterials, trajectory: emptyTrajectory(), question });
    });
    const groupId = randomUUID();
    const contextId = randomUUID();
    const questionIds = request.questions.map(({ id }) => id);
    const unitId = `${respondent.id}/${questionIds.join('+')}`;
    const group: QuestionGroup = { groupId, contextId, respondentId: respondent.id, state: packets[0]!.state, questions: request.questions, packets };
    const requiredCapabilities = [...new Set(['text', ...(request.providerSelection?.requiredCapabilities ?? []),
      ...(packets.some(({ visualMaterials: visual }) => (visual?.length ?? 0) > 0) ? ['pixels'] : [])])];
    const explicitPins = [...new Set([request.providerSelection?.unitOverrides?.[unitId], ...questionIds.flatMap((questionId) => [request.providerSelection?.unitOverrides?.[`${respondent.id}/${questionId}`], request.providerSelection?.unitOverrides?.[questionId]])].filter((id): id is string => id !== undefined))];
    if (explicitPins.length > 1) problems.push({ code: 'comparison_unit_pins_conflict', respondentId: respondent.id, message: `Questions in shared respondent group ${unitId} have conflicting provider pins.` });
    const preferredOrder = request.providerSelection?.preferredOrder;
    const assessed = await assessAndSelectProviderBatches({ catalogue: settings.catalogue, preferences: settings.preferences, unitId,
      requiredCapabilities, questionType: request.questions[0]!.type, questionTypes: [...new Set(request.questions.map(({ type }) => type))],
      remainingCalls: request.maxCalls, group, candidates: providerCandidates, batching,
      ...(preferredOrder === undefined ? {} : { preferredOrder }), ...(explicitPins[0] === undefined ? {} : { unitOverride: explicitPins[0] }) });
    const inputCandidates = assessed.selection.candidates.map((candidate) => ({ id: candidate.id,
      ready: providerCandidates.some((provider) => provider.id === candidate.id && provider.ready),
      ...(candidate.fit === undefined ? {} : { fit: candidate.fit }),
      plannedCalls: assessed.plans[candidate.id]?.minimumCalls ?? 1,
      ...(assessed.plans[candidate.id] === undefined ? {} : { cost: assessed.plans[candidate.id]!.cost }),
    }));
    const input: ProviderSelectionInput = { catalogue: settings.catalogue, preferences: settings.preferences, unitId, requiredCapabilities,
      questionType: request.questions[0]!.type, questionTypes: [...new Set(request.questions.map(({ type }) => type))], candidates: inputCandidates,
      remainingCalls: request.maxCalls, ...(preferredOrder === undefined ? {} : { preferredOrder }),
      ...(explicitPins[0] === undefined ? {} : { unitOverride: explicitPins[0] }) };
    groups.push({ ...group, unitId, input, plans: assessed.plans });
    preparedGroups.push({ groupId, contextId, respondentId: respondent.id, state: packets[0]!.state, questionIds });
    for (const packet of packets) evaluations.push({ groupId, evaluationId: randomUUID(), contextId, respondentId: respondent.id,
      questionId: packet.question.id, packet, packetFingerprint: hashCanonical({ packet, compilerFingerprint }) });
  }

  const selectionByGroup = new Map<string, { result: ProviderSelectionResult; lockId?: string }>();
  const comparisonLocks = request.providerSelection?.comparisonLocks ?? [];
  const lockByGroup = new Map<string, typeof comparisonLocks[number]>();
  const groupFor = (respondentId: string, questionId: string) => groups.find((group) => group.respondentId === respondentId && group.questions.some((question) => question.id === questionId));
  for (const lock of comparisonLocks) for (const member of lock.members) {
    if (member.branchId) continue;
    const group = groupFor(member.respondentId, member.questionId);
    if (!group) continue;
    if (lockByGroup.has(group.groupId) && lockByGroup.get(group.groupId)?.id !== lock.id) {
      problems.push({ code: 'comparison_unit_in_multiple_locks', respondentId: member.respondentId, message: `Respondent group ${group.unitId} belongs to more than one provider comparison.` });
    } else lockByGroup.set(group.groupId, lock);
  }

  const fits: Inspection['fits'] = [];
  let remainingCalls = request.maxCalls;
  for (const group of groups) {
    if (selectionByGroup.has(group.groupId)) continue;
    const lock = lockByGroup.get(group.groupId);
    const lockGroups = lock ? [...new Set(lock.members.flatMap((member) => member.branchId ? [] : [groupFor(member.respondentId, member.questionId)?.groupId]).filter((id): id is string => id !== undefined))]
      .map((id) => groups.find((candidate) => candidate.groupId === id)!).filter(Boolean) : [];
    if (lock && lockGroups.length > 1) {
      const lockResult = selectProviderComparisonLock({ id: lock.id, equality: lock.equality,
        members: lockGroups.map((member) => ({ ...member.input, remainingCalls })) });
      const allMemberSelections = lockGroups.map((member) => {
        const planned = lockResult.members?.find(({ unitId: selectedUnit }) => selectedUnit === member.unitId)?.selection;
        return { member, result: planned ?? (lockResult.selected ? selectProvider({ ...member.input, remainingCalls, unitOverride: lockResult.selected.id }) : undefined) };
      });
      if (allMemberSelections.every(({ result }) => result?.selected)) {
        const selectedCalls = allMemberSelections.reduce((sum, { member, result }) => sum + (member.plans[result!.selected!.id]?.minimumCalls ?? 0), 0);
        if (selectedCalls > remainingCalls) {
          problems.push({ code: 'comparison_call_allowance_exceeded', message: `Comparison ${lock.id} exceeds the remaining study-call allowance.` });
          for (const { member, result } of allMemberSelections) selectionByGroup.set(member.groupId, { result: result!, lockId: lock.id });
          continue;
        }
        for (const { member, result } of allMemberSelections) {
          selectionByGroup.set(member.groupId, { result: result!, lockId: lock.id });
          const plan = member.plans[result!.selected!.id]!;
          remainingCalls -= plan.minimumCalls;
          for (const measured of plan.fits) fits.push({ respondentId: member.respondentId, groupId: member.groupId, contextId: member.contextId,
            questionIds: measured.questionIds, fit: measured.fit });
        }
        continue;
      }
      if (!lockResult.selected && !lockResult.members?.some(({ selection }) => selection.selected)) {
        problems.push({ code: lockResult.decisionReason, message: `No common eligible provider satisfies comparison ${lock.id}.` });
        for (const member of lockGroups) selectionByGroup.set(member.groupId, { result: { candidates: lockResult.candidates, decisionReason: lockResult.decisionReason }, lockId: lock.id });
      } else if (!allMemberSelections.every(({ result }) => result?.selected)) {
        problems.push({ code: lockResult.decisionReason, message: `No common eligible provider satisfies every known member of comparison ${lock.id}.` });
        for (const { member, result } of allMemberSelections) selectionByGroup.set(member.groupId, { result: result ?? { candidates: [], decisionReason: lockResult.decisionReason }, lockId: lock.id });
      }
    } else {
      const result = selectProvider({ ...group.input, remainingCalls });
      selectionByGroup.set(group.groupId, { result, ...(lock === undefined ? {} : { lockId: lock.id }) });
    }
    const resolved = selectionByGroup.get(group.groupId);
    const selected = resolved?.result.selected;
    if (!selected) {
      const reasons = (resolved?.result.candidates ?? []).filter(({ exclusion }) => exclusion).map(({ id, exclusion }) => `${id}: ${exclusion!.code}`).join(', ');
      if (!problems.some((problem) => problem.respondentId === group.respondentId && problem.code === (resolved?.result.decisionReason ?? 'no_eligible_provider'))) {
        problems.push({ code: resolved?.result.decisionReason ?? 'no_eligible_provider', respondentId: group.respondentId,
          message: `No provider is eligible for ${group.unitId}.${reasons ? ` ${reasons}` : ''}` });
      }
      continue;
    }
    const plan = group.plans[selected.id];
    if (!plan || plan.minimumCalls > remainingCalls) {
      problems.push({ code: 'insufficient_call_limit', respondentId: group.respondentId, message: `Selected provider plan for ${group.unitId} exceeds the remaining study-call allowance.` });
      continue;
    }
    remainingCalls -= plan.minimumCalls;
    for (const measured of plan.fits) fits.push({ respondentId: group.respondentId, groupId: group.groupId, contextId: group.contextId,
      questionIds: measured.questionIds, fit: measured.fit });
  }

  const minimumCalls = request.maxCalls - remainingCalls;
  if (problems.length === 0 && groups.length !== selectionByGroup.size) problems.push({ code: 'provider_selection_incomplete', message: 'One or more known respondent groups did not receive an initial provider choice.' });
  const initialChoices = groups.flatMap((group) => {
    const resolved = selectionByGroup.get(group.groupId);
    const selected = resolved?.result.selected;
    if (!selected) return [];
    const entry = settings.catalogue.entries.find(({ id }) => id === selected.id);
    if (!entry) return [];
    const candidateEvidence = resolved!.result.candidates.map((candidate) => ({ id: candidate.id, eligible: candidate.eligible,
      selected: candidate.selected, ...(candidate.fit === undefined ? {} : { fit: candidate.fit }), ...(candidate.cost === undefined ? {} : { cost: candidate.cost }),
      ...(candidate.exclusion === undefined ? {} : { exclusion: candidate.exclusion }), ...(candidate.preferenceRank === undefined ? {} : { preferenceRank: candidate.preferenceRank }) }));
    return group.questions.map((question) => ({ respondentId: group.respondentId, questionId: question.id, providerId: selected.id,
      modelIdentity: providerModelIdentity(entry.provider), ...(resolved?.lockId === undefined ? {} : { comparisonLockId: resolved.lockId }),
      decisionReason: resolved!.result.decisionReason, candidates: candidateEvidence }));
  });
  const inspection: Inspection = { valid: problems.length === 0, respondentCount: request.respondents.length, minimumCalls, problems, fits, initialChoices };
  if (!inspection.valid) return { inspection };
  return { inspection, prepared: { request, requestFingerprint: hashCanonical({ request, compilerFingerprint }), compilerFingerprint, evaluations, groups: preparedGroups } };
}

export async function prepareAutomaticallySelectedJourney(
  request: ParsedInlineJourneyRequest,
  settings: { catalogue: ProviderCatalogue; preferences: ProviderPreference },
  providerCandidates: ProviderBatchCandidate[],
): Promise<{ inspection: Inspection; journey?: PreparedJourneyAdmission }> {
  const compilerFingerprint = promptContractHash();
  let callBounds: ReturnType<typeof estimateRunDecisionCalls>;
  try { callBounds = estimateRunDecisionCalls([request.journey], request.respondents); }
  catch (error) {
    return { inspection: { valid: false, respondentCount: request.respondents.length, minimumCalls: 0,
      problems: [{ code: 'invalid_journey', message: error instanceof Error ? error.message : 'Journey routes are invalid.' }], fits: [] } };
  }
  const problems: RunProblem[] = [];
  const warnings: RunProblem[] = [];
  if (request.maxCalls < callBounds.minimumDecisionCalls) problems.push({ code: 'insufficient_call_limit', message: `maxCalls (${request.maxCalls}) is below the journey minimum (${callBounds.minimumDecisionCalls}).` });
  else if (request.maxCalls < callBounds.maximumDecisionCalls) warnings.push({ code: 'call_limit_may_stop_journey', message: `maxCalls (${request.maxCalls}) is below the journey maximum (${callBounds.maximumDecisionCalls}); some respondents may not reach a terminal node.` });
  let initialPath: ReturnType<typeof initialJourneyPath>;
  try { initialPath = initialJourneyPath(request.journey); }
  catch (error) { return { inspection: { valid: false, respondentCount: request.respondents.length, minimumCalls: callBounds.minimumDecisionCalls,
    maximumCalls: callBounds.maximumDecisionCalls, problems: [...problems, { code: 'invalid_journey', message: error instanceof Error ? error.message : 'Journey has no initial ask packet.' }],
    ...(warnings.length === 0 ? {} : { warnings }), fits: [] } }; }
  if (!request.journey.tasks.some(({ id }) => id === initialPath.taskId)) return { inspection: { valid: false, respondentCount: request.respondents.length,
    minimumCalls: callBounds.minimumDecisionCalls, maximumCalls: callBounds.maximumDecisionCalls,
    problems: [...problems, { code: 'invalid_journey', message: `Initial ask references unknown task ${initialPath.taskId}.` }],
    ...(warnings.length === 0 ? {} : { warnings }), fits: [] } };

  const packets: PreflightPacket[] = request.respondents.map((respondent) => {
    const packetRequest = compileDecisionPacket(request.journey, respondent, initialPath.taskId, initialPath.events);
    const identity = JSON.stringify([respondent.id, request.journey.id, 'root', 1, initialPath.nodeId]);
    return { packetId: `packet-${createHash('sha256').update(identity).digest('hex')}`, respondentId: respondent.id, armId: request.journey.id,
      pathId: 'root', decisionIndex: 1, nodeId: initialPath.nodeId, request: packetRequest };
  });
  const selectionInputs: ProviderSelectionInput[] = [];
  for (const packet of packets) {
    const unitId = `${packet.respondentId}/${packet.request.question.id}`;
    const requiredCapabilities = [...new Set(['text', ...(request.providerSelection?.requiredCapabilities ?? []),
      ...(packet.request.visualMaterials?.length ? ['pixels'] : [])])];
    const pins = [...new Set([request.providerSelection?.unitOverrides?.[unitId], request.providerSelection?.unitOverrides?.[packet.request.question.id]].filter((id): id is string => id !== undefined))];
    if (pins.length > 1) problems.push({ code: 'comparison_unit_pins_conflict', respondentId: packet.respondentId, message: `Journey initial ask ${unitId} has conflicting provider pins.` });
    const assessments = await Promise.all(settings.catalogue.entries.map(async (entry) => {
      const candidate = providerCandidates.find(({ id }) => id === entry.id);
      const ready = entry.enabled && candidate?.ready === true;
      if (!ready || !candidate) return { id: entry.id, ready: false, plannedCalls: 1 };
      let fit: ProviderContextFit;
      try { fit = candidate.provider.measure ? await candidate.provider.measure(packet.request) : missingMeasureFit(candidate.provider, candidate.providerKind, candidate.modelIdentity); }
      catch { fit = { ...missingMeasureFit(candidate.provider, candidate.providerKind, candidate.modelIdentity), reason: 'provider-measurement-failed' }; }
      return { id: entry.id, ready, fit, plannedCalls: 1 };
    }));
    selectionInputs.push({ catalogue: settings.catalogue, preferences: settings.preferences, unitId, requiredCapabilities,
      questionType: packet.request.question.type, candidates: assessments, remainingCalls: request.maxCalls,
      ...(request.providerSelection?.preferredOrder === undefined ? {} : { preferredOrder: request.providerSelection.preferredOrder }),
      ...(pins[0] === undefined ? {} : { unitOverride: pins[0] }) });
  }

  const locks = request.providerSelection?.comparisonLocks ?? [];
  const groupIndexFor = (respondentId: string, questionId: string) => packets.findIndex(({ respondentId: id, request: packet }) => id === respondentId && packet.question.id === questionId);
  const lockIndexByUnit = new Map<number, typeof locks[number]>();
  for (const lock of locks) for (const member of lock.members) {
    if (member.branchId) continue;
    const index = groupIndexFor(member.respondentId, member.questionId);
    if (index < 0) continue;
    if (lockIndexByUnit.has(index) && lockIndexByUnit.get(index)?.id !== lock.id) problems.push({ code: 'comparison_unit_in_multiple_locks', respondentId: member.respondentId,
      message: `Journey initial ask ${selectionInputs[index]!.unitId} belongs to more than one provider comparison.` });
    else lockIndexByUnit.set(index, lock);
  }
  const selections = new Map<number, { result: ProviderSelectionResult; lockId?: string }>();
  const fits: Inspection['fits'] = [];
  let remainingCalls = request.maxCalls;
  for (let index = 0; index < packets.length; index += 1) {
    if (selections.has(index)) continue;
    const lock = lockIndexByUnit.get(index);
    const lockIndices = lock ? [...new Set(lock.members.flatMap((member) => member.branchId ? [] : [groupIndexFor(member.respondentId, member.questionId)]).filter((memberIndex) => memberIndex >= 0))] : [];
    if (lock && lockIndices.length > 1) {
      const lockResult = selectProviderComparisonLock({ id: lock.id, equality: lock.equality, members: lockIndices.map((memberIndex) => ({ ...selectionInputs[memberIndex]!, remainingCalls })) });
      const memberResults = lockIndices.map((memberIndex) => {
        const planned = lockResult.members?.find(({ unitId }) => unitId === selectionInputs[memberIndex]!.unitId)?.selection;
        return { memberIndex, result: planned ?? (lockResult.selected ? selectProvider({ ...selectionInputs[memberIndex]!, remainingCalls, unitOverride: lockResult.selected.id }) : undefined) };
      });
      if (memberResults.every(({ result }) => result?.selected)) {
        const calls = memberResults.length;
        const canAdmit = calls <= remainingCalls;
        if (!canAdmit) problems.push({ code: 'comparison_call_allowance_exceeded', message: `Comparison ${lock.id} exceeds the remaining study-call allowance.` });
        for (const { memberIndex, result } of memberResults) {
          selections.set(memberIndex, { result: result!, lockId: lock.id });
          if (canAdmit) {
            remainingCalls -= 1;
            const packet = packets[memberIndex]!;
            const selectedFit = result!.selected!.fit;
            if (selectedFit) fits.push({ respondentId: packet.respondentId, nodeId: packet.nodeId, pathId: packet.pathId, packetId: packet.packetId, fit: selectedFit });
          }
        }
      } else {
        problems.push({ code: lockResult.decisionReason, message: `No common eligible provider satisfies every known member of comparison ${lock.id}.` });
        for (const { memberIndex, result } of memberResults) selections.set(memberIndex, { result: result ?? { candidates: [], decisionReason: lockResult.decisionReason }, lockId: lock.id });
      }
      continue;
    }
    const result = selectProvider({ ...selectionInputs[index]!, remainingCalls });
    selections.set(index, { result, ...(lock === undefined ? {} : { lockId: lock.id }) });
    if (!result.selected) {
      const reasons = result.candidates.filter(({ exclusion }) => exclusion).map(({ id, exclusion }) => `${id}: ${exclusion!.code}`).join(', ');
      problems.push({ code: result.decisionReason, respondentId: packets[index]!.respondentId, message: `No provider is eligible for journey initial ask ${selectionInputs[index]!.unitId}.${reasons ? ` ${reasons}` : ''}` });
      continue;
    }
    if (remainingCalls < 1) { problems.push({ code: 'insufficient_call_limit', respondentId: packets[index]!.respondentId, message: 'The journey initial provider request exceeds the remaining study-call allowance.' }); continue; }
    remainingCalls -= 1;
    const fit = result.selected.fit;
    if (fit) fits.push({ respondentId: packets[index]!.respondentId, nodeId: packets[index]!.nodeId, pathId: packets[index]!.pathId, packetId: packets[index]!.packetId, fit });
  }
  const initialChoices = packets.flatMap((packet, index) => {
    const resolved = selections.get(index);
    const selected = resolved?.result.selected;
    const entry = selected && settings.catalogue.entries.find(({ id }) => id === selected.id);
    if (!selected || !entry) return [];
    const candidates = resolved!.result.candidates.map((candidate) => ({ id: candidate.id, eligible: candidate.eligible, selected: candidate.selected,
      ...(candidate.fit === undefined ? {} : { fit: candidate.fit }), ...(candidate.cost === undefined ? {} : { cost: candidate.cost }),
      ...(candidate.exclusion === undefined ? {} : { exclusion: candidate.exclusion }), ...(candidate.preferenceRank === undefined ? {} : { preferenceRank: candidate.preferenceRank }) }));
    return [{ respondentId: packet.respondentId, questionId: packet.request.question.id, providerId: selected.id, modelIdentity: providerModelIdentity(entry.provider),
      ...(resolved?.lockId === undefined ? {} : { comparisonLockId: resolved.lockId }), decisionReason: resolved!.result.decisionReason, candidates }];
  });
  if (callBounds.maximumDecisionCalls > request.respondents.length) warnings.push({ code: 'reached_turn_fit_check', message: `${fits.length === request.respondents.length ? 'Initial packets passed fit checks.' : 'One or more initial packets failed fit checks.'} Each later reached turn is checked against the selected provider immediately before inference; an unfit reached turn stops that respondent and may leave the run partial.` });
  const inspection: Inspection = { valid: problems.length === 0, respondentCount: request.respondents.length, minimumCalls: callBounds.minimumDecisionCalls,
    maximumCalls: callBounds.maximumDecisionCalls, problems, ...(warnings.length === 0 ? {} : { warnings }), fits, initialChoices };
  if (!inspection.valid) return { inspection };
  return { inspection, journey: { request, requestFingerprint: hashCanonical({ request, compilerFingerprint }), compilerFingerprint,
    minimumCalls: callBounds.minimumDecisionCalls, maximumCalls: callBounds.maximumDecisionCalls, packets } };
}

async function planQuestionBatches(
  group: QuestionGroup,
  provider: DecisionProvider,
  kind: ProviderKind,
  modelIdentity: string,
  batching: 'automatic' | 'singleton' = 'automatic',
): Promise<{ batches: DecisionBatchRequest[]; fits: Inspection['fits']; problems: RunProblem[] }> {
  const planned = await assessProviderBatchPlan({ group, provider, providerKind: kind, modelIdentity, batching });
  const fits: Inspection['fits'] = planned.fits.map(({ questionIds, fit }) => ({
    respondentId: group.respondentId, groupId: group.groupId, contextId: group.contextId, questionIds, fit,
  }));
  const problems: RunProblem[] = planned.problems.map(({ code, respondentId, message }) => ({ code, respondentId, message }));
  if (planned.exceedsRemainingCalls) problems.push({ code: 'insufficient_call_limit', message: 'The physical request plan exceeds the remaining call limit.' });
  return { batches: planned.batches, fits, problems };
}

async function prepareJourneyAdmission(request: ParsedInlineJourneyRequest, provider: DecisionProvider): Promise<{ inspection: Inspection; journey?: PreparedJourneyAdmission }> {
  const configured = requireExplicitProvider(request);
  const compilerFingerprint = promptContractHash();
  let callBounds: ReturnType<typeof estimateRunDecisionCalls>;
  try { callBounds = estimateRunDecisionCalls([request.journey], request.respondents); }
  catch (error) {
    return { inspection: { valid: false, respondentCount: request.respondents.length, minimumCalls: 0, problems: [{ code: 'invalid_journey', message: error instanceof Error ? error.message : 'Journey routes are invalid.' }], fits: [] } };
  }

  const problems: Inspection['problems'] = [];
  const warnings: NonNullable<Inspection['warnings']> = [];
  const fits: Inspection['fits'] = [];
  const packets: PreflightPacket[] = [];
  if (request.maxCalls < callBounds.minimumDecisionCalls) {
    problems.push({ code: 'insufficient_call_limit', message: `maxCalls (${request.maxCalls}) is below the journey minimum (${callBounds.minimumDecisionCalls}).` });
  } else if (request.maxCalls < callBounds.maximumDecisionCalls) {
    warnings.push({ code: 'call_limit_may_stop_journey', message: `maxCalls (${request.maxCalls}) is below the journey maximum (${callBounds.maximumDecisionCalls}); some respondents may not reach a terminal node.` });
  }

  let initialPath: ReturnType<typeof initialJourneyPath>;
  try { initialPath = initialJourneyPath(request.journey); }
  catch (error) {
    return { inspection: { valid: false, respondentCount: request.respondents.length, minimumCalls: callBounds.minimumDecisionCalls,
      maximumCalls: callBounds.maximumDecisionCalls,
      problems: [...problems, { code: 'invalid_journey', message: error instanceof Error ? error.message : 'Journey has no initial ask packet.' }],
      ...(warnings.length === 0 ? {} : { warnings }), fits: [] } };
  }
  const task = request.journey.tasks.find(({ id }) => id === initialPath.taskId);
  if (!task) return { inspection: { valid: false, respondentCount: request.respondents.length, minimumCalls: callBounds.minimumDecisionCalls,
    maximumCalls: callBounds.maximumDecisionCalls,
    problems: [...problems, { code: 'invalid_journey', message: `Initial ask references unknown task ${initialPath.taskId}.` }],
    ...(warnings.length === 0 ? {} : { warnings }), fits: [] } };
  for (const respondent of request.respondents) {
    const packetRequest = compileDecisionPacket(request.journey, respondent, initialPath.taskId, initialPath.events);
    const identity = JSON.stringify([respondent.id, request.journey.id, 'root', 1, initialPath.nodeId]);
    packets.push({ packetId: `packet-${createHash('sha256').update(identity).digest('hex')}`,
      respondentId: respondent.id, armId: request.journey.id, pathId: 'root', decisionIndex: 1,
      nodeId: initialPath.nodeId, request: packetRequest });
  }

  const kind = configured.kind;
  const modelIdentity = kind === 'jev' || kind === 'clef' ? configured.model : configured.checkpoint;
  const measuredByInput = new Map<string, ProviderContextFit>();
  for (const packet of packets) {
    const inputFingerprint = hashCanonical(packet.request);
    let fit = measuredByInput.get(inputFingerprint);
    if (!fit) {
      if (!provider.measure) fit = missingMeasureFit(provider, kind, modelIdentity);
      else {
        try { fit = await provider.measure(packet.request); }
        catch { fit = { ...missingMeasureFit(provider, kind, modelIdentity), reason: 'provider-measurement-failed' }; }
      }
      measuredByInput.set(inputFingerprint, fit);
    }
    fits.push({ respondentId: packet.respondentId, nodeId: packet.nodeId, pathId: packet.pathId, packetId: packet.packetId, fit });
    const problem = problemForFit(packet.respondentId, fit);
    if (problem) problems.push({ ...problem, nodeId: packet.nodeId, pathId: packet.pathId });
  }
  if (callBounds.maximumDecisionCalls > request.respondents.length) {
    const initialFitMessage = fits.every(({ fit }) => fit.status === 'fits')
      ? 'Initial packets passed fit checks.'
      : 'One or more initial packets failed fit checks.';
    warnings.push({ code: 'reached_turn_fit_check', message: `${initialFitMessage} Each later reached turn is checked by the provider immediately before inference; an unfit reached turn stops that respondent and may leave the run partial.` });
  }

  const inspection: Inspection = {
    valid: problems.length === 0,
    respondentCount: request.respondents.length,
    minimumCalls: callBounds.minimumDecisionCalls,
    maximumCalls: callBounds.maximumDecisionCalls,
    problems,
    ...(warnings.length === 0 ? {} : { warnings }),
    fits,
  };
  if (!inspection.valid) return { inspection };
  return {
    inspection,
    journey: {
      request,
      requestFingerprint: hashCanonical({ request, compilerFingerprint }),
      compilerFingerprint,
      minimumCalls: callBounds.minimumDecisionCalls,
      maximumCalls: callBounds.maximumDecisionCalls,
      packets,
    },
  };
}
