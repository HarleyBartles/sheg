import type { DecisionRequest } from '../decision/contract.js';
import { renderQuestion, type ChoiceHistoryEvent } from '../decision/prompt.js';
import type { ReaderProfile } from '../readers/profile.js';
import type { StudyManifest } from '../study/manifest.js';

export type ExposureEvent = {
  type: 'exposure';
  sequence: number;
  nodeId: string;
  itemId: string;
};

export type ChoiceEvent = {
  type: 'choice';
  sequence: number;
  nodeId: string;
  decisionId: string;
  choice: string;
};

export type JourneyEvent = ExposureEvent | ChoiceEvent;

export type JourneyResult = {
  events: JourneyEvent[];
  outcome: string | null;
  status: 'completed' | 'decision-limit';
  decisionCount: number;
};

export type JourneyOptions = {
  study: StudyManifest;
  profile: ReaderProfile;
  ask: (request: DecisionRequest) => Promise<{ choice: string }>;
};

export class JourneyExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JourneyExecutionError';
  }
}

export async function runJourney({ study, profile, ask }: JourneyOptions): Promise<JourneyResult> {
  const nodesById = new Map(study.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, typeof study.transitions>();
  for (const transition of study.transitions) {
    const edges = outgoing.get(transition.fromNodeId) ?? [];
    outgoing.set(transition.fromNodeId, [...edges, transition]);
  }

  const events: JourneyEvent[] = [];
  const encounteredItemIds: string[] = [];
  const choiceHistory: ChoiceHistoryEvent[] = [];
  let decisionCount = 0;
  let currentNodeId = study.entryNodeId;

  while (true) {
    const node = nodesById.get(currentNodeId);
    if (!node) throw new JourneyExecutionError(`Graph points to unknown node ${currentNodeId}.`);

    if (node.kind === 'terminal') {
      return { events, outcome: node.outcome, status: 'completed', decisionCount };
    }

    if (node.kind === 'expose') {
      encounteredItemIds.push(node.itemId);
      events.push({
        type: 'exposure',
        sequence: events.length,
        nodeId: node.id,
        itemId: node.itemId,
      });
      const [transition] = outgoing.get(node.id) ?? [];
      if (!transition || transition.choice !== undefined) {
        throw new JourneyExecutionError(`Exposure node ${node.id} must have one unconditional transition.`);
      }
      currentNodeId = transition.toNodeId;
      continue;
    }

    if (decisionCount >= study.maxDecisions) {
      return { events, outcome: null, status: 'decision-limit', decisionCount };
    }

    const request = renderQuestion(study, profile, node.decisionId, encounteredItemIds, choiceHistory);
    const result = await ask(request);
    if (typeof result?.choice !== 'string' || !Object.hasOwn(request.question.criteria, result.choice)) {
      throw new JourneyExecutionError(`Decision ${node.decisionId} returned a choice that is not an offered choice.`);
    }

    decisionCount += 1;
    choiceHistory.push({ nodeId: node.id, choice: result.choice });
    events.push({
      type: 'choice',
      sequence: events.length,
      nodeId: node.id,
      decisionId: node.decisionId,
      choice: result.choice,
    });
    const transition = (outgoing.get(node.id) ?? []).find((edge) => edge.choice === result.choice);
    if (!transition) {
      throw new JourneyExecutionError(`Decision node ${node.id} has no transition for ${result.choice}.`);
    }
    currentNodeId = transition.toNodeId;
  }
}
