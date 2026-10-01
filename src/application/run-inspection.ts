import { randomUUID } from 'node:crypto';
import { compileDecisionRequest, emptyTrajectory, promptContractHash } from '../domain/decision/prompt.js';
import type { DecisionProvider, ProviderContextFit } from '../domain/decision/provider.js';
import type { ProviderKind } from '../domain/decision/provider.js';
import { runRequestSchema, type FrozenEvaluation, type PreparedRun, type ParsedInlineJourneyRequest } from '../domain/run/request.js';
import type { Inspection, RunProblem } from '../domain/run/lifecycle.js';
import { hashCanonical } from '../infrastructure/identity.js';
import { walkStudyPackets, type PreflightPacket } from '../domain/journey/packet-walker.js';
import { estimateRunDecisionCalls } from '../domain/journey/route-bounds.js';

export type { Inspection } from '../domain/run/lifecycle.js';
export type { FrozenEvaluation, InlineRunRequest, PreparedRun } from '../domain/run/request.js';
export type PreparedJourneyAdmission = { request: ParsedInlineJourneyRequest; requestFingerprint: string; compilerFingerprint: string; minimumCalls: number; maximumCalls: number; packets: PreflightPacket[] };

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
