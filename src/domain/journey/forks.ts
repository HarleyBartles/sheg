import { compileDecisionPacketForCompiler } from '../decision/prompt.js';
import type { DecisionRequest } from '../decision/decision.js';
import type { RespondentProfile } from '../respondents/profile.js';
import type { JourneyRespondentState } from '../run/lifecycle.js';
import type { JourneyDefinition } from '../study/arm.js';
import { journeyTopology, journeyControlSuccessors } from './topology.js';
import { journeyPathId, type JourneyEvent } from './run.js';

export type ForkBarrierReadiness = {
  forkNodeId: string;
  parentBranchId: string;
  arrived: JourneyRespondentState[];
  activeThatCanStillArrive: JourneyRespondentState[];
  canClose: boolean;
};

export function journeyForkBarrierReadiness(
  journey: JourneyDefinition,
  forkNodeId: string,
  parentBranchId: string,
  states: readonly JourneyRespondentState[],
): ForkBarrierReadiness {
  const graph = journeyTopology(journey);
  const fork = graph.nodes.find((node) => node.id === forkNodeId);
  if (fork?.kind !== 'fork') throw new Error(`Node ${forkNodeId} is not a matched fork.`);
  const branchStates = states.filter((state) => state.branchId === parentBranchId);
  const arrived = branchStates.filter((state) => state.status === 'waiting-fork' && state.currentNodeId === forkNodeId);
  const activeThatCanStillArrive = branchStates.filter((state) => state.status === 'active' && state.currentNodeId !== null &&
    canReachNode(graph, state.currentNodeId, forkNodeId));
  return {
    forkNodeId,
    parentBranchId,
    arrived,
    activeThatCanStillArrive,
    canClose: arrived.length > 0 && activeThatCanStillArrive.length === 0,
  };
}

export function journeyChildBranchId(parentBranchId: string, forkNodeId: string, conditionId: string): string {
  if (!parentBranchId || !forkNodeId || !conditionId || /[=/]/.test(forkNodeId) || /[=/]/.test(conditionId)) {
    throw new Error('Fork branch identity contains an empty or ambiguous segment.');
  }
  return `${parentBranchId}/${forkNodeId}=${conditionId}`;
}

export function compileForkConditionEntry(input: {
  journey: JourneyDefinition;
  profile: RespondentProfile;
  parent: JourneyRespondentState;
  forkNodeId: string;
  conditionId: string;
  compilerFingerprint: string;
}): {
  branchId: string;
  nodeId: string;
  taskId: string;
  pathId: string;
  events: JourneyEvent[];
  packet: DecisionRequest & { state: ReturnType<typeof compileDecisionPacketForCompiler>['state'] };
} {
  const graph = journeyTopology(input.journey);
  const fork = graph.nodes.find((node) => node.id === input.forkNodeId);
  const condition = fork?.kind === 'fork' ? fork.conditions.find(({ id }) => id === input.conditionId) : undefined;
  if (!condition) throw new Error(`Condition ${input.conditionId} is not declared by fork ${input.forkNodeId}.`);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const events = [...input.parent.events];
  let current = condition.entryNodeId;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(current)) throw new Error(`Fork condition ${condition.id} contains a cycle at node ${current}.`);
    visited.add(current);
    const node = nodes.get(current);
    if (!node) throw new Error(`Fork condition ${condition.id} points to unknown node ${current}.`);
    if (node.kind === 'ask') {
      return {
        branchId: journeyChildBranchId(input.parent.branchId, input.forkNodeId, condition.id),
        nodeId: node.id,
        taskId: node.taskId,
        pathId: journeyPathId(input.parent.route),
        events,
        packet: compileDecisionPacketForCompiler(input.journey, input.profile, node.taskId, events, input.compilerFingerprint),
      };
    }
    if (node.kind !== 'expose') throw new Error(`Fork condition ${condition.id} must reach its first ask before a terminal or nested fork.`);
    events.push({ type: 'exposure', sequence: events.length, nodeId: node.id, itemId: node.itemId });
    const next = journeyControlSuccessors(graph, node.id);
    if (next.length !== 1 || next[0]?.kind !== 'transition') throw new Error(`Fork treatment exposure ${node.id} does not have one unconditional successor.`);
    current = next[0].toNodeId;
  }
}

function canReachNode(graph: ReturnType<typeof journeyTopology>, startNodeId: string, targetNodeId: string): boolean {
  const visited = new Set<string>();
  const pending = [startNodeId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === targetNodeId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const successor of journeyControlSuccessors(graph, current)) pending.push(successor.toNodeId);
  }
  return false;
}
