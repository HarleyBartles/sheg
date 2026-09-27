import { createHash } from 'node:crypto';
import type { DecisionRequest } from './decision.js';
import type { RespondentPerspective, RespondentProfile } from '../respondents/profile.js';
import type { StudyArm } from '../study/arm.js';

export type PromptHistoryEvent =
  | { type: 'exposure'; sequence: number; nodeId: string; itemId: string }
  | { type: 'choice'; sequence: number; nodeId: string; taskId: string; choice: string };

export type TrajectoryChoice = {
  taskId: string;
  choiceId: string;
  choiceMeaning: string;
  exposedItemIds: string[];
};

export type TrajectorySummary = {
  version: 1;
  eventCount: number;
  exposureCount: number;
  decisionCount: number;
  eventRange: { firstSequence: number; lastSequence: number } | null;
  choices: TrajectoryChoice[];
  payloadUtf8Bytes: number;
};

export type PromptState = {
  respondent: { profile: RespondentPerspective };
  encounteredItems: Array<{ id: string; text: string }>;
  trajectory: TrajectorySummary;
};

const promptContract = {
  version: 5,
  stateFields: ['respondent.profile', 'encounteredItems', 'trajectory'],
  graphExposureWindow: 'items exposed since the previous decision',
  sequenceExposureWindow: 'all arm items for every task',
  trajectory: ['prior task and choice IDs', 'selected choice meanings', 'prior exposure IDs', 'event counts and range'],
  onlyCurrentGraphExposureText: true,
  preserveEncounterOrder: true,
  historyOrder: 'chronological',
  studyMetadataExcluded: true,
  answerKeysExcluded: true,
  otherArmsExcluded: true,
  decisionSemantics: 'Choose exactly one offered stable option ID according to its description.',
} as const;

function compactTrajectory(arm: StudyArm, history: readonly PromptHistoryEvent[]): TrajectorySummary {
  const exposureIds: string[] = [];
  const choices: TrajectoryChoice[] = [];
  for (const event of history) {
    if (event.type === 'exposure') {
      exposureIds.push(event.itemId);
      continue;
    }
    const task = arm.tasks.find((candidate) => candidate.id === event.taskId);
    const choiceMeaning = task?.options[event.choice];
    if (!task || choiceMeaning === undefined) {
      throw new Error(`Unknown choice ${event.choice} for task ${event.taskId} in journey history.`);
    }
    choices.push({
      taskId: event.taskId,
      choiceId: event.choice,
      choiceMeaning,
      exposedItemIds: [...exposureIds],
    });
  }

  const body = {
    version: 1 as const,
    eventCount: history.length,
    exposureCount: exposureIds.length,
    decisionCount: choices.length,
    eventRange: history.length === 0
      ? null
      : { firstSequence: history[0]!.sequence, lastSequence: history.at(-1)!.sequence },
    choices,
  };
  let payloadUtf8Bytes = 0;
  for (;;) {
    const nextSize = new TextEncoder().encode(JSON.stringify({ ...body, payloadUtf8Bytes })).length;
    if (nextSize === payloadUtf8Bytes) break;
    payloadUtf8Bytes = nextSize;
  }
  return { ...body, payloadUtf8Bytes };
}

export function compileDecisionPacket(
  arm: StudyArm,
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
    const lastChoiceIndex = history.findLastIndex((event) => event.type === 'choice');
    itemIds = history.slice(lastChoiceIndex + 1)
      .filter((event): event is Extract<PromptHistoryEvent, { type: 'exposure' }> => event.type === 'exposure')
      .map((event) => event.itemId);
  }

  const encounteredItems = itemIds.map((id) => {
    const item = itemsById.get(id);
    if (!item) throw new Error(`Unknown encountered item ${id}.`);
    return { id: item.id, text: item.text };
  });
  const state: PromptState = {
    respondent: { profile: {
      intent: profile.intent,
      context: profile.context,
      desired_outcome: profile.desired_outcome,
      engagement_cues: profile.engagement_cues,
      friction_cues: profile.friction_cues,
    } },
    encounteredItems,
    trajectory: compactTrajectory(arm, history),
  };
  return {
    state,
    question: { id: task.id, instructions: task.instructions, options: { ...task.options } },
    optionIds: Object.keys(task.options),
  };
}

export function promptContractHash(): string {
  return createHash('sha256').update(JSON.stringify(promptContract)).digest('hex');
}
