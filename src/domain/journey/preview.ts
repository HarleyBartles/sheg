import { studyArmSchema, type StudyArm } from '../study/arm.js';
import type { ResponseInterval } from '../study/presentation.js';
import { journeyTopology } from './topology.js';

export const MAX_JOURNEY_PREVIEW_CONTEXTS = 10_000;

export type JourneyPreviewOption = {
  optionId: string;
  description: string;
  nextNodeId: string;
};

export type JourneyPreviewRoute = { when: ResponseInterval; description: string; nextNodeId: string };

export type JourneyPreviewNode =
  | { id: string; kind: 'stimulus'; stimulusId: string; text: string; nextNodeId: string }
  | {
    id: string;
    kind: 'question';
    taskId: string;
    responseType: 'choice' | 'score' | 'noul';
    instructions: string;
    options: JourneyPreviewOption[];
    routes: JourneyPreviewRoute[];
    responseHistory: 'include' | 'omit';
    routeContexts: JourneyPreviewRouteContext[];
  }
  | { id: string; kind: 'terminal'; outcome: string };

export type JourneyPreviewRouteContext = {
  path: Array<{ nodeId: string; optionId?: string; response?: { type: 'score' | 'noul'; when?: ResponseInterval; value?: number; meaning: string } }>;
  exposedStimulusIds: string[];
  priorChoices: Array<{
    nodeId: string;
    taskId: string;
    optionId: string;
    meaning: string;
    exposedItemIds: string[];
  }>;
  priorResponses: Array<{
    nodeId: string;
    taskId: string;
    response: { type: 'score' | 'noul'; when?: ResponseInterval; value?: number; meaning: string };
    exposedItemIds: string[];
  }>;
};

export type StudyArmJourneyPreview = {
  armId: string;
  label: string;
  presentation: 'sequence' | 'graph';
  entryNodeId: string;
  nodes: JourneyPreviewNode[];
};

export type StudyJourneyPreview = { arms: StudyArmJourneyPreview[] };

export function previewStudyJourney(arms: readonly StudyArm[]): StudyJourneyPreview {
  const budget = { contexts: 0 };
  return { arms: arms.map((rawArm) => previewArm(studyArmSchema.parse(rawArm), budget)) };
}

function previewArm(arm: StudyArm, budget: { contexts: number }): StudyArmJourneyPreview {
  const graph = journeyTopology(arm);
  const tasksById = new Map(arm.tasks.map((task) => [task.id, task]));
  const itemsById = new Map(arm.items.map((item) => [item.id, item]));
  const routeContextsByNode = graphRouteContexts(arm, budget);
  const nodes: JourneyPreviewNode[] = graph.nodes.map((node) => {
    if (node.kind === 'terminal') return { id: node.id, kind: 'terminal', outcome: node.outcome };
    if (node.kind === 'expose') {
      const item = itemsById.get(node.itemId)!;
      const edge = graph.transitions.find((candidate) => candidate.fromNodeId === node.id)!;
      return { id: node.id, kind: 'stimulus', stimulusId: item.id, text: item.text, nextNodeId: edge.toNodeId };
    }
    const task = tasksById.get(node.taskId)!;
    const options: JourneyPreviewOption[] = 'options' in task
      ? Object.entries(task.options).map(([optionId, description]) => {
        const edge = graph.transitions.find((candidate) => candidate.fromNodeId === node.id && candidate.optionId === optionId)!;
        return { optionId, description, nextNodeId: edge.toNodeId };
      })
      : [];
    const routes: JourneyPreviewRoute[] = 'options' in task ? [] : graph.transitions
      .filter((candidate) => candidate.fromNodeId === node.id && candidate.when !== undefined)
      .map((edge) => ({ when: edge.when!, description: intervalLabel(edge.when!), nextNodeId: edge.toNodeId }));
    return { id: node.id, kind: 'question', taskId: task.id, responseType: responseType(task), instructions: task.instructions, options, routes, responseHistory: task.responseHistory === 'omit' ? 'omit' : 'include', routeContexts: routeContextsByNode.get(node.id) ?? [] };
  });

  return {
    armId: arm.id,
    label: arm.label,
    presentation: arm.presentation.kind,
    entryNodeId: graph.entryNodeId,
    nodes,
  };
}

function graphRouteContexts(arm: StudyArm, budget: { contexts: number }): Map<string, JourneyPreviewRouteContext[]> {
  const graph = journeyTopology(arm);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const tasks = new Map(arm.tasks.map((task) => [task.id, task]));
  const items = new Map(arm.items.map((item) => [item.id, item]));
  const contexts = new Map<string, JourneyPreviewRouteContext[]>();

  const visit = (nodeId: string, path: JourneyPreviewRouteContext['path'], exposedSinceDecision: string[], allExposures: string[], priorChoices: JourneyPreviewRouteContext['priorChoices'], priorResponses: JourneyPreviewRouteContext['priorResponses']): void => {
    const node = nodes.get(nodeId)!;
    if (node.kind === 'terminal') return;
    if (node.kind === 'expose') {
      const item = items.get(node.itemId)!;
      const edge = graph.transitions.find((candidate) => candidate.fromNodeId === node.id)!;
      visit(edge.toNodeId, [...path, { nodeId }], [...exposedSinceDecision, item.id], [...allExposures, item.id], priorChoices, priorResponses);
      return;
    }

    const task = tasks.get(node.taskId)!;
    reserveContexts(budget, 1);
    const nodeContexts = contexts.get(node.id) ?? [];
    nodeContexts.push({ path: [...path, { nodeId }], exposedStimulusIds: [...exposedSinceDecision], priorChoices, priorResponses });
    contexts.set(node.id, nodeContexts);
    const branches: Array<{ optionId?: string; meaning: string; response?: { type: 'score' | 'noul'; when?: ResponseInterval; value?: number; meaning: string }; edge: { toNodeId: string } }> = 'options' in task
      ? taskOutcomeEntries(task).map((entry) => ({ ...entry, edge: graph.transitions.find((candidate) => candidate.fromNodeId === node.id && candidate.optionId === entry.optionId)! }))
      : graph.transitions.filter((candidate) => candidate.fromNodeId === node.id && candidate.when !== undefined).map((edge) => ({ meaning: intervalLabel(edge.when!), response: { type: edge.when!.type, when: edge.when!, meaning: intervalLabel(edge.when!) }, edge }));
    for (const branch of branches) {
      const step = branch.optionId !== undefined ? { nodeId, optionId: branch.optionId } : { nodeId, response: branch.response! };
      visit(branch.edge.toNodeId, [...path, step], [], allExposures, branch.optionId !== undefined ? [...priorChoices, {
        nodeId,
        taskId: task.id,
        optionId: branch.optionId,
        meaning: branch.meaning,
        exposedItemIds: [...allExposures],
      }] : priorChoices, branch.response ? [...priorResponses, { nodeId, taskId: task.id, response: branch.response, exposedItemIds: [...allExposures] }] : priorResponses);
    }
  };

  visit(graph.entryNodeId, [], [], [], [], []);
  return contexts;
}

function responseType(task: StudyArm['tasks'][number]): 'choice' | 'score' | 'noul' {
  if ('options' in task) return 'choice';
  if ('rubric' in task) return 'score';
  return 'noul';
}

type TaskOutcomeEntry = { optionId: string; meaning: string; response?: never } | { optionId?: never; meaning: string; response: { type: 'score' | 'noul'; value: number; meaning: string } };

function taskOutcomeEntries(task: StudyArm['tasks'][number]): TaskOutcomeEntry[] {
  if ('options' in task) return Object.entries(task.options).map(([optionId, meaning]) => ({ optionId, meaning }));
  if ('rubric' in task) return task.rubric.map((meaning, value) => ({ meaning: `Score ${value}: ${meaning}`, response: { type: 'score' as const, value, meaning: `Score ${value}: ${meaning}` } }));
  return [0, 0.5, 1].map((value) => ({ meaning: `P(true) = ${value}`, response: { type: 'noul' as const, value, meaning: `P(true) = ${value}` } }));
}

function intervalLabel(interval: ResponseInterval): string {
  const left = interval.minimumInclusive ? '[' : '(';
  const right = interval.maximumInclusive ? ']' : ')';
  return `${interval.type.toUpperCase()} ${left}${interval.minimum}, ${interval.maximum}${right}`;
}

function reserveContexts(budget: { contexts: number }, count: number): void {
  if (budget.contexts + count > MAX_JOURNEY_PREVIEW_CONTEXTS) throw contextLimitError();
  budget.contexts += count;
}

function contextLimitError(): RangeError {
  return new RangeError(`Journey preview exceeds the ${MAX_JOURNEY_PREVIEW_CONTEXTS}-context limit; no partial preview was returned.`);
}
