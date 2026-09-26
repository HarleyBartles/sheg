import { createHash } from 'node:crypto';
import type { DecisionRequest } from './contract.js';
import type { ReaderProfile } from '../readers/profile.js';
import type { StudyManifest } from '../study/manifest.js';

export type ChoiceHistoryEvent = { nodeId: string; choice: string };
export type PromptState = {
  reader: { profile: string };
  encounteredItems: Array<{ id: string; text: string }>;
  choiceHistory: ChoiceHistoryEvent[];
};

const promptContract = {
  version: 1,
  stateFields: ['reader.profile', 'encounteredItems', 'choiceHistory'],
  onlyEncounteredItems: true,
  preserveEncounterOrder: true,
  historyOrder: 'chronological',
  studyMetadataExcluded: true,
  decisionSemantics: 'Choose exactly one offered label according to the supplied criteria.',
} as const;

export function renderQuestion(
  study: StudyManifest,
  profile: ReaderProfile,
  decisionId: string,
  encounteredItemIds: readonly string[],
  history: readonly ChoiceHistoryEvent[] = [],
): DecisionRequest & { state: PromptState } {
  const decision = study.decisions.find((candidate) => candidate.id === decisionId);
  if (!decision) throw new Error(`Unknown decision ${decisionId}.`);
  const itemsById = new Map(study.items.map((item) => [item.id, item]));
  const encounteredItems = encounteredItemIds.map((id) => {
    const item = itemsById.get(id);
    if (!item) throw new Error(`Unknown encountered item ${id}.`);
    return { id: item.id, text: item.text };
  });
  const state: PromptState = {
    reader: { profile: profile.profileText },
    encounteredItems,
    choiceHistory: history.map((event) => ({ ...event })),
  };
  return {
    state,
    question: {
      id: decision.id,
      instructions: decision.instructions,
      criteria: { ...decision.criteria },
    },
    labels: Object.keys(decision.criteria),
  };
}

export function promptContractHash(): string {
  return createHash('sha256').update(JSON.stringify(promptContract)).digest('hex');
}
