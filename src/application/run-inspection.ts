import { randomUUID } from 'node:crypto';
import { compileDecisionRequest, emptyTrajectory, prepareFollowOnPacket, promptContractHash } from '../domain/decision/prompt.js';
import { decisionValueSchema } from '../domain/decision/decision.js';
import type { DecisionProvider, ProviderContextFit } from '../domain/decision/provider.js';
import type { ProviderKind } from '../domain/decision/provider.js';
import { runRequestSchema, type FrozenEvaluation, type PreparedRun, type ParsedInlineJourneyRequest, type ParsedFollowOnRunRequest, type FollowOnSourceSet, type FollowOnLineage } from '../domain/run/request.js';
import type { Inspection, RunProblem } from '../domain/run/lifecycle.js';
import type { JourneyRespondentState } from '../domain/run/lifecycle.js';
import type { PreparedJourneyRun } from '../domain/run/request.js';
import { hashCanonical } from '../infrastructure/identity.js';
import { walkStudyPackets, type PreflightPacket } from '../domain/journey/packet-walker.js';
import { estimateRunDecisionCalls } from '../domain/journey/route-bounds.js';

export type { Inspection } from '../domain/run/lifecycle.js';
export type { FrozenEvaluation, InlineRunRequest, PreparedRun } from '../domain/run/request.js';
export type PreparedJourneyAdmission = { request: ParsedInlineJourneyRequest; requestFingerprint: string; compilerFingerprint: string; minimumCalls: number; maximumCalls: number; packets: PreflightPacket[] };
export type PreparedFollowOnAdmission = { prepared: PreparedRun; inspection: Inspection; sourceVersion: FollowOnSourceSet['version'] };

export async function prepareFollowOnRun(request: ParsedFollowOnRunRequest, source: FollowOnSourceSet, provider: DecisionProvider): Promise<PreparedFollowOnAdmission> {
  const compilerFingerprint = promptContractHash();
  const question = request.questions[0];
  const fits: Inspection['fits'] = [];
  const problems: RunProblem[] = [];
  const evaluations: FrozenEvaluation[] = [];
  const selections: FollowOnLineage['selections'] = [];
  for (const turn of source.turns) {
    let selectedMaterial = [...(request.material ?? [])];
    if (request.context.materialIds) {
      const byId = new Map(turn.packet.state.encounteredItems.map((item) => [item.id, item]));
      const referencedMaterial: Array<{ id: string; text: string }> = [];
      for (const id of request.context.materialIds) {
        const item = byId.get(id);
        if (!item) throw new RunProblemError('follow_on_material_not_found', `Material ${id} was not encountered in evaluation ${turn.evaluationId}.`);
        referencedMaterial.push({ ...item });
      }
      selectedMaterial = [...referencedMaterial, ...selectedMaterial];
    }
    const rawResult = turn.result ? decisionValueSchema.parse(turn.result.type === 'choice'
      ? { type: turn.result.type, choice: turn.result.choice, probabilities: turn.result.probabilities, confidence: turn.result.confidence }
      : turn.result.type === 'score'
        ? { type: turn.result.type, score: turn.result.score, probabilities: turn.result.probabilities, legend: turn.result.legend, confidence: turn.result.confidence }
        : { type: turn.result.type, noul: turn.result.noul }) : undefined;
    let packet;
    try {
      packet = prepareFollowOnPacket({ source: turn.packet, mode: request.context.mode, question,
        ...(request.context.mode === 'recorded' ? {} : { material: selectedMaterial }), ...(rawResult ? { result: rawResult } : {}) });
    } catch (error) {
      throw new RunProblemError('follow_on_context_invalid', error instanceof Error ? error.message : 'Follow-on context could not be prepared.');
    }
    const modelIdentity = request.provider.kind === 'jev' ? request.provider.model : request.provider.checkpoint;
    let fit: ProviderContextFit;
    if (!provider.measure) fit = missingMeasureFit(provider, request.provider.kind, modelIdentity);
    else {
      try { fit = await provider.measure(packet); }
      catch { fit = { ...missingMeasureFit(provider, request.provider.kind, modelIdentity), reason: 'provider-measurement-failed' }; }
    }
    fits.push({ respondentId: turn.respondentId, fit });
    const problem = problemForFit(turn.respondentId, fit);
    if (problem) problems.push(problem);
    const evaluationId = randomUUID(); const contextId = randomUUID();
    evaluations.push({ evaluationId, contextId, respondentId: turn.respondentId, questionId: question.id,
      packet, packetFingerprint: hashCanonical({ packet, compilerFingerprint }) });
    selections.push({ sourceEvaluationId: turn.evaluationId, sourceContextId: turn.contextId, respondentId: turn.respondentId, evaluationId, contextId });
  }
  if (evaluations.length === 0) problems.push({ code: 'no_follow_on_matches', message: 'No source evaluations match this follow-on selection.' });
  if (evaluations.length > request.maxCalls) problems.push({ code: 'insufficient_call_limit', message: `maxCalls (${request.maxCalls}) is below the selected evaluation count (${evaluations.length}).` });
  const sourceWarning = source.sourceComplete ? undefined : {
    code: 'source_incomplete',
    message: ['prepared', 'running'].includes(source.sourceStatus)
      ? `${evaluations.length} evaluations match so far. Source run is ${source.sourceStatus}; more may match after it completes.`
      : `Source run is ${source.sourceStatus} and incomplete. This follow-on uses the evidence currently recorded.`,
  };
  const inspection: Inspection = { valid: problems.length === 0, respondentCount: evaluations.length, minimumCalls: evaluations.length, problems, fits,
    ...(sourceWarning ? { warnings: [sourceWarning] } : {}) };
  const lineage: FollowOnLineage = { sourceRunId: source.sourceRunId, sourceStatusAtAcceptance: source.sourceStatus,
    sourceCompleteAtAcceptance: source.sourceComplete, sourceVersion: source.version, selections };
  return { sourceVersion: source.version, inspection,
    prepared: { request, requestFingerprint: hashCanonical({ request, compilerFingerprint }), compilerFingerprint, evaluations, lineage } };
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
  if (arm.presentation.kind === 'sequence') {
    for (const item of arm.items) events.push({ type: 'exposure', sequence: events.length, nodeId: `sequence-expose-${item.id}`, itemId: item.id });
    return events;
  }
  const nodes = new Map(arm.presentation.nodes.map((node) => [node.id, node]));
  let current = arm.presentation.entryNodeId;
  while (true) {
    const node = nodes.get(current);
    if (!node) throw new Error(`Journey points to unknown node ${current}.`);
    if (node.kind === 'ask') return events;
    if (node.kind === 'terminal') throw new Error('Journey must reach an ask node before a terminal node.');
    events.push({ type: 'exposure', sequence: events.length, nodeId: node.id, itemId: node.itemId });
    const edge = arm.presentation.transitions.find((candidate) => candidate.fromNodeId === node.id);
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
  const fits: Inspection['fits'] = [];
  const problems: RunProblem[] = [];

  for (const respondent of request.respondents) {
    const packet = compileDecisionRequest({
      respondentProfile: {
        intent: respondent.intent,
        context: respondent.context,
        desired_outcome: respondent.desired_outcome,
        engagement_cues: respondent.engagement_cues,
        friction_cues: respondent.friction_cues,
      },
      encounteredItems: request.material,
      trajectory: emptyTrajectory(),
      question: request.questions[0],
    });
    let fit: ProviderContextFit;
    const kind = request.provider.kind;
    const modelIdentity = kind === 'jev' ? request.provider.model : request.provider.checkpoint;
    if (!provider.measure) {
      fit = missingMeasureFit(provider, kind, modelIdentity);
    } else {
      try {
        fit = await provider.measure(packet);
      } catch {
        fit = { ...missingMeasureFit(provider, kind, modelIdentity), reason: 'provider-measurement-failed' };
      }
    }
    fits.push({ respondentId: respondent.id, fit });
    const problem = problemForFit(respondent.id, fit);
    if (problem) problems.push(problem);

    evaluations.push({
      evaluationId: randomUUID(),
      contextId: randomUUID(),
      respondentId: respondent.id,
      questionId: request.questions[0].id,
      packet,
      packetFingerprint: hashCanonical({ packet, compilerFingerprint }),
    });
  }

  const inspection: Inspection = {
    valid: problems.length === 0,
    respondentCount: request.respondents.length,
    minimumCalls: request.respondents.length,
    problems,
    fits,
  };
  if (!inspection.valid) return { inspection };

  const prepared: PreparedRun = {
    request,
    requestFingerprint: hashCanonical({ request, compilerFingerprint }),
    compilerFingerprint,
    evaluations,
  };
  return { inspection, prepared };
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
