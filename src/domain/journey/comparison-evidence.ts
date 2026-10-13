import type { JourneyComparisonEvidence, JourneyComparisonPairMember, JourneyEvaluationRecord, JourneyForkMemberRecord, JourneyForkRecord, JourneyRespondentState } from '../run/lifecycle.js';
import type { JourneyDefinition } from '../study/arm.js';

type ForkNode = Extract<Extract<JourneyDefinition['presentation'], { kind: 'graph' }>['nodes'][number], { kind: 'fork' }>;
type ForkCondition = ForkNode['conditions'][number];

function comparisonTasksByCondition(journey: JourneyDefinition, forkNodeId: string): Map<string, Map<string, string>> {
  if (journey.presentation.kind !== 'graph') return new Map();
  const graph = journey.presentation;
  const fork = graph.nodes.find((node) => node.id === forkNodeId);
  if (fork?.kind !== 'fork') return new Map();
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  for (const transition of graph.transitions) {
    const targets = outgoing.get(transition.fromNodeId) ?? [];
    targets.push(transition.toNodeId);
    outgoing.set(transition.fromNodeId, targets);
  }
  const tasks = new Map(journey.tasks.map((task) => [task.id, task]));
  return new Map(fork.conditions.map((condition) => {
    const seen = new Set<string>();
    const pending = [condition.entryNodeId];
    const keys = new Map<string, string>();
    while (pending.length > 0) {
      const nodeId = pending.pop()!;
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      const node = nodes.get(nodeId);
      if (!node || node.kind === 'terminal' || node.kind === 'fork') continue;
      if (node.kind === 'ask') {
        const task = tasks.get(node.taskId);
        if (task?.comparisonKey) keys.set(task.comparisonKey, task.id);
      }
      pending.push(...(outgoing.get(nodeId) ?? []));
    }
    return [condition.id, keys];
  }));
}

function missingMember(condition: ForkCondition, branchId: string, questionId: string, state: JourneyRespondentState | undefined): JourneyComparisonPairMember {
  const notReachedReason = !state ? 'branch-state-missing'
    : state.status === 'failed' ? 'branch-failed-before-comparison'
      : state.status === 'completed' || state.status === 'branched' || state.status === 'unreached' ? 'branch-ended-before-comparison'
        : 'turn-not-reached-yet';
  return { conditionId: condition.id, label: condition.label, branchId, questionId, status: 'not-reached',
    ...(state?.outcome === undefined ? {} : { respondentOutcome: state.outcome }), notReachedReason };
}

export function buildJourneyComparisonEvidence(input: {
  journey: JourneyDefinition;
  forks: readonly JourneyForkRecord[];
  forkMembers: readonly JourneyForkMemberRecord[];
  evaluations: readonly JourneyEvaluationRecord[];
  respondents: readonly JourneyRespondentState[];
}): JourneyComparisonEvidence[] {
  if (input.journey.presentation.kind !== 'graph') return [];
  const results: JourneyComparisonEvidence[] = [];
  for (const barrier of input.forks) {
    const fork = input.journey.presentation.nodes.find((node) => node.id === barrier.forkNodeId);
    if (fork?.kind !== 'fork') continue;
    const members = input.forkMembers.filter((member) => member.forkNodeId === barrier.forkNodeId && member.parentBranchId === barrier.parentBranchId);
    const respondents = [...new Set(members.map(({ respondentId }) => respondentId))].sort();
    const keysByCondition = comparisonTasksByCondition(input.journey, barrier.forkNodeId);
    const comparisonKeys = [...new Set([...keysByCondition.values()].flatMap((keys) => [...keys.keys()]))].filter((key) =>
      fork.conditions.filter(({ id }) => keysByCondition.get(id)?.has(key)).length > 1);

    for (const comparisonKey of comparisonKeys) {
      const conditions = fork.conditions.flatMap((condition) => {
        const questionId = keysByCondition.get(condition.id)?.get(comparisonKey);
        return questionId === undefined ? [] : [{ ...condition, questionId }];
      });
      const conditionPairs = conditions.flatMap((first, index) => conditions.slice(index + 1).map((second) => [first, second] as const));
      const pairs = respondents.flatMap((respondentId) => {
        const conditionBranches = new Map(conditions.map((condition) => [condition.id, members.find((member) => member.respondentId === respondentId && member.conditionId === condition.id)?.childBranchId]));
        const occurrences = new Set<number>();
        for (const condition of conditions) {
          const branchId = conditionBranches.get(condition.id);
          for (const evaluation of input.evaluations) if (evaluation.respondentId === respondentId && evaluation.branchId === branchId && evaluation.questionId === condition.questionId) occurrences.add(evaluation.occurrence);
        }
        if (occurrences.size === 0) occurrences.add(1);
        return [...occurrences].sort((left, right) => left - right).flatMap((occurrence) => conditionPairs.map(([first, second]) => {
          const memberFor = (condition: typeof first): JourneyComparisonPairMember => {
            const branchId = conditionBranches.get(condition.id);
            const state = input.respondents.find((candidate) => candidate.respondentId === respondentId && candidate.branchId === branchId);
            const evaluation = branchId === undefined ? undefined : input.evaluations.find((candidate) => candidate.respondentId === respondentId && candidate.branchId === branchId &&
              candidate.questionId === condition.questionId && candidate.occurrence === occurrence);
            if (!evaluation || branchId === undefined) return missingMember(condition, branchId ?? '', condition.questionId, state);
            return { conditionId: condition.id, label: condition.label, branchId, questionId: condition.questionId, status: evaluation.status,
              ...(state?.outcome === undefined ? {} : { respondentOutcome: state.outcome }), evaluationId: evaluation.evaluationId,
              packetFingerprint: evaluation.packetFingerprint, ...(evaluation.providerSelection === undefined ? {} : { providerSelection: evaluation.providerSelection }),
              ...(evaluation.result === undefined ? {} : { result: evaluation.result }), ...(evaluation.execution === undefined ? {} : { execution: evaluation.execution }),
              ...(evaluation.failure === undefined ? {} : { failure: evaluation.failure }) };
          };
          const pairMembers: [JourneyComparisonPairMember, JourneyComparisonPairMember] = [memberFor(first), memberFor(second)];
          return { respondentId, occurrence, complete: pairMembers.every(({ status }) => status === 'answered'), members: pairMembers };
        }));
      });
      const completePairs = pairs.filter(({ complete }) => complete).length;
      results.push({ forkNodeId: barrier.forkNodeId, parentBranchId: barrier.parentBranchId, barrierStatus: barrier.status, comparisonKey,
        conditions: conditions.map(({ id, label, questionId }) => ({ conditionId: id, label, questionId })), cohortRespondents: respondents.length,
        completePairs, incompletePairs: pairs.length - completePairs, pairs });
    }
  }
  return results;
}
