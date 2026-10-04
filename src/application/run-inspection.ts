import { randomUUID } from 'node:crypto';
import { compileDecisionRequest, emptyTrajectory, prepareFollowOnPacket, promptContractHash } from '../domain/decision/prompt.js';
import { decisionValueFromResult } from '../domain/decision/decision.js';
import type { DecisionProvider, ProviderContextFit } from '../domain/decision/provider.js';
import type { DecisionBatchRequest, DecisionQuestion, DecisionRequest } from '../domain/decision/decision.js';
import type { ProviderKind } from '../domain/decision/provider.js';
import { runRequestSchema, type FrozenEvaluation, type PreparedRun, type ParsedInlineJourneyRequest, type ParsedFollowOnRunRequest, type FollowOnSourceSet, type FollowOnLineage, type RunMaterialItem, type FollowOnSelectionExclusion, type SelectionCoverage } from '../domain/run/request.js';
import type { Inspection, RunProblem } from '../domain/run/lifecycle.js';
import type { JourneyRespondentState } from '../domain/run/lifecycle.js';
import type { PreparedJourneyRun } from '../domain/run/request.js';
import { hashCanonical } from '../infrastructure/identity.js';
import { walkStudyPackets, type PreflightPacket } from '../domain/journey/packet-walker.js';
import { estimateRunDecisionCalls } from '../domain/journey/route-bounds.js';
import { journeyTopology } from '../domain/journey/topology.js';

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
    const modelIdentity = request.provider.kind === 'jev' ? request.provider.model : request.provider.checkpoint;
    const contextId = randomUUID(); const groupId = randomUUID();
    const planned = await planQuestionBatches({ groupId, contextId, respondentId: turn.respondentId, state: packets[0]!.state, questions: request.questions, packets }, provider, request.provider.kind, modelIdentity);
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
    const firstPacket = packets.find((packet) => packet.respondentId === profile.id && packet.decisionIndex === 1 && packet.pathId === 'root');
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
    const events = initialJourneyEvents(request.journey);
    respondents.push({
      respondentId: profile.id, status: 'active', currentNodeId: firstPacket.nodeId, currentTurnId: turnId,
      currentContextId: contextId, revision: 0, events, route: [],
    });
  }
  return { request, requestFingerprint, compilerFingerprint, evaluations, respondents };
}

function initialJourneyEvents(arm: ParsedInlineJourneyRequest['journey']): JourneyRespondentState['events'] {
  const events: JourneyRespondentState['events'] = [];
  const graph = journeyTopology(arm);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  let current = graph.entryNodeId;
  while (true) {
    const node = nodes.get(current);
    if (!node) throw new Error(`Journey points to unknown node ${current}.`);
    if (node.kind === 'ask') return events;
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

  const compilerFingerprint = promptContractHash();
  const evaluations: FrozenEvaluation[] = [];
  const preparedGroups: NonNullable<PreparedRun['groups']> = [];
  const fits: Inspection['fits'] = [];
  const problems: RunProblem[] = [];
  let minimumCalls = 0;
  const kind = request.provider.kind;
  const modelIdentity = kind === 'jev' ? request.provider.model : request.provider.checkpoint;

  for (const respondent of request.respondents) {
    const respondentProfile = {
      intent: respondent.intent,
      context: respondent.context,
      desired_outcome: respondent.desired_outcome,
      engagement_cues: respondent.engagement_cues,
      friction_cues: respondent.friction_cues,
    };
    const packets = request.questions.map((question) => compileDecisionRequest({
      respondentProfile, encounteredItems: request.material, trajectory: emptyTrajectory(), question,
    }));
    const contextId = randomUUID();
    const groupId = randomUUID();
    preparedGroups.push({ groupId, contextId, respondentId: respondent.id, state: packets[0]!.state, questionIds: request.questions.map(({ id }) => id) });
    const planned = await planQuestionBatches({ groupId, contextId, respondentId: respondent.id, state: packets[0]!.state, questions: request.questions, packets }, provider, kind, modelIdentity);
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

async function planQuestionBatches(
  group: QuestionGroup,
  provider: DecisionProvider,
  kind: ProviderKind,
  modelIdentity: string,
): Promise<{ batches: DecisionBatchRequest[]; fits: Inspection['fits']; problems: RunProblem[] }> {
  const { groupId, contextId, respondentId, state, questions, packets } = group;
  const batches: DecisionBatchRequest[] = [];
  const fits: Inspection['fits'] = [];
  const problems: RunProblem[] = [];
  const measureOne = async (index: number): Promise<ProviderContextFit> => {
    if (!provider.measure) return missingMeasureFit(provider, kind, modelIdentity);
    try { return await provider.measure(packets[index]!); }
    catch { return { ...missingMeasureFit(provider, kind, modelIdentity), reason: 'provider-measurement-failed' }; }
  };
  const measureBatch = async (batchQuestions: readonly DecisionQuestion[]): Promise<ProviderContextFit> => {
    if (!provider.measureBatch) return missingMeasureFit(provider, kind, modelIdentity);
    try { return await provider.measureBatch({ state, questions: [...batchQuestions] }); }
    catch { return { ...missingMeasureFit(provider, kind, modelIdentity), reason: 'provider-measurement-failed' }; }
  };
  const recordFit = (questionIds: string[], fit: ProviderContextFit) => {
    fits.push({ respondentId, groupId, contextId, questionIds, fit });
    const problem = problemForFit(respondentId, fit);
    if (problem) problems.push(problem);
  };

  if (!provider.measureBatch) {
    for (let index = 0; index < questions.length; index += 1) {
      const question = questions[index]!;
      const fit = await measureOne(index);
      recordFit([question.id], fit);
      batches.push({ state, questions: [question] });
    }
    return { batches, fits, problems };
  }

  let start = 0;
  while (start < questions.length) {
    let end = start + 1;
    let lastFit: { end: number; fit: ProviderContextFit } | undefined;
    while (end <= questions.length) {
      const candidate = questions.slice(start, end);
      const fit = await measureBatch(candidate);
      if (fit.status === 'unavailable') {
        recordFit(candidate.map(({ id }) => id), fit);
        return { batches, fits, problems };
      }
      if (fit.status === 'overflow') {
        if (!lastFit) recordFit(candidate.map(({ id }) => id), fit);
        break;
      }
      lastFit = { end, fit };
      end += 1;
    }
    if (lastFit) {
      const selected = questions.slice(start, lastFit.end);
      batches.push({ state, questions: [...selected] });
      recordFit(selected.map(({ id }) => id), lastFit.fit);
      start = lastFit.end;
      continue;
    }
    return { batches, fits, problems };
  }
  return { batches, fits, problems };
}

async function prepareJourneyAdmission(request: ParsedInlineJourneyRequest, provider: DecisionProvider): Promise<{ inspection: Inspection; journey?: PreparedJourneyAdmission }> {
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

  const traversal = walkStudyPackets([request.journey], request.respondents, (packet) => { packets.push(packet); });
  if (traversal.status !== 'complete') {
    problems.push({ code: 'journey_preflight_incomplete', message: traversal.incompleteReason ?? 'Journey context traversal is incomplete.' });
  }
  const respondentsWithoutInitialAsk = request.respondents.filter((respondent) =>
    !packets.some((packet) => packet.respondentId === respondent.id && packet.decisionIndex === 1 && packet.pathId === 'root'));
  if (respondentsWithoutInitialAsk.length > 0) {
    return { inspection: { valid: false, respondentCount: request.respondents.length, minimumCalls: callBounds.minimumDecisionCalls,
      maximumCalls: callBounds.maximumDecisionCalls,
      problems: [...problems, ...respondentsWithoutInitialAsk.map((respondent) => ({ code: 'invalid_journey', respondentId: respondent.id,
        message: `Journey has no initial ask packet for respondent ${respondent.id}.` }))],
      ...(warnings.length === 0 ? {} : { warnings }), fits: [] } };
  }
  if (traversal.unverifiedReason) {
    warnings.push({ code: 'context_fit_unverified', message: `${traversal.unverifiedReason} Each actual packet is checked by the selected provider before inference.` });
  }

  const kind = request.provider.kind;
  const modelIdentity = kind === 'jev' ? request.provider.model : request.provider.checkpoint;
  for (const packet of packets) {
    let fit: ProviderContextFit;
    if (!provider.measure) fit = missingMeasureFit(provider, kind, modelIdentity);
    else {
      try { fit = await provider.measure(packet.request); }
      catch { fit = { ...missingMeasureFit(provider, kind, modelIdentity), reason: 'provider-measurement-failed' }; }
    }
    fits.push({ respondentId: packet.respondentId, nodeId: packet.nodeId, pathId: packet.pathId, packetId: packet.packetId, fit });
    const problem = problemForFit(packet.respondentId, fit);
    if (problem) problems.push({ ...problem, nodeId: packet.nodeId, pathId: packet.pathId });
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
