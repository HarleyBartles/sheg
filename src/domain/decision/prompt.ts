import { createHash } from 'node:crypto';
import type { DecisionRequest } from './decision.js';
import type { RespondentPerspective, RespondentProfile } from '../respondents/profile.js';
import type { StudyArm } from '../study/manifest.js';

export type ChoiceHistoryEvent = { taskId: string; choice: string };
export type PromptState = {
  respondent: { profile: RespondentPerspective };
  encounteredItems: Array<{ id: string; text: string }>;
  responseHistory: ChoiceHistoryEvent[];
};

const promptContract = {
  version: 4,
  stateFields: ['respondent.profile', 'encounteredItems', 'responseHistory'],
  onlyEncounteredItems: true,
  preserveEncounterOrder: true,
  historyOrder: 'chronological',
  studyMetadataExcluded: true,
  answerKeysExcluded: true,
  otherArmsExcluded: true,
  decisionSemantics: 'Choose exactly one offered stable option ID according to its description.',
} as const;

export function renderQuestion(
  arm: StudyArm,
  profile: RespondentProfile,
  taskId: string,
  encounteredItemIds: readonly string[],
  history: readonly ChoiceHistoryEvent[] = [],
): DecisionRequest & { state: PromptState } {
  const task = arm.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Unknown task ${taskId}.`);
  const itemsById = new Map(arm.items.map((item) => [item.id, item]));
  const encounteredItems = encounteredItemIds.map((id) => {
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
    responseHistory: history.map((event) => ({ ...event })),
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
