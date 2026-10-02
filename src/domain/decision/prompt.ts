import { createHash } from 'node:crypto';
import { decisionRequestSchema, type DecisionRequest, type DecisionValue } from './decision.js';
import type { RespondentPerspective, RespondentProfile } from '../respondents/profile.js';
import type { JourneyDefinition } from '../study/arm.js';

export type PromptHistoryEvent =
  | { type: 'exposure'; sequence: number; nodeId: string; itemId: string }
  | { type: 'choice'; sequence: number; nodeId: string; taskId: string; choice: string }
  | { type: 'response'; sequence: number; nodeId: string; taskId: string; result: DecisionValue };

export type TrajectoryChoice = {
  taskId: string;
  choiceId: string;
  choiceMeaning: string;
  exposedItemIds: string[];
};

export type TrajectoryResponse =
  | (TrajectoryChoice & { type: 'choice'; probabilities?: Record<string, number>; confidence?: number })
  | { type: 'score'; taskId: string; score: number; meaning: string; probabilities: Record<string, number>; legend: Record<string, string>; confidence?: number; exposedItemIds: string[] }
  | { type: 'noul'; taskId: string; noul: number; proposition: string; exposedItemIds: string[] };

export type TrajectorySummary = {
  version: 1;
  eventCount: number;
  exposureCount: number;
  decisionCount: number;
  eventRange: { firstSequence: number; lastSequence: number } | null;
  choices: TrajectoryChoice[];
  responses: TrajectoryResponse[];
  payloadUtf8Bytes: number;
};

export type PromptState = {
  respondent: { profile: RespondentPerspective };
  encounteredItems: Array<{ id: string; text: string }>;
  trajectory: TrajectorySummary;
};

export type DecisionPacketParts = {
  respondentProfile: RespondentPerspective;
  encounteredItems: Array<{ id: string; text: string }>;
  trajectory: TrajectorySummary;
  question: DecisionRequest['question'];
};

export function questionForTask(task: JourneyDefinition['tasks'][number]): DecisionRequest['question'] {
  if ('options' in task) return { type: 'choice', id: task.id, instructions: task.instructions, options: { ...task.options }, ...(task.materialOptions ? { materialOptions: { ...task.materialOptions } } : {}) };
  if ('rubric' in task) return { type: 'score', id: task.id, instructions: task.instructions, rubric: [...task.rubric] };
  return { type: 'noul', id: task.id, instructions: task.instructions, ...(task.criteria === undefined ? {} : { criteria: { ...task.criteria } }) };
}

const promptContract = {
  version: 6,
  stateFields: ['respondent.profile', 'encounteredItems', 'trajectory'],
  graphExposureWindow: 'items exposed since the previous decision',
  sequenceExposureWindow: 'all arm items for every task',
  trajectory: ['prior task IDs and typed responses with meanings', 'prior exposure IDs', 'event counts and range'],
  responseHistory: 'per-task include or omit; omitted legacy setting includes prior responses',
  onlyCurrentGraphExposureText: true,
  preserveEncounterOrder: true,
  historyOrder: 'chronological',
  studyMetadataExcluded: true,
  answerKeysExcluded: true,
  otherArmsExcluded: true,
  decisionSemantics: 'Choose exactly one offered stable option ID according to its description.',
} as const;

export const legacyPromptContractHash = 'c84188c79201c09c741af627cf9bcc426c8ba5b69284045334467d17e0adc044';

function finishTrajectory(body: Omit<TrajectorySummary, 'payloadUtf8Bytes'>): TrajectorySummary {
  let payloadUtf8Bytes = 0;
  for (;;) {
    const nextSize = new TextEncoder().encode(JSON.stringify({ ...body, payloadUtf8Bytes })).length;
    if (nextSize === payloadUtf8Bytes) break;
    payloadUtf8Bytes = nextSize;
  }
  return { ...body, payloadUtf8Bytes };
}

export function emptyTrajectory(): TrajectorySummary {
  return finishTrajectory({
    version: 1,
    eventCount: 0,
    exposureCount: 0,
    decisionCount: 0,
    eventRange: null,
    choices: [],
    responses: [],
  });
}

export function appendTrajectoryResponse(
  trajectory: TrajectorySummary,
  question: DecisionRequest['question'],
  result: DecisionValue,
  exposedItemIds: readonly string[],
): TrajectorySummary {
  if (question.type !== result.type) throw new Error('Decision response type does not match the saved question.');
  const exposed = [...exposedItemIds];
  let response: TrajectoryResponse;
  let choices = trajectory.choices;
  if (result.type === 'choice' && question.type === 'choice') {
    const choiceMeaning = question.options[result.choice];
    if (choiceMeaning === undefined) throw new Error(`Saved answer choice ${result.choice} was not offered.`);
    response = { type: 'choice', taskId: question.id, choiceId: result.choice, choiceMeaning, exposedItemIds: exposed,
      ...(result.probabilities === undefined ? {} : { probabilities: { ...result.probabilities } }),
      ...(result.confidence === undefined ? {} : { confidence: result.confidence }) };
    choices = [...trajectory.choices, { taskId: question.id, choiceId: result.choice, choiceMeaning, exposedItemIds: exposed }];
  } else if (result.type === 'score' && question.type === 'score') {
    if (result.score < 0 || result.score > question.rubric.length - 1) throw new Error('Saved Score answer is outside its question rubric.');
    response = { type: 'score', taskId: question.id, score: result.score,
      meaning: `Expected rubric level ${result.score}; rubric: ${question.rubric.join(' | ')}`,
      probabilities: { ...result.probabilities }, legend: { ...result.legend },
      ...(result.confidence === undefined ? {} : { confidence: result.confidence }), exposedItemIds: exposed };
  } else if (result.type === 'noul' && question.type === 'noul') {
    response = { type: 'noul', taskId: question.id, noul: result.noul, proposition: question.instructions, exposedItemIds: exposed };
  } else throw new Error('Decision response type does not match the saved question.');

  return finishTrajectory({
    version: 1,
    eventCount: trajectory.eventCount + 1,
    exposureCount: trajectory.exposureCount,
    decisionCount: trajectory.decisionCount + 1,
    eventRange: trajectory.eventRange === null
      ? { firstSequence: 0, lastSequence: 0 }
      : { firstSequence: trajectory.eventRange.firstSequence, lastSequence: trajectory.eventCount },
    choices,
    responses: [...trajectory.responses, response],
  });
}

export function prepareFollowOnPacket(input: {
  source: DecisionRequest & { state: PromptState };
  mode: 'recorded' | 'fresh-material' | 'omit-history' | 'continue';
  question: DecisionRequest['question'];
  material?: readonly { id: string; text: string }[];
  result?: DecisionValue;
}): DecisionRequest & { state: PromptState } {
  const { source, mode, question } = input;
  if (mode === 'recorded') return compileDecisionRequest({
    respondentProfile: source.state.respondent.profile,
    encounteredItems: source.state.encounteredItems,
    trajectory: source.state.trajectory,
    question,
  }) as DecisionRequest & { state: PromptState };
  const material = input.material ? input.material.map(({ id, text }) => ({ id, text })) : [];
  let state: PromptState;
  if (mode === 'continue') {
    if (!input.result) throw new Error('Continue context requires the selected completed answer.');
    const currentIds = source.state.encounteredItems.map(({ id }) => id);
    state = {
      respondent: { profile: { ...source.state.respondent.profile } },
      encounteredItems: [...source.state.encounteredItems.map((item) => ({ ...item })), ...material],
      trajectory: appendTrajectoryResponse(source.state.trajectory, source.question, input.result, currentIds),
    };
  } else {
    if (material.length === 0) throw new Error(`${mode} context requires explicit material.`);
    state = {
      respondent: { profile: { ...source.state.respondent.profile } },
      encounteredItems: material,
      trajectory: emptyTrajectory(),
    };
  }
  return compileDecisionRequest({ respondentProfile: state.respondent.profile, encounteredItems: state.encounteredItems, trajectory: state.trajectory, question }) as DecisionRequest & { state: PromptState };
}

function compactTrajectory(arm: JourneyDefinition, history: readonly PromptHistoryEvent[]): TrajectorySummary {
  const exposureIds: string[] = [];
  const choices: TrajectoryChoice[] = [];
  const responses: TrajectoryResponse[] = [];
  for (const event of history) {
    if (event.type === 'exposure') {
      exposureIds.push(event.itemId);
      continue;
    }
    const task = arm.tasks.find((candidate) => candidate.id === event.taskId);
    const result = event.type === 'response' ? event.result : { type: 'choice' as const, choice: event.choice, probabilities: {} };
    if (!task) throw new Error(`Unknown task ${event.taskId} in journey history.`);
    if (result.type === 'choice') {
      const choiceMeaning = task.type !== 'score' && task.type !== 'noul' ? task.options[result.choice] : undefined;
      if (choiceMeaning === undefined) throw new Error(`Unknown choice ${result.choice} for task ${event.taskId} in journey history.`);
      const response = { type: 'choice' as const, taskId: task.id, choiceId: result.choice, choiceMeaning, exposedItemIds: [...exposureIds], ...(result.probabilities === undefined ? {} : { probabilities: result.probabilities }), ...(result.confidence === undefined ? {} : { confidence: result.confidence }) };
      responses.push(response);
      choices.push({ taskId: task.id, choiceId: result.choice, choiceMeaning, exposedItemIds: [...exposureIds] });
    } else if (result.type === 'score') {
      if (task.type !== 'score' || result.legend[String(Math.round(result.score))] === undefined) throw new Error(`Score response does not match task ${event.taskId}.`);
      responses.push({ type: 'score', taskId: task.id, score: result.score, meaning: `Expected rubric level ${result.score}; rubric: ${task.rubric.join(' | ')}`, probabilities: result.probabilities, legend: result.legend, ...(result.confidence === undefined ? {} : { confidence: result.confidence }), exposedItemIds: [...exposureIds] });
    } else {
      if (task.type !== 'noul') throw new Error(`Noul response does not match task ${event.taskId}.`);
      responses.push({ type: 'noul', taskId: task.id, noul: result.noul, proposition: task.instructions, exposedItemIds: [...exposureIds] });
    }
  }

  const body = {
    version: 1 as const,
    eventCount: history.length,
    exposureCount: exposureIds.length,
    decisionCount: responses.length,
    eventRange: history.length === 0
      ? null
      : { firstSequence: history[0]!.sequence, lastSequence: history.at(-1)!.sequence },
    choices,
    responses,
  };
  return finishTrajectory(body);
}

export function compileDecisionPacket(
  arm: JourneyDefinition,
  profile: RespondentProfile,
  taskId: string,
  history: readonly PromptHistoryEvent[] = [],
): DecisionRequest & { state: PromptState } {
  const task = arm.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Unknown task ${taskId}.`);

  const itemsById = new Map(arm.items.map((item) => [item.id, item]));
  let itemIds: string[];
  if (arm.presentation.kind === 'sequence') {
    itemIds = arm.items.map((item) => item.id);
  } else {
    const lastChoiceIndex = history.findLastIndex((event) => event.type === 'choice' || event.type === 'response');
    itemIds = history.slice(lastChoiceIndex + 1)
      .filter((event): event is Extract<PromptHistoryEvent, { type: 'exposure' }> => event.type === 'exposure')
      .map((event) => event.itemId);
  }

  const encounteredItems = itemIds.map((id) => {
    const item = itemsById.get(id);
    if (!item) throw new Error(`Unknown encountered item ${id}.`);
    return { id: item.id, text: item.text };
  });
  return compileDecisionRequest({
    respondentProfile: {
      intent: profile.intent,
      context: profile.context,
      desired_outcome: profile.desired_outcome,
      engagement_cues: profile.engagement_cues,
      friction_cues: profile.friction_cues,
    },
    encounteredItems,
    trajectory: compactTrajectory(
      arm,
      task.responseHistory === 'omit'
        ? history.filter((event) => event.type === 'exposure')
        : history,
    ),
    question: questionForTask(task),
  });
}

export function compileDecisionRequest(parts: DecisionPacketParts): DecisionRequest & { state: PromptState } {
  const state: PromptState = {
    respondent: { profile: { ...parts.respondentProfile } },
    encounteredItems: parts.encounteredItems.map(({ id, text }) => ({ id, text })),
    trajectory: parts.trajectory,
  };
  const request = decisionRequestSchema.parse({
    state,
    question: parts.question,
    ...(parts.question.type === 'choice' ? { optionIds: Object.keys(parts.question.options) } : {}),
  });
  return {
    ...request,
    state,
  };
}

export function promptContractHash(): string {
  return createHash('sha256').update(JSON.stringify(promptContract)).digest('hex');
}
