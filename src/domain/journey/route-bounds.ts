import { journeyDefinitionSchema, studyArmSchema, type JourneyDefinition, type StudyArm } from '../study/arm.js';
import type { RespondentProfile } from '../respondents/profile.js';

export type RunDecisionCallBounds = {
  minimumDecisionCalls: number;
  maximumDecisionCalls: number;
};

type DecisionRange = { minimum: number; maximum: number };

export function estimateRunDecisionCalls(arms: readonly (JourneyDefinition | StudyArm)[], respondents: readonly RespondentProfile[]): RunDecisionCallBounds {
  if (arms.length === 0) throw new Error('Run call bounds require at least one study arm.');
  if (respondents.length === 0) throw new Error('Run call bounds require at least one frozen respondent.');

  let minimumDecisionCalls = 0;
  let maximumDecisionCalls = 0;
  for (const rawArm of arms) {
    const arm = ('sources' in rawArm ? studyArmSchema : journeyDefinitionSchema).parse(rawArm);
    const range = arm.presentation.kind === 'sequence'
      ? { minimum: arm.tasks.length, maximum: arm.tasks.length }
      : graphDecisionRange(arm);
    minimumDecisionCalls += range.minimum * respondents.length;
    maximumDecisionCalls += range.maximum * respondents.length;
    if (!Number.isSafeInteger(minimumDecisionCalls) || !Number.isSafeInteger(maximumDecisionCalls)) {
      throw new RangeError('Run decision-call bounds exceed the safe integer range.');
    }
  }
  return { minimumDecisionCalls, maximumDecisionCalls };
}

function graphDecisionRange(arm: JourneyDefinition): DecisionRange {
  if (arm.presentation.kind !== 'graph') throw new Error('Graph decision bounds require a graph presentation.');
  const graph = arm.presentation;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, typeof graph.transitions>();
  for (const edge of graph.transitions) {
    const edges = outgoing.get(edge.fromNodeId) ?? [];
    edges.push(edge);
    outgoing.set(edge.fromNodeId, edges);
  }
  const memo = new Map<string, DecisionRange>();
  const active = new Set<string>();

  const visit = (nodeId: string): DecisionRange => {
    const cached = memo.get(nodeId);
    if (cached) return cached;
    if (active.has(nodeId)) throw new Error(`Run call bounds encountered a graph cycle at ${nodeId}.`);
    const node = nodes.get(nodeId);
    if (!node) throw new Error(`Run call bounds encountered an unknown node ${nodeId}.`);
    if (node.kind === 'terminal') return { minimum: 0, maximum: 0 };

    active.add(nodeId);
    const edges = outgoing.get(nodeId) ?? [];
    if (edges.length === 0) throw new Error(`Run call bounds found no outgoing transition at ${nodeId}.`);
    const branches = edges.map((edge) => visit(edge.toNodeId));
    const decisionCost = node.kind === 'ask' ? 1 : 0;
    const range = {
      minimum: decisionCost + Math.min(...branches.map((branch) => branch.minimum)),
      maximum: decisionCost + Math.max(...branches.map((branch) => branch.maximum)),
    };
    active.delete(nodeId);
    memo.set(nodeId, range);
    return range;
  };

  return visit(graph.entryNodeId);
}
