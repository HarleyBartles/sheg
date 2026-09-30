import { studyArmSchema, type StudyArm } from '../study/arm.js';

export const MAX_JOURNEY_PREVIEW_CONTEXTS = 10_000;

export type JourneyPreviewOption = {
  optionId: string;
  description: string;
  nextNodeId: string;
};

export type JourneyPreviewNode =
  | { id: string; kind: 'stimulus'; stimulusId: string; text: string; nextNodeId: string }
  | {
    id: string;
    kind: 'question';
    taskId: string;
    instructions: string;
    options: JourneyPreviewOption[];
    routeContexts: JourneyPreviewRouteContext[];
  }
  | { id: string; kind: 'terminal'; outcome: string };

export type JourneyPreviewRouteContext = {
  path: Array<{ nodeId: string; optionId?: string }>;
  exposedStimulusIds: string[];
  priorChoices: Array<{
    nodeId: string;
    taskId: string;
    optionId: string;
    meaning: string;
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
  if (arm.presentation.kind === 'sequence') {
    const stimulusNodes: JourneyPreviewNode[] = arm.items.map((item, index) => ({
      id: `sequence-expose-${item.id}`,
      kind: 'stimulus',
      stimulusId: item.id,
      text: item.text,
      nextNodeId: index + 1 < arm.items.length ? `sequence-expose-${arm.items[index + 1]!.id}` : `sequence-ask-${arm.tasks[0]!.id}`,
    }));
    const questionNodes: JourneyPreviewNode[] = arm.tasks.map((task, index) => {
      const routeContexts = sequenceRouteContexts(arm, index, budget);
      return {
        id: `sequence-ask-${task.id}`,
        kind: 'question',
        taskId: task.id,
        instructions: task.instructions,
        options: Object.entries(task.options).map(([optionId, description]) => ({
          optionId,
          description,
          nextNodeId: index + 1 < arm.tasks.length ? `sequence-ask-${arm.tasks[index + 1]!.id}` : `sequence-terminal-${arm.id}`,
        })),
        routeContexts,
      };
    });
    return {
      armId: arm.id,
      label: arm.label,
      presentation: 'sequence',
      entryNodeId: stimulusNodes[0]!.id,
      nodes: [...stimulusNodes, ...questionNodes, { id: `sequence-terminal-${arm.id}`, kind: 'terminal', outcome: 'completed' }],
    };
  }

  const tasksById = new Map(arm.tasks.map((task) => [task.id, task]));
  const itemsById = new Map(arm.items.map((item) => [item.id, item]));
  const routeContextsByNode = graphRouteContexts(arm, budget);
  const nodes: JourneyPreviewNode[] = arm.presentation.nodes.map((node) => {
    if (node.kind === 'terminal') return { id: node.id, kind: 'terminal', outcome: node.outcome };
    if (node.kind === 'expose') {
      const item = itemsById.get(node.itemId)!;
      const edge = arm.presentation.kind === 'graph'
        ? arm.presentation.transitions.find((candidate) => candidate.fromNodeId === node.id)!
        : undefined;
      return { id: node.id, kind: 'stimulus', stimulusId: item.id, text: item.text, nextNodeId: edge!.toNodeId };
    }
    const task = tasksById.get(node.taskId)!;
    const options: JourneyPreviewOption[] = Object.entries(task.options).map(([optionId, description]) => {
      const edge = arm.presentation.kind === 'graph'
        ? arm.presentation.transitions.find((candidate) => candidate.fromNodeId === node.id && candidate.optionId === optionId)
        : undefined;
      return { optionId, description, nextNodeId: edge!.toNodeId };
    });
    return { id: node.id, kind: 'question', taskId: task.id, instructions: task.instructions, options, routeContexts: routeContextsByNode.get(node.id) ?? [] };
  });

  return {
    armId: arm.id,
    label: arm.label,
    presentation: 'graph',
    entryNodeId: arm.presentation.entryNodeId,
    nodes,
  };
}

function sequenceRouteContexts(arm: StudyArm, taskIndex: number, budget: { contexts: number }): JourneyPreviewRouteContext[] {
  const priorTasks = arm.tasks.slice(0, taskIndex);
  let contextCount = 1;
  for (const task of priorTasks) {
    const optionCount = Object.keys(task.options).length;
    if (contextCount > MAX_JOURNEY_PREVIEW_CONTEXTS / optionCount) throw contextLimitError();
    contextCount *= optionCount;
  }
  reserveContexts(budget, contextCount);

  const exposedStimulusIds = arm.items.map(({ id }) => id);
  let contexts: JourneyPreviewRouteContext[] = [{ path: arm.items.map((item) => ({ nodeId: `sequence-expose-${item.id}` })), exposedStimulusIds, priorChoices: [] }];
  for (const task of priorTasks) {
    contexts = contexts.flatMap((context) => Object.entries(task.options).map(([optionId, meaning]) => ({
      path: [...context.path, { nodeId: `sequence-ask-${task.id}`, optionId }],
      exposedStimulusIds,
      priorChoices: [...context.priorChoices, {
        nodeId: `sequence-ask-${task.id}`,
        taskId: task.id,
        optionId,
        meaning,
        exposedItemIds: [...exposedStimulusIds],
      }],
    })));
  }
  return contexts.map((context) => ({
    ...context,
    path: [...context.path, { nodeId: `sequence-ask-${arm.tasks[taskIndex]!.id}` }],
  }));
}

function graphRouteContexts(arm: StudyArm, budget: { contexts: number }): Map<string, JourneyPreviewRouteContext[]> {
  if (arm.presentation.kind !== 'graph') throw new Error('Graph route contexts require a graph presentation.');
  const graph = arm.presentation;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const tasks = new Map(arm.tasks.map((task) => [task.id, task]));
  const items = new Map(arm.items.map((item) => [item.id, item]));
  const contexts = new Map<string, JourneyPreviewRouteContext[]>();

  const visit = (nodeId: string, path: JourneyPreviewRouteContext['path'], exposedSinceDecision: string[], allExposures: string[], priorChoices: JourneyPreviewRouteContext['priorChoices']): void => {
    const node = nodes.get(nodeId)!;
    if (node.kind === 'terminal') return;
    if (node.kind === 'expose') {
      const item = items.get(node.itemId)!;
      const edge = graph.transitions.find((candidate) => candidate.fromNodeId === node.id)!;
      visit(edge.toNodeId, [...path, { nodeId }], [...exposedSinceDecision, item.id], [...allExposures, item.id], priorChoices);
      return;
    }

    const task = tasks.get(node.taskId)!;
    reserveContexts(budget, 1);
    const nodeContexts = contexts.get(node.id) ?? [];
    nodeContexts.push({ path: [...path, { nodeId }], exposedStimulusIds: [...exposedSinceDecision], priorChoices });
    contexts.set(node.id, nodeContexts);
    for (const [optionId, meaning] of Object.entries(task.options)) {
      const edge = graph.transitions.find((candidate) => candidate.fromNodeId === node.id && candidate.optionId === optionId)!;
      visit(edge.toNodeId, [...path, { nodeId, optionId }], [], allExposures, [...priorChoices, {
        nodeId,
        taskId: task.id,
        optionId,
        meaning,
        exposedItemIds: [...allExposures],
      }]);
    }
  };

  visit(graph.entryNodeId, [], [], [], []);
  return contexts;
}

function reserveContexts(budget: { contexts: number }, count: number): void {
  if (budget.contexts + count > MAX_JOURNEY_PREVIEW_CONTEXTS) throw contextLimitError();
  budget.contexts += count;
}

function contextLimitError(): RangeError {
  return new RangeError(`Journey preview exceeds the ${MAX_JOURNEY_PREVIEW_CONTEXTS}-context limit; no partial preview was returned.`);
}
