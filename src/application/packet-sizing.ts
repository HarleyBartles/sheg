import { createHash } from 'node:crypto';
import { z } from 'zod';
import { respondentPerspectiveSchema, type RespondentPerspective } from '../domain/respondents/profile.js';
import type { DecisionProvider, ProviderContextFit } from '../domain/decision/provider.js';
import type { DecisionRequest } from '../domain/decision/decision.js';
import { compileDecisionRequest, questionForTask, type DecisionPacketParts, type TrajectorySummary } from '../domain/decision/prompt.js';
import { stimulusItemSchema } from '../domain/study/stimulus.js';
import { taskSchema, type StudyTask } from '../domain/study/task.js';
import { JevProvider, jevConfigSchema, type JevConfig } from '../providers/jev.js';
import { LayaProvider, type LayaConfig } from '../providers/laya.js';
import { WindowsCredentialStore } from '../infrastructure/credentials/windows.js';

export const MAX_PACKET_SIZING_CASES = 1_000;
export const MAX_PACKET_SIZING_BYTES = 16 * 1024 * 1024;

const trajectoryChoiceSchema = z.object({
  taskId: z.string().min(1),
  choiceId: z.string().min(1),
  choiceMeaning: z.string().min(1),
  exposedItemIds: z.array(z.string().min(1)),
}).strict();
const trajectorySummarySchema = z.object({
  version: z.literal(1),
  eventCount: z.number().int().nonnegative(),
  exposureCount: z.number().int().nonnegative(),
  decisionCount: z.number().int().nonnegative(),
  eventRange: z.object({ firstSequence: z.number().int().nonnegative(), lastSequence: z.number().int().nonnegative() }).strict().nullable(),
  choices: z.array(trajectoryChoiceSchema),
  responses: z.array(z.object({ type: z.enum(['choice', 'score', 'noul']), taskId: z.string().min(1) }).passthrough()).optional(),
  payloadUtf8Bytes: z.number().int().nonnegative(),
}).strict().superRefine((trajectory, context) => {
  if (trajectory.eventCount !== trajectory.exposureCount + trajectory.decisionCount ||
      (trajectory.responses?.length ?? trajectory.choices.length) !== trajectory.decisionCount ||
      (trajectory.eventCount === 0) !== (trajectory.eventRange === null)) {
    context.addIssue({ code: 'custom', message: 'Trajectory counts, choices, and event range must describe the same history.' });
  }
});

const choiceTaskSchema = z.unknown().transform((value, context) => {
  const task = taskSchema.safeParse(value);
  if (!task.success) {
    for (const issue of task.error.issues) context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    return z.NEVER;
  }
  return task.data;
});

const variantSchema = <T extends z.ZodType>(valueSchema: T) => z.object({
  id: z.string().min(1).max(128),
  value: valueSchema,
}).strict();

const providerConfigSchema = z.union([
  jevConfigSchema,
  z.object({
    kind: z.literal('laya'),
    baseUrl: z.string().url(),
    checkpoint: z.string().min(1),
    contextLimit: z.number().int().positive(),
    headLimit: z.number().int().positive(),
    tokenizerJsonPath: z.string().min(1),
    tokenizerSha256: z.string().regex(/^[a-f\d]{64}$/i),
    precision: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive(),
  }).strict(),
]);

const variantDimensionSchema = <T extends z.ZodType>(name: string, schema: T) => z.array(variantSchema(schema)).min(1)
  .superRefine((variants, context) => {
    const ids = variants.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: `${name} variant IDs must be unique.` });
  });

export const packetSizingInputSchema = z.object({
  providers: z.array(providerConfigSchema).min(1),
  combination: z.enum(['paired', 'cartesian']),
  respondents: variantDimensionSchema('Respondent', respondentPerspectiveSchema),
  stimuli: variantDimensionSchema('Stimulus', z.array(stimulusItemSchema)),
  tasks: variantDimensionSchema('Task', choiceTaskSchema),
  trajectories: variantDimensionSchema('Trajectory', trajectorySummarySchema),
}).strict().superRefine((input, context) => {
  const providerIds = input.providers.map(providerId);
  if (new Set(providerIds).size !== providerIds.length) {
    context.addIssue({ code: 'custom', path: ['providers'], message: 'Provider configurations must have unique measurement identities.' });
  }
});

export type PacketSizingInput = z.infer<typeof packetSizingInputSchema>;
type ProviderConfig = PacketSizingInput['providers'][number];
type Variant<T> = { id: string; value: T };
type VariantIds = { respondent: string; stimulus: string; task: string; trajectory: string };
type ExpandedPacket = { caseId: string; variantIds: VariantIds; request: DecisionRequest };

export type PacketCaseMeasurement = {
  providerId: string;
  provider: 'jev' | 'laya';
  modelIdentity: string;
  status: 'fits' | 'overflow' | 'unavailable';
  method: string;
  tokenCount: 'measured' | 'estimated';
  tokens: number | null;
  contextLimit: number | null;
  effectiveLimit: number | null;
  headroomTokens: number | null;
  details: Record<string, number | string>;
  reason?: string;
};

export type PacketSizingResult = {
  complete: true;
  combination: 'paired' | 'cartesian';
  caseCount: number;
  providers: Array<{
    providerId: string;
    provider: 'jev' | 'laya';
    modelIdentity: string;
    configuration: 'configured' | 'incomplete';
    status: 'fits' | 'overflow' | 'unavailable';
    largestCase: { caseId: string; tokens: number } | null;
  }>;
  cases: Array<{
    caseId: string;
    variantIds: VariantIds;
    measurements: PacketCaseMeasurement[];
  }>;
};

export type PacketSizingDependencies = {
  createProvider?: (config: ProviderConfig) => DecisionProvider;
  credentialStore?: Pick<WindowsCredentialStore, 'availability' | 'readForAuthentication'>;
};

const dimensions = ['respondents', 'stimuli', 'tasks', 'trajectories'] as const;

export async function measurePacketBatch(rawInput: PacketSizingInput, dependencies: PacketSizingDependencies = {}): Promise<PacketSizingResult> {
  const input = packetSizingInputSchema.parse(rawInput);
  const variants = {
    respondents: input.respondents,
    stimuli: input.stimuli,
    tasks: input.tasks,
    trajectories: input.trajectories,
  };
  const caseCount = expandedCaseCount(input.combination, variants);
  if (caseCount > MAX_PACKET_SIZING_CASES) {
    throw new Error(`Packet sizing expands beyond the ${MAX_PACKET_SIZING_CASES}-case limit.`);
  }

  const expanded = expandCases(input.combination, variants);
  let serializedBytes = 0;
  for (const packet of expanded) {
    serializedBytes += Buffer.byteLength(JSON.stringify(packet), 'utf8');
    if (serializedBytes > MAX_PACKET_SIZING_BYTES) {
      throw new Error(`Serialized packet input exceeds the ${MAX_PACKET_SIZING_BYTES}-byte (16 MiB) limit.`);
    }
  }

  const credentialStore = dependencies.credentialStore ?? new WindowsCredentialStore();
  const providers = input.providers.map((providerInput) => {
    const config = providerInput.kind === 'jev' ? jevConfigSchema.parse(providerInput) : providerInput;
    const provider = dependencies.createProvider?.(config) ?? createProvider(config, credentialStore);
    return { config, providerId: providerId(config), provider, modelIdentity: modelIdentity(config) };
  });
  const cases: PacketSizingResult['cases'] = [];
  const providerMeasurements = new Map<string, Array<{ caseId: string; measurement: PacketCaseMeasurement }>>();

  for (const packet of expanded) {
    const measurements: PacketCaseMeasurement[] = [];
    for (const entry of providers) {
      const measurement = await measureOne(entry.provider, entry.config, entry.providerId, entry.modelIdentity, packet.request);
      measurements.push(measurement);
      const existing = providerMeasurements.get(entry.providerId) ?? [];
      existing.push({ caseId: packet.caseId, measurement });
      providerMeasurements.set(entry.providerId, existing);
    }
    cases.push({ caseId: packet.caseId, variantIds: packet.variantIds, measurements });
  }

  return {
    complete: true,
    combination: input.combination,
    caseCount,
    providers: await Promise.all(providers.map(async ({ config, providerId: id, modelIdentity }) => {
      const measurements = providerMeasurements.get(id) ?? [];
      const measured = measurements.filter(({ measurement }) => measurement.status !== 'unavailable' && measurement.tokens !== null)
        .sort((left, right) => (right.measurement.tokens! - left.measurement.tokens!) || left.caseId.localeCompare(right.caseId));
      const statuses = measurements.map(({ measurement }) => measurement.status);
      const status = statuses.includes('unavailable') ? 'unavailable' : statuses.includes('overflow') ? 'overflow' : 'fits';
      const first = measured[0];
      return {
        providerId: id,
        provider: config.kind,
        modelIdentity,
        configuration: config.kind === 'jev' && await credentialStore.availability(config.route) !== 'available' ? 'incomplete' as const : 'configured' as const,
        status,
        largestCase: first ? { caseId: first.caseId, tokens: first.measurement.tokens! } : null,
      };
    })),
    cases,
  };
}

async function measureOne(provider: DecisionProvider, config: ProviderConfig, id: string, identity: string, request: DecisionRequest): Promise<PacketCaseMeasurement> {
  if (!provider.measure) {
    return unavailableMeasurement(config, id, identity, 'provider-measurement-unavailable');
  }
  let fit: ProviderContextFit;
  try {
    fit = await provider.measure(request);
  } catch (error) {
    return unavailableMeasurement(config, id, identity, error instanceof Error ? error.message : 'measurement-failed');
  }
  if (fit.status === 'unavailable') {
    return {
      providerId: id,
      provider: fit.provider,
      modelIdentity: fit.modelIdentity,
      status: 'unavailable',
      method: fit.method,
      tokenCount: fit.tokenCount,
      tokens: null,
      contextLimit: fit.contextLimit,
      effectiveLimit: fit.effectiveLimit,
      headroomTokens: null,
      details: fit.details,
      ...(fit.reason === undefined ? {} : { reason: fit.reason }),
    };
  }
  if (fit.contextLimit === null || fit.effectiveLimit === null || fit.headroomTokens === null) {
    return unavailableMeasurement(config, id, identity, 'context-limit-unverified');
  }
  return {
    providerId: id,
    provider: fit.provider,
    modelIdentity: fit.modelIdentity,
    status: fit.status,
    method: fit.method,
    tokenCount: fit.tokenCount,
    tokens: fit.tokens,
    contextLimit: fit.contextLimit,
    effectiveLimit: fit.effectiveLimit,
    headroomTokens: fit.effectiveLimit - fit.tokens,
    details: fit.details,
    ...(fit.reason === undefined ? {} : { reason: fit.reason }),
  };
}

function unavailableMeasurement(config: ProviderConfig, id: string, identity: string, reason: string): PacketCaseMeasurement {
  return {
    providerId: id,
    provider: config.kind,
    modelIdentity: identity,
    status: 'unavailable',
    method: 'measurement-unavailable',
    tokenCount: config.kind === 'jev' ? 'estimated' : 'measured',
    tokens: null,
    contextLimit: config.kind === 'jev' ? null : config.contextLimit,
    effectiveLimit: null,
    headroomTokens: null,
    details: {},
    reason,
  };
}

function createProvider(config: ProviderConfig, credentialStore: Pick<WindowsCredentialStore, 'availability' | 'readForAuthentication'>): DecisionProvider {
  return config.kind === 'jev' ? new JevProvider(config as JevConfig, fetch, { credentialStore }) : new LayaProvider(config as LayaConfig);
}

function expandedCaseCount(combination: 'paired' | 'cartesian', variants: Record<typeof dimensions[number], Variant<unknown>[]>): number {
  if (combination === 'paired') {
    const multiLengths = dimensions.map((dimension) => variants[dimension].length).filter((length) => length > 1);
    if (multiLengths.some((length) => length !== multiLengths[0])) {
      throw new Error('Paired variant dimensions with multiple values must have the same length. Use cartesian to measure every combination.');
    }
    return multiLengths[0] ?? 1;
  }
  let count = 1;
  for (const dimension of dimensions) {
    const length = variants[dimension].length;
    if (count > MAX_PACKET_SIZING_CASES / length) return MAX_PACKET_SIZING_CASES + 1;
    count *= length;
  }
  return count;
}

function expandCases(combination: 'paired' | 'cartesian', variants: Record<typeof dimensions[number], Variant<unknown>[]>): ExpandedPacket[] {
  const count = expandedCaseCount(combination, variants);
  const selections: Array<{ respondent: Variant<RespondentPerspective>; stimulus: Variant<Array<{ id: string; text: string }>>; task: Variant<StudyTask>; trajectory: Variant<TrajectorySummary> }> = [];
  if (combination === 'paired') {
    for (let index = 0; index < count; index += 1) {
      const select = <T>(dimension: typeof dimensions[number]): Variant<T> => {
        const values = variants[dimension] as Variant<T>[];
        return values[values.length === 1 ? 0 : index]!;
      };
      selections.push({ respondent: select('respondents'), stimulus: select('stimuli'), task: select('tasks'), trajectory: select('trajectories') });
    }
  } else {
    for (const respondent of variants.respondents as Variant<RespondentPerspective>[]) {
      for (const stimulus of variants.stimuli as Variant<Array<{ id: string; text: string }>>[]) {
        for (const selectedTask of variants.tasks as Variant<StudyTask>[]) {
          for (const trajectory of variants.trajectories as Variant<TrajectorySummary>[]) {
            selections.push({ respondent, stimulus, task: selectedTask, trajectory });
          }
        }
      }
    }
  }

  return selections.map((selection) => {
    const variantIds: VariantIds = {
      respondent: selection.respondent.id,
      stimulus: selection.stimulus.id,
      task: selection.task.id,
      trajectory: selection.trajectory.id,
    };
    const caseId = `case-${createHash('sha256').update(JSON.stringify([variantIds.respondent, variantIds.stimulus, variantIds.task, variantIds.trajectory])).digest('hex').slice(0, 20)}`;
    const parts: DecisionPacketParts = {
      respondentProfile: selection.respondent.value,
      encounteredItems: selection.stimulus.value,
      trajectory: selection.trajectory.value,
      question: questionForTask(selection.task.value),
    };
    return { caseId, variantIds, request: compileDecisionRequest(parts) };
  });
}

function providerId(config: ProviderConfig): string {
  return `provider-${createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 20)}`;
}

function modelIdentity(config: ProviderConfig): string {
  return config.kind === 'jev' ? `${config.route}:${config.model}` : config.checkpoint;
}
