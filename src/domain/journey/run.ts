import { decisionValueSchema, type DecisionRequest, type DecisionResult, type DecisionValue } from '../decision/decision.js';
import { compileDecisionPacket, type PromptHistoryEvent } from '../decision/prompt.js';
import type { RespondentProfile } from '../respondents/profile.js';
import type { JourneyDefinition } from '../study/arm.js';
import type { PromptState } from '../decision/prompt.js';

export type ExposureEvent = Extract<PromptHistoryEvent, { type: 'exposure' }>;
export type ChoiceEvent = Extract<PromptHistoryEvent, { type: 'choice' }>;
export type JourneyEvent = PromptHistoryEvent;
export type JourneyResult = { events: JourneyEvent[]; outcome: string | null; status: 'completed' | 'decision-limit'; decisionCount: number };
export type JourneyOptions = { arm: JourneyDefinition; profile: RespondentProfile; ask: (request: DecisionRequest, nodeId: string) => Promise<DecisionResult | DecisionValue | { choice: string }> };

export class JourneyExecutionError extends Error {
  constructor(message: string) { super(message); this.name = 'JourneyExecutionError'; }
}

export type JourneyProgress = {
  events: JourneyEvent[];
  route: Array<{ nodeId: string; response: DecisionValue; toNodeId: string }>;
  status: 'active' | 'completed';
  outcome: string | null;
  next?: { nodeId: string; taskId: string; pathId: string; packet: DecisionRequest & { state: PromptState } };
};

export function advanceJourney(
  arm: JourneyDefinition,
  profile: RespondentProfile,
  state: { currentNodeId: string; events: readonly JourneyEvent[]; route: readonly JourneyProgress['route'][number][] },
  rawResult: DecisionValue,
): JourneyProgress {
  const result = decisionValueSchema.parse(rawResult);
  const events = [...state.events];
  const route = [...state.route];
  const nodeId = state.currentNodeId;
  let taskId: string;
  let routeTarget: string;

  if (arm.presentation.kind === 'sequence') {
    const taskIndex = arm.tasks.findIndex((task) => `sequence-ask-${task.id}` === nodeId);
    const task = arm.tasks[taskIndex];
    if (taskIndex < 0 || !task) throw new JourneyExecutionError(`Unknown sequence ask node ${nodeId}.`);
    taskId = task.id;
    routeTarget = arm.tasks[taskIndex + 1] ? `sequence-ask-${arm.tasks[taskIndex + 1]!.id}` : 'sequence-terminal-complete';
  } else {
    const askNode = arm.presentation.nodes.find((node) => node.id === nodeId);
    if (askNode?.kind !== 'ask') throw new JourneyExecutionError(`Node ${nodeId} is not a journey ask node.`);
    taskId = askNode.taskId;
    const task = arm.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new JourneyExecutionError(`Ask node ${nodeId} references unknown task ${taskId}.`);
    const edge = arm.presentation.transitions.find((candidate) => {
      if (candidate.fromNodeId !== nodeId) return false;
      if (result.type === 'choice') return candidate.optionId === result.choice;
      const interval = candidate.when;
      const value = result.type === 'score' ? result.score : result.noul;
      return interval?.type === result.type &&
        (value > interval.minimum || value === interval.minimum && interval.minimumInclusive) &&
        (value < interval.maximum || value === interval.maximum && interval.maximumInclusive);
    });
    if (!edge) throw new JourneyExecutionError(`Task node ${nodeId} has no transition for ${result.type} response.`);
    routeTarget = edge.toNodeId;
  }

  const answerEvent: Extract<JourneyEvent, { type: 'response' }> = { type: 'response', sequence: events.length, nodeId, taskId, result };
  events.push(answerEvent);
  route.push({ nodeId, response: result, toNodeId: routeTarget });
  const pathId = route.length === 0 ? 'root' : route.map(({ nodeId: routeNode, response }) => `${routeNode}=${response.type === 'choice' ? response.choice : `${response.type}:${response.type === 'score' ? response.score : response.noul}`}`).join('>');

  if (arm.presentation.kind === 'sequence') {
    const nextTask = arm.tasks.find((task) => `sequence-ask-${task.id}` === routeTarget);
    if (!nextTask) return { events, route, status: 'completed', outcome: 'complete' };
    return { events, route, status: 'active', outcome: null, next: { nodeId: routeTarget, taskId: nextTask.id, pathId, packet: compileDecisionPacket(arm, profile, nextTask.id, events) } };
  }

  const nodes = new Map(arm.presentation.nodes.map((node) => [node.id, node]));
  let current = routeTarget;
  while (true) {
    const node = nodes.get(current);
    if (!node) throw new JourneyExecutionError(`Graph points to unknown node ${current}.`);
    if (node.kind === 'terminal') return { events, route, status: 'completed', outcome: node.outcome };
    if (node.kind === 'expose') {
      events.push({ type: 'exposure', sequence: events.length, nodeId: node.id, itemId: node.itemId });
      const edge = arm.presentation.transitions.find((candidate) => candidate.fromNodeId === node.id);
      if (!edge) throw new JourneyExecutionError(`Exposure node ${node.id} has no transition.`);
      current = edge.toNodeId;
      continue;
    }
    return { events, route, status: 'active', outcome: null, next: { nodeId: node.id, taskId: node.taskId, pathId, packet: compileDecisionPacket(arm, profile, node.taskId, events) } };
  }
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

export function normalizeResponse(answer: DecisionResult | DecisionValue | { choice: string }, expectedType: DecisionRequest['question']['type']): DecisionValue {
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
