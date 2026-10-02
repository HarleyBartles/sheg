import { createHash } from 'node:crypto';
import { compileDecisionPacket, type PromptHistoryEvent } from '../decision/prompt.js';
import type { DecisionRequest } from '../decision/decision.js';
import type { DecisionValue } from '../decision/decision.js';
import type { RespondentProfile } from '../respondents/profile.js';
import { journeyDefinitionSchema, studyArmSchema, type JourneyDefinition, type StudyArm } from '../study/arm.js';

export const DEFAULT_MAX_PREFLIGHT_PACKETS = 100_000;
export const DEFAULT_MAX_PREFLIGHT_PACKET_BYTES = 16 * 1024 * 1024;

export type PreflightPacket = {
  packetId: string;
  respondentId: string;
  armId: string;
  pathId: string;
  decisionIndex: number;
  nodeId: string;
  request: DecisionRequest & { state: ReturnType<typeof compileDecisionPacket>['state'] };
};

export type JourneyWalkResult = {
  status: 'complete' | 'incomplete';
  packetCount: number;
  terminalJourneyCount: number;
  incompleteReason?: string;
  unverifiedReason?: string;
};

export type JourneyWalkOptions = { maxPackets?: number; maxPacketBytes?: number };
type PathChoice = { nodeId: string; choiceId: string };
export type PreflightPacketVisitor = (packet: PreflightPacket) => void;

function pathIdentity(choices: readonly PathChoice[]): string {
  return choices.length === 0 ? 'root' : choices.map(({ nodeId, choiceId }) => `${nodeId}=${choiceId}`).join('>');
}

export function walkStudyPackets(
  arms: readonly (JourneyDefinition | StudyArm)[],
  respondents: readonly RespondentProfile[],
  visitPacket: PreflightPacketVisitor,
  options: JourneyWalkOptions = {},
): JourneyWalkResult {
  const maxPackets = options.maxPackets ?? DEFAULT_MAX_PREFLIGHT_PACKETS;
  const maxPacketBytes = options.maxPacketBytes ?? DEFAULT_MAX_PREFLIGHT_PACKET_BYTES;
  let packetCount = 0;
  let packetBytes = 0;
  let terminalJourneyCount = 0;
  let incompleteReason: string | undefined;
  let unverifiedReason: string | undefined;
  let stopped = false;

  const markIncomplete = (reason: string): void => {
    incompleteReason ??= reason;
    stopped = true;
  };

  if (!Number.isSafeInteger(maxPackets) || maxPackets < 0) {
    markIncomplete('Preflight packet limit must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(maxPacketBytes) || maxPacketBytes < 0 || maxPacketBytes > DEFAULT_MAX_PREFLIGHT_PACKET_BYTES) {
    markIncomplete(`Preflight byte limit must be between 0 and ${DEFAULT_MAX_PREFLIGHT_PACKET_BYTES}.`);
  }
  if (arms.length === 0 || respondents.length === 0) {
    markIncomplete('Preflight requires at least one study arm and one respondent.');
  }

  const emitPacket = (arm: JourneyDefinition, respondent: RespondentProfile, taskId: string, nodeId: string, decisionIndex: number, choices: readonly PathChoice[], events: readonly PromptHistoryEvent[]): void => {
    if (packetCount >= maxPackets) {
      markIncomplete(`Preflight packet limit (${maxPackets}) reached before traversal completed.`);
      return;
    }
    const pathId = pathIdentity(choices);
    let request: ReturnType<typeof compileDecisionPacket>;
    try {
      request = compileDecisionPacket(arm, respondent, taskId, events);
    } catch (error) {
      markIncomplete(`Could not compile request for ${respondent.id}/${arm.id}/${nodeId}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (request.state.trajectory.responses.length > 0) {
      unverifiedReason ??= 'Prior response history can include provider probabilities or confidence with variable serialized size; future packet fit is not conservatively bounded.';
    }
    const identity = JSON.stringify([respondent.id, arm.id, pathId, decisionIndex, nodeId]);
    const packetId = `packet-${createHash('sha256').update(identity).digest('hex')}`;
    const packet = { packetId, respondentId: respondent.id, armId: arm.id, pathId, decisionIndex, nodeId, request };
    const size = Buffer.byteLength(JSON.stringify(packet), 'utf8');
    if (packetBytes + size > maxPacketBytes) {
      markIncomplete(`Preflight packet byte limit (${maxPacketBytes}) reached before traversal completed.`);
      return;
    }
    visitPacket(packet);
    packetCount += 1;
    packetBytes += size;
  };

  for (const arm of arms) {
    if (stopped) break;
    const validation = ('sources' in arm ? studyArmSchema : journeyDefinitionSchema).safeParse(arm);
    if (!validation.success) {
      markIncomplete(`Study arm ${arm.id} is invalid: ${validation.error.issues.map((issue) => issue.message).join(' ')}`);
      break;
    }
    for (const respondent of respondents) {
      if (stopped) break;
      const events: PromptHistoryEvent[] = [];
      const choices: PathChoice[] = [];

      if (arm.presentation.kind === 'sequence') {
        for (const item of arm.items) {
          events.push({ type: 'exposure', sequence: events.length, nodeId: `sequence-expose-${item.id}`, itemId: item.id });
        }
        const visitTask = (taskIndex: number): void => {
          if (stopped) return;
          const task = arm.tasks[taskIndex];
          if (!task) {
            terminalJourneyCount += 1;
            return;
          }
          const decisionIndex = taskIndex + 1;
          const nodeId = `sequence-ask-${task.id}`;
          emitPacket(arm, respondent, task.id, nodeId, decisionIndex, choices, events);
          if (stopped) return;
          for (const response of representativeResponses(task)) {
            const choiceId = response.type === 'choice' ? response.choice : `${response.type}:${response.type === 'score' ? response.score : response.noul}`;
            choices.push({ nodeId, choiceId });
            events.push({ type: 'response', sequence: events.length, nodeId, taskId: task.id, result: response });
            visitTask(taskIndex + 1);
            events.pop();
            choices.pop();
            if (stopped) return;
          }
        };
        visitTask(0);
        continue;
      }

      const graph = arm.presentation;
      const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
      const activeNodes = new Set<string>();
      const visitNode = (nodeId: string, decisionCount: number): void => {
        if (stopped) return;
        if (activeNodes.has(nodeId)) {
          markIncomplete(`Encountered a graph cycle at node ${nodeId} in ${respondent.id}/${arm.id}.`);
          return;
        }
        const node = nodes.get(nodeId);
        if (!node) {
          markIncomplete(`Graph references unknown node ${nodeId} in ${respondent.id}/${arm.id}.`);
          return;
        }
        if (node.kind === 'terminal') {
          terminalJourneyCount += 1;
          return;
        }

        activeNodes.add(nodeId);
        if (node.kind === 'expose') {
          const edge = graph.transitions.find((candidate) => candidate.fromNodeId === node.id);
          if (!edge) {
            markIncomplete(`Exposure node ${node.id} has no transition in ${respondent.id}/${arm.id}.`);
          } else {
            events.push({ type: 'exposure', sequence: events.length, nodeId, itemId: node.itemId });
            visitNode(edge.toNodeId, decisionCount);
            events.pop();
          }
          activeNodes.delete(nodeId);
          return;
        }

        if (decisionCount >= graph.maxDecisions) {
          markIncomplete(`Decision bound reached before terminal at node ${nodeId} in ${respondent.id}/${arm.id}.`);
          activeNodes.delete(nodeId);
          return;
        }
        const task = arm.tasks.find((candidate) => candidate.id === node.taskId);
        if (!task) {
          markIncomplete(`Ask node ${nodeId} references unknown task ${node.taskId} in ${respondent.id}/${arm.id}.`);
          activeNodes.delete(nodeId);
          return;
        }
        emitPacket(arm, respondent, task.id, nodeId, decisionCount + 1, choices, events);
        if (stopped) {
          activeNodes.delete(nodeId);
          return;
        }
        const branches = 'options' in task
          ? Object.keys(task.options).map((choice) => ({ edge: graph.transitions.find((candidate) => candidate.fromNodeId === nodeId && candidate.optionId === choice), response: { type: 'choice' as const, choice } }))
          : graph.transitions.filter((candidate) => candidate.fromNodeId === nodeId && candidate.when !== undefined).map((edge) => ({ edge, response: representativeResponses(task, edge.when)[0]! }));
        for (const branch of branches) {
          const response = branch.response;
          const choiceId = response.type === 'choice' ? response.choice : `${response.type}:${response.type === 'score' ? response.score : response.noul}`;
          const edge = branch.edge;
          if (!edge) {
            markIncomplete(`Ask node ${nodeId} has no transition for response ${choiceId} in ${respondent.id}/${arm.id}.`);
            break;
          }
          choices.push({ nodeId, choiceId });
          events.push({ type: 'response', sequence: events.length, nodeId, taskId: task.id, result: response });
          visitNode(edge.toNodeId, decisionCount + 1);
          events.pop();
          choices.pop();
          if (stopped) break;
        }
        activeNodes.delete(nodeId);
      };
      visitNode(graph.entryNodeId, 0);
    }
  }

  return {
    status: incompleteReason === undefined ? 'complete' : 'incomplete',
    packetCount,
    terminalJourneyCount,
    ...(incompleteReason === undefined ? {} : { incompleteReason }),
    ...(unverifiedReason === undefined ? {} : { unverifiedReason }),
  };
}

function representativeResponses(task: JourneyDefinition['tasks'][number], interval?: NonNullable<Extract<JourneyDefinition['presentation'], { kind: 'graph' }>['transitions'][number]['when']>): DecisionValue[] {
  if ('options' in task) return Object.keys(task.options).map((choice) => ({ type: 'choice', choice }));
  const values: number[] = [];
  if (interval) {
    values.push(interval.minimum === interval.maximum ? interval.minimum : (interval.minimum + interval.maximum) / 2);
  } else if ('rubric' in task) {
    const last = task.rubric.length - 1;
    for (let level = 0; level <= last; level += 0.5) values.push(level);
  } else values.push(0, 0.5, 1);
  return values.map((value): DecisionValue => {
    if ('rubric' in task) {
      const probabilities = Object.fromEntries(task.rubric.map((_meaning, index) => [String(index), 0]));
      const low = Math.floor(value);
      const high = Math.ceil(value);
      if (low === high) probabilities[String(low)] = 1;
      else {
        probabilities[String(low)] = high - value;
        probabilities[String(high)] = value - low;
      }
      return { type: 'score', score: value, legend: Object.fromEntries(task.rubric.map((meaning, index) => [String(index), meaning])), probabilities };
    }
    return { type: 'noul', noul: value };
  });
}
