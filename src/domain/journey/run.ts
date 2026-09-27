import type { DecisionRequest } from '../decision/decision.js';
import { renderQuestion, type ChoiceHistoryEvent } from '../decision/prompt.js';
import type { RespondentProfile } from '../respondents/profile.js';
import type { StudyArm } from '../study/manifest.js';

export type ExposureEvent = { type: 'exposure'; sequence: number; nodeId: string; itemId: string };
export type ChoiceEvent = { type: 'choice'; sequence: number; nodeId: string; taskId: string; choice: string };
export type JourneyEvent = ExposureEvent | ChoiceEvent;
export type JourneyResult = { events: JourneyEvent[]; outcome: string | null; status: 'completed' | 'decision-limit'; decisionCount: number };
export type JourneyOptions = { arm: StudyArm; profile: RespondentProfile; ask: (request: DecisionRequest) => Promise<{ choice: string }> };

export class JourneyExecutionError extends Error {
  constructor(message: string) { super(message); this.name = 'JourneyExecutionError'; }
}

export async function runJourney({ arm, profile, ask }: JourneyOptions): Promise<JourneyResult> {
  const events: JourneyEvent[] = [];
  const encountered: string[] = [];
  const history: ChoiceHistoryEvent[] = [];
  let decisionCount = 0;

  const expose = (itemId: string, nodeId: string): void => {
    encountered.push(itemId);
    events.push({ type: 'exposure', sequence: events.length, nodeId, itemId });
  };
  const answer = async (taskId: string, nodeId: string): Promise<string> => {
    const request = renderQuestion(arm, profile, taskId, encountered, history);
    const result = await ask(request);
    if (typeof result?.choice !== 'string' || !Object.hasOwn(request.question.options, result.choice)) {
      throw new JourneyExecutionError(`Task ${taskId} returned an option that was not offered.`);
    }
    decisionCount += 1;
    history.push({ taskId, choice: result.choice });
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
