import { loadStudy } from '../infrastructure/study-loader.js';
import { z } from 'zod';
import { respondentProfileSchema } from '../domain/respondents/profile.js';
import { walkStudyPackets, type PreflightPacket } from '../domain/journey/preflight.js';
import type { ProviderContextFit } from '../domain/decision/provider.js';
import { JevProvider, type JevConfig } from '../providers/jev.js';
import { LayaProvider, type LayaConfig } from '../providers/laya.js';

export type PreflightProviderConfig = JevConfig | LayaConfig;
export type StudyPreflightInput = {
  manifestPath: string;
  cohortPath?: string;
  mode?: 'frozen-cohort' | 'maximum-profile';
  providers: readonly PreflightProviderConfig[];
  maxPackets?: number;
};

export const preflightInputSchema = z.object({
  manifestPath: z.string().min(1), cohortPath: z.string().min(1).optional(), mode: z.enum(['frozen-cohort', 'maximum-profile']).default('frozen-cohort'),
  providers: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('jev'), model: z.string().min(1), keyEnv: z.string().min(1), endpoint: z.string().url(), timeoutMs: z.number().int().positive() }).strict(),
    z.object({ kind: z.literal('laya'), baseUrl: z.string().url(), checkpoint: z.string().min(1), contextLimit: z.number().int().positive(), headLimit: z.number().int().positive(), tokenizerJsonPath: z.string().min(1), tokenizerSha256: z.string().regex(/^[a-f\d]{64}$/i), precision: z.string().optional(), timeoutMs: z.number().int().positive() }).strict(),
  ])).min(1), maxPackets: z.number().int().nonnegative().optional(),
}).strict().superRefine((input, context) => {
  if (input.mode === 'frozen-cohort' && !input.cohortPath) context.addIssue({ code: 'custom', path: ['cohortPath'], message: 'Frozen-cohort preflight requires a cohort path.' });
});

export type ProviderStudyFit = {
  provider: string;
  status: 'fit' | 'does-not-fit' | 'unverified';
  basis: 'frozen-cohort' | 'synthetic-profile';
  configuration: 'configured' | 'incomplete';
  availability: 'unverified';
  complete: boolean;
  packetCount: number;
  terminalJourneyCount: number;
  measurementMethod: string | null;
  effectiveLimit: number | null;
  maximumTokens: number | null;
  maximumPacket: Pick<PreflightPacket, 'packetId' | 'respondentId' | 'armId' | 'pathId' | 'decisionIndex' | 'nodeId'> | null;
  overflows: Array<Pick<PreflightPacket, 'packetId' | 'respondentId' | 'armId' | 'pathId' | 'decisionIndex' | 'nodeId'> & { tokens: number; effectiveLimit: number; reason?: string }>;
  unavailable: Array<Pick<PreflightPacket, 'packetId' | 'respondentId' | 'armId' | 'pathId' | 'decisionIndex' | 'nodeId'> & { reason: string }>;
  incompleteReason?: string;
};

export async function preflightStudy(input: StudyPreflightInput): Promise<{ provisional: boolean; mode: 'frozen-cohort' | 'maximum-profile'; providers: ProviderStudyFit[] }> {
  const config = preflightInputSchema.parse(input);
  const study = await loadStudy(config.manifestPath, config.cohortPath, { allowMissingCohort: config.mode === 'maximum-profile' });
  const respondents = config.mode === 'maximum-profile' ? [maximumProfile()] : study.respondents;
  const packets: PreflightPacket[] = [];
  const traversal = walkStudyPackets(study.manifest.arms, respondents, (packet) => { packets.push(packet); }, config.maxPackets === undefined ? {} : { maxPackets: config.maxPackets });
  const results: ProviderStudyFit[] = [];

  for (const providerConfig of config.providers) {
    const provider = providerConfig.kind === 'jev' ? new JevProvider(providerConfig) : new LayaProvider(providerConfig as LayaConfig);
    const overflows: ProviderStudyFit['overflows'] = [];
    const unavailable: ProviderStudyFit['unavailable'] = [];
    let maximumTokens: number | null = null;
    let maximumPacket: ProviderStudyFit['maximumPacket'] = null;
    let measurementMethod: string | null = null;
    let effectiveLimit: number | null = null;
    for (const packet of packets) {
      if (!provider.measure) {
        unavailable.push({ ...packetRef(packet), reason: 'provider-measurement-unavailable' });
        break;
      }
      let fit: ProviderContextFit;
      try { fit = await provider.measure(packet.request); }
      catch (error) {
        unavailable.push({ ...packetRef(packet), reason: error instanceof Error ? error.message : 'measurement-failed' });
        continue;
      }
      measurementMethod ??= fit.method;
      effectiveLimit ??= fit.effectiveLimit;
      if (fit.status === 'unavailable') unavailable.push({ ...packetRef(packet), reason: fit.reason ?? 'measurement-unavailable' });
      else if (fit.status === 'overflow') overflows.push({ ...packetRef(packet), tokens: fit.tokens, effectiveLimit: fit.effectiveLimit, ...(fit.reason === undefined ? {} : { reason: fit.reason }) });
      if (fit.status !== 'unavailable' && (maximumTokens === null || fit.tokens > maximumTokens)) {
        maximumTokens = fit.tokens;
        maximumPacket = packetRef(packet);
      }
    }
    const complete = traversal.status === 'complete';
    results.push({
      provider: providerConfig.kind === 'jev' ? providerConfig.model : providerConfig.checkpoint,
      status: !complete || unavailable.length ? 'unverified' : overflows.length ? 'does-not-fit' : 'fit',
      basis: config.mode === 'maximum-profile' ? 'synthetic-profile' : 'frozen-cohort',
      configuration: providerConfig.kind === 'jev'
        ? process.env[providerConfig.keyEnv] ? 'configured' : 'incomplete'
        : unavailable.length ? 'incomplete' : 'configured',
      availability: 'unverified',
      complete, packetCount: traversal.packetCount, terminalJourneyCount: traversal.terminalJourneyCount,
      measurementMethod, effectiveLimit, maximumTokens, maximumPacket, overflows, unavailable,
      ...(traversal.incompleteReason === undefined ? {} : { incompleteReason: traversal.incompleteReason }),
    });
  }
  return { provisional: config.mode === 'maximum-profile', mode: config.mode, providers: results };
}

function maximumProfile() {
  const text = '漢'.repeat(300);
  return respondentProfileSchema.parse({ id: 'maximum-profile', intent: text, context: text, desired_outcome: text, engagement_cues: text, friction_cues: text });
}

function packetRef(packet: PreflightPacket): NonNullable<ProviderStudyFit['maximumPacket']> {
  return { packetId: packet.packetId, respondentId: packet.respondentId, armId: packet.armId, pathId: packet.pathId, decisionIndex: packet.decisionIndex, nodeId: packet.nodeId };
}
