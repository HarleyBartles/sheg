import { journeyDefinitionSchema, studyArmSchema, type JourneyDefinition, type StudyArm } from '../study/arm.js';
import type { RespondentProfile } from '../respondents/profile.js';
import { journeyControlSuccessors, journeyTopology } from './topology.js';

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
    const range = graphDecisionRange(arm);
    minimumDecisionCalls += range.minimum * respondents.length;
    maximumDecisionCalls += range.maximum * respondents.length;
    if (!Number.isSafeInteger(minimumDecisionCalls) || !Number.isSafeInteger(maximumDecisionCalls)) {
      throw new RangeError(`Run decision-call bounds for ${arm.id} exceed the safe integer range.`);
    }
  }
  return { minimumDecisionCalls, maximumDecisionCalls };
}

function graphDecisionRange(arm: JourneyDefinition): DecisionRange {
  const graph = journeyTopology(arm);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
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
    const successors = journeyControlSuccessors(graph, nodeId);
    let range: DecisionRange;
    if (node.kind === 'fork') {
      const branches = successors.filter((successor) => successor.kind === 'condition').map((successor) => visit(successor.toNodeId));
      if (branches.length !== node.conditions.length) throw new Error(`Run call bounds could not enumerate every condition at fork ${nodeId} in ${arm.id}.`);
      range = branches.reduce((total, branch) => ({
        minimum: checkedAdd(total.minimum, branch.minimum, node.id, arm.id),
        maximum: checkedAdd(total.maximum, branch.maximum, node.id, arm.id),
      }), { minimum: 0, maximum: 0 });
    } else {
      const transitions = successors.filter((successor) => successor.kind === 'transition');
      if (transitions.length === 0) throw new Error(`Run call bounds found no outgoing transition at ${nodeId} in ${arm.id}.`);
      const branches = transitions.map((successor) => visit(successor.toNodeId));
      const decisionCost = node.kind === 'ask' ? 1 : 0;
      range = {
        minimum: checkedAdd(decisionCost, Math.min(...branches.map((branch) => branch.minimum)), nodeId, arm.id),
        maximum: checkedAdd(decisionCost, Math.max(...branches.map((branch) => branch.maximum)), nodeId, arm.id),
      };
    }
    active.delete(nodeId);
    memo.set(nodeId, range);
    return range;
  };

  return visit(graph.entryNodeId);
}

function checkedAdd(left: number, right: number, nodeId: string, armId: string): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new RangeError(`Run call bounds overflow at node ${nodeId} in ${armId}.`);
  return total;
}
