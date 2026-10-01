import { z } from 'zod';
import { presentationSchema, type PresentationTransition } from './presentation.js';
import { sourceReferenceSchema, stimulusItemSchema } from './stimulus.js';
import { taskSchema } from './task.js';
import type { StudyTask } from './task.js';

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const prose = z.string().trim().min(1);

const journeyDefinitionFields = {
  id: identifier,
  label: prose,
  items: z.array(stimulusItemSchema).min(1),
  tasks: z.array(taskSchema).min(1),
  presentation: presentationSchema,
};

export const journeyDefinitionSchema = z.object(journeyDefinitionFields).strict().superRefine(validateJourneyDefinition);
type ParsedJourneyDefinition = z.output<typeof journeyDefinitionSchema>;

export const studyArmSchema = z.object({
  ...journeyDefinitionFields,
  sources: z.array(sourceReferenceSchema).min(1),
}).strict().superRefine(validateJourneyDefinition);

function validateJourneyDefinition(arm: JourneyDefinition, context: z.RefinementCtx): void {
  const presentation = arm.presentation;
  const nodeValues = presentation.kind === 'sequence' ? [] : presentation.nodes;
  const nodeIds = new Set(nodeValues.map((node) => node.id));
  const itemIds = new Set(arm.items.map((item) => item.id));
  const taskById = new Map(arm.tasks.map((task) => [task.id, task]));
  const allIds = [...itemIds, ...taskById.keys(), ...nodeIds];
  if (new Set(allIds).size !== allIds.length) {
    context.addIssue({ code: 'custom', path: ['presentation'], message: 'Item, task, and graph node IDs must be unique within an arm.' });
  }
  const comparisonKeys = arm.tasks.flatMap((task) => task.comparisonKey ? [task.comparisonKey] : []);
  if (new Set(comparisonKeys).size !== comparisonKeys.length) {
    context.addIssue({ code: 'custom', path: ['tasks'], message: 'Each comparisonKey must identify at most one task within an arm.' });
  }

  if (presentation.kind === 'sequence') return;

  const nodesById = new Map(presentation.nodes.map((node) => [node.id, node]));
  if (!nodesById.has(presentation.entryNodeId)) {
    context.addIssue({ code: 'custom', path: ['presentation', 'entryNodeId'], message: `Unknown entry node ${presentation.entryNodeId}.` });
  }

  for (const [index, node] of presentation.nodes.entries()) {
    if (node.kind === 'expose' && !itemIds.has(node.itemId)) {
      context.addIssue({ code: 'custom', path: ['presentation', 'nodes', index, 'itemId'], message: `Node references unknown item ${node.itemId}.` });
    }
    if (node.kind === 'ask' && !taskById.has(node.taskId)) {
      context.addIssue({ code: 'custom', path: ['presentation', 'nodes', index, 'taskId'], message: `Node references unknown task ${node.taskId}.` });
    }
  }

  const outgoing = new Map<string, typeof presentation.transitions>();
  for (const [index, edge] of presentation.transitions.entries()) {
    const source = nodesById.get(edge.fromNodeId);
    if (!source) {
      context.addIssue({ code: 'custom', path: ['presentation', 'transitions', index, 'fromNodeId'], message: `Transition references unknown source node ${edge.fromNodeId}.` });
      continue;
    }
    if (!nodesById.has(edge.toNodeId)) {
      context.addIssue({ code: 'custom', path: ['presentation', 'transitions', index, 'toNodeId'], message: `Transition references unknown target node ${edge.toNodeId}.` });
    }
    const edges = outgoing.get(edge.fromNodeId) ?? [];
    outgoing.set(edge.fromNodeId, [...edges, edge]);
    if (source.kind === 'terminal') {
      context.addIssue({ code: 'custom', path: ['presentation', 'transitions', index], message: 'Terminal nodes cannot have outgoing transitions.' });
    }
    if (source.kind === 'expose' && (edge.optionId !== undefined || edge.when !== undefined)) {
      context.addIssue({ code: 'custom', path: ['presentation', 'transitions', index], message: 'Exposure transitions must be unconditional.' });
    }
  }

  for (const [index, node] of presentation.nodes.entries()) {
    const edges = outgoing.get(node.id) ?? [];
    if (node.kind === 'terminal') {
      if (edges.length > 0) context.addIssue({ code: 'custom', path: ['presentation', 'nodes', index], message: 'Terminal nodes cannot have outgoing transitions.' });
      continue;
    }
    if (node.kind === 'expose') {
      if (edges.length !== 1 || edges[0]?.optionId !== undefined || edges[0]?.when !== undefined) {
        context.addIssue({ code: 'custom', path: ['presentation', 'nodes', index], message: 'Each exposure node must have exactly one unconditional transition.' });
      }
      continue;
    }
    const task = taskById.get(node.taskId);
    if (!task) continue;
    if (task.type !== 'score' && task.type !== 'noul') {
      const optionIds = Object.keys(task.options);
      const edgeOptionIds = edges.map((edge) => edge.optionId);
      if (edges.some((edge) => edge.when !== undefined) ||
          edgeOptionIds.some((optionId) => optionId === undefined) ||
          new Set(edgeOptionIds).size !== edgeOptionIds.length ||
          edgeOptionIds.length !== optionIds.length ||
          optionIds.some((optionId) => !edgeOptionIds.includes(optionId))) {
        context.addIssue({ code: 'custom', path: ['presentation', 'nodes', index], message: 'Choice task transitions must contain exactly one edge for every offered option and no others.' });
      }
    } else {
      const maximum = task.type === 'score' ? task.rubric.length - 1 : 1;
      validateResponseIntervals(edges, task.type, maximum, context, index);
    }
  }

  if (nodesById.has(presentation.entryNodeId)) {
    const visited = new Set<string>();
    const pending = [presentation.entryNodeId];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const edge of outgoing.get(current) ?? []) pending.push(edge.toNodeId);
    }
    const unreachable = presentation.nodes.filter((node) => !visited.has(node.id)).map((node) => node.id);
    if (unreachable.length > 0) {
      context.addIssue({ code: 'custom', path: ['presentation', 'nodes'], message: `Graph contains unreachable nodes: ${unreachable.join(', ')}.` });
    }

    const state = new Map<string, 'visiting' | 'visited'>();
    const decisionsToTerminal = new Map<string, number | null>();
    let containsCycle = false;
    const longestDecisionsToTerminal = (nodeId: string): number | null => {
      const node = nodesById.get(nodeId);
      if (!node) return null;
      if (state.get(nodeId) === 'visiting') {
        containsCycle = true;
        return null;
      }
      if (state.get(nodeId) === 'visited') return decisionsToTerminal.get(nodeId) ?? null;

      state.set(nodeId, 'visiting');
      let longest: number | null;
      if (node.kind === 'terminal') {
        longest = 0;
      } else {
        const edges = outgoing.get(nodeId) ?? [];
        const continuations = edges.map((edge) => longestDecisionsToTerminal(edge.toNodeId));
        const completedContinuations = continuations.filter((count): count is number => count !== null);
        if (continuations.length === 0 || completedContinuations.length !== continuations.length) {
          longest = null;
        } else {
          const nextDecisionCount = Math.max(...completedContinuations);
          longest = nextDecisionCount + (node.kind === 'ask' ? 1 : 0);
        }
      }
      state.set(nodeId, 'visited');
      decisionsToTerminal.set(nodeId, longest);
      return longest;
    };

    const longestPath = longestDecisionsToTerminal(presentation.entryNodeId);
    if (containsCycle) {
      context.addIssue({ code: 'custom', path: ['presentation', 'nodes'], message: 'Graph contains a cycle; every journey must terminate.' });
    } else if (longestPath === null) {
      context.addIssue({ code: 'custom', path: ['presentation', 'nodes'], message: 'Every graph branch must reach a terminal node.' });
    } else if (longestPath > presentation.maxDecisions) {
      context.addIssue({
        code: 'custom',
        path: ['presentation', 'maxDecisions'],
        message: `A graph branch requires ${longestPath} decisions, exceeding maxDecisions (${presentation.maxDecisions}).`,
      });
    }
  }
}

type ParsedStudyArm = z.infer<typeof studyArmSchema>;
export type StudyArm = Omit<ParsedStudyArm, 'tasks'> & { tasks: StudyTask[] };
export type JourneyDefinition = Omit<ParsedJourneyDefinition, 'tasks'> & { tasks: StudyTask[] };

function validateResponseIntervals(
  edges: readonly PresentationTransition[],
  type: 'score' | 'noul',
  maximum: number,
  context: z.RefinementCtx,
  nodeIndex: number,
): void {
  const issues = context;
  const ranges = edges.map((edge, index) => ({ edge, index, range: edge.when }));
  const fail = (message: string): void => issues.addIssue({
    code: 'custom', path: ['presentation', 'nodes', nodeIndex], message,
  });
  if (ranges.some(({ edge, range }) => edge.optionId !== undefined || range === undefined || range.type !== type)) {
    fail(`${type.toUpperCase()} task transitions must use matching typed response intervals only.`);
    return;
  }
  const ordered = ranges.toSorted((left, right) => left.range!.minimum - right.range!.minimum || Number(right.range!.minimumInclusive) - Number(left.range!.minimumInclusive));
  for (const { range } of ordered) {
    if (range!.minimum > range!.maximum || range!.minimum < 0 || range!.maximum > maximum ||
        (range!.minimum === range!.maximum && !(range!.minimumInclusive && range!.maximumInclusive))) {
      fail(`${type.toUpperCase()} route interval is reversed, empty, or outside its response domain.`);
      return;
    }
  }
  const first = ordered[0]?.range;
  const last = ordered.at(-1)?.range;
  if (!first || !last || first.minimum !== 0 || !first.minimumInclusive || last.maximum !== maximum || !last.maximumInclusive) {
    fail(`${type.toUpperCase()} route intervals must cover the complete response domain.`);
    return;
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!.range!;
    const current = ordered[index]!.range!;
    if (previous.maximum > current.minimum ||
        (previous.maximum === current.minimum && previous.maximumInclusive && current.minimumInclusive)) {
      fail(`${type.toUpperCase()} route intervals overlap or leave an ambiguous boundary.`);
      return;
    }
    if (previous.maximum < current.minimum ||
        (previous.maximum === current.minimum && !previous.maximumInclusive && !current.minimumInclusive)) {
      fail(`${type.toUpperCase()} route intervals leave a gap in the response domain.`);
      return;
    }
  }
}
