import type { DecisionRequest } from '../decision/decision.js';
import { compileDecisionPacket, type PromptHistoryEvent } from '../decision/prompt.js';
import type { RespondentProfile } from '../respondents/profile.js';
import type { StudyArm } from '../study/arm.js';

export type ExposureEvent = Extract<PromptHistoryEvent, { type: 'exposure' }>;
export type ChoiceEvent = Extract<PromptHistoryEvent, { type: 'choice' }>;
export type JourneyEvent = PromptHistoryEvent;
export type JourneyResult = { events: JourneyEvent[]; outcome: string | null; status: 'completed' | 'decision-limit'; decisionCount: number };
export type JourneyOptions = { arm: StudyArm; profile: RespondentProfile; ask: (request: DecisionRequest, nodeId: string) => Promise<{ choice: string }> };

export class JourneyExecutionError extends Error {
  constructor(message: string) { super(message); this.name = 'JourneyExecutionError'; }
}

export async function runJourney({ arm, profile, ask }: JourneyOptions): Promise<JourneyResult> {
  const events: JourneyEvent[] = [];
  let decisionCount = 0;

  const expose = (itemId: string, nodeId: string): void => {
    events.push({ type: 'exposure', sequence: events.length, nodeId, itemId });
  };
  const answer = async (taskId: string, nodeId: string): Promise<string> => {
    const request = compileDecisionPacket(arm, profile, taskId, events);
    const result = await ask(request, nodeId);
    if (typeof result?.choice !== 'string' || !Object.hasOwn(request.question.options, result.choice)) {
      throw new JourneyExecutionError(`Task ${taskId} returned an option that was not offered.`);
    }
    decisionCount += 1;
    events.push({ type: 'choice', sequence: events.length, nodeId, taskId, choice: result.choice });
    return result.choice;
  };

  if (arm.presentation.kind === 'sequence') {
    for (const item of arm.items) expose(item.id, `sequence-expose-${item.id}`);
    for (const task of arm.tasks) await answer(task.id, `sequence-ask-${task.id}`);
    return { events, outcome: 'completed', status: 'completed', decisionCount };
  }

  const graph = arm.presentation;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  let current = graph.entryNodeId;
  while (true) {
    const node = nodes.get(current);
    if (!node) throw new JourneyExecutionError(`Graph points to unknown node ${current}.`);
    if (node.kind === 'terminal') return { events, outcome: node.outcome, status: 'completed', decisionCount };
    if (node.kind === 'expose') {
      expose(node.itemId, node.id);
      const edge = graph.transitions.find((candidate) => candidate.fromNodeId === node.id);
      if (!edge) throw new JourneyExecutionError(`Exposure node ${node.id} has no transition.`);
      current = edge.toNodeId;
      continue;
    }
    if (decisionCount >= graph.maxDecisions) return { events, outcome: null, status: 'decision-limit', decisionCount };
    const choice = await answer(node.taskId, node.id);
    const edge = graph.transitions.find((candidate) => candidate.fromNodeId === node.id && candidate.optionId === choice);
    if (!edge) throw new JourneyExecutionError(`Task node ${node.id} has no transition for ${choice}.`);
    current = edge.toNodeId;
  }
}
