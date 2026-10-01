import { decisionValueSchema, type DecisionRequest, type DecisionResult, type DecisionValue } from '../decision/decision.js';
import { compileDecisionPacket, type PromptHistoryEvent } from '../decision/prompt.js';
import type { RespondentProfile } from '../respondents/profile.js';
import type { JourneyDefinition } from '../study/arm.js';

export type ExposureEvent = Extract<PromptHistoryEvent, { type: 'exposure' }>;
export type ChoiceEvent = Extract<PromptHistoryEvent, { type: 'choice' }>;
export type JourneyEvent = PromptHistoryEvent;
export type JourneyResult = { events: JourneyEvent[]; outcome: string | null; status: 'completed' | 'decision-limit'; decisionCount: number };
export type JourneyOptions = { arm: JourneyDefinition; profile: RespondentProfile; ask: (request: DecisionRequest, nodeId: string) => Promise<DecisionResult | DecisionValue | { choice: string }> };

export class JourneyExecutionError extends Error {
  constructor(message: string) { super(message); this.name = 'JourneyExecutionError'; }
}

export async function runJourney({ arm, profile, ask }: JourneyOptions): Promise<JourneyResult> {
  const events: JourneyEvent[] = [];
  let decisionCount = 0;

  const expose = (itemId: string, nodeId: string): void => {
    events.push({ type: 'exposure', sequence: events.length, nodeId, itemId });
  };
  const answer = async (taskId: string, nodeId: string): Promise<DecisionValue> => {
    const request = compileDecisionPacket(arm, profile, taskId, events);
    const result = normalizeResponse(await ask(request, nodeId), request.question.type);
    if (result.type !== request.question.type) throw new JourneyExecutionError(`Task ${taskId} returned ${result.type} for a ${request.question.type} question.`);
    if (result.type === 'choice' && (typeof result.choice !== 'string' || request.question.type !== 'choice' || !Object.hasOwn(request.question.options, result.choice))) throw new JourneyExecutionError(`Task ${taskId} returned an option that was not offered.`);
    decisionCount += 1;
    events.push({ type: 'response', sequence: events.length, nodeId, taskId, result });
    return result;
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
    const response = await answer(node.taskId, node.id);
    const edge = graph.transitions.find((candidate) => {
      if (candidate.fromNodeId !== node.id) return false;
      if (response.type === 'choice') return candidate.optionId === response.choice;
      if (!candidate.when || candidate.when.type !== response.type) return false;
      const value = response.type === 'score' ? response.score : response.noul;
      return (value > candidate.when.minimum || (candidate.when.minimumInclusive && value === candidate.when.minimum)) &&
        (value < candidate.when.maximum || (candidate.when.maximumInclusive && value === candidate.when.maximum));
    });
    if (!edge) throw new JourneyExecutionError(`Task node ${node.id} has no transition for ${response.type} response.`);
    current = edge.toNodeId;
  }
}

function normalizeResponse(answer: DecisionResult | DecisionValue | { choice: string }, expectedType: DecisionRequest['question']['type']): DecisionValue {
  if (typeof answer !== 'object' || answer === null) throw new JourneyExecutionError('Task returned a response that is not an object.');
  const raw = answer as unknown as Record<string, unknown>;
  const actualType = raw.type ?? expectedType;
  if (actualType !== expectedType) throw new JourneyExecutionError(`Task returned ${String(actualType)} for a ${expectedType} question.`);
  const value = actualType === 'choice'
    ? { type: 'choice', choice: raw.choice, ...(raw.probabilities === undefined ? {} : { probabilities: raw.probabilities }), ...(raw.confidence === undefined ? {} : { confidence: raw.confidence }) }
    : actualType === 'score'
      ? { type: 'score', score: raw.score, legend: raw.legend, probabilities: raw.probabilities, ...(raw.confidence === undefined ? {} : { confidence: raw.confidence }) }
      : { type: 'noul', noul: raw.noul };
  const parsed = decisionValueSchema.safeParse(value);
  if (!parsed.success) throw new JourneyExecutionError(`Task returned an invalid ${expectedType} response.`);
  return parsed.data;
}
