import { studyArmSchema, type StudyArm } from '../study/arm.js';

export type JourneyPreviewOption = {
  optionId: string;
  description: string;
  nextNodeId: string;
};

export type JourneyPreviewNode =
  | { id: string; kind: 'stimulus'; stimulusId: string; text: string; nextNodeId: string }
  | { id: string; kind: 'question'; taskId: string; instructions: string; options: JourneyPreviewOption[]; trajectoryContextIncluded: true }
  | { id: string; kind: 'terminal'; outcome: string };

export type StudyArmJourneyPreview = {
  armId: string;
  label: string;
  presentation: 'sequence' | 'graph';
  entryNodeId: string;
  nodes: JourneyPreviewNode[];
};

export type StudyJourneyPreview = { arms: StudyArmJourneyPreview[] };

export function previewStudyJourney(arms: readonly StudyArm[]): StudyJourneyPreview {
  return { arms: arms.map((rawArm) => previewArm(studyArmSchema.parse(rawArm))) };
}

function previewArm(arm: StudyArm): StudyArmJourneyPreview {
  if (arm.presentation.kind === 'sequence') {
    const stimulusNodes: JourneyPreviewNode[] = arm.items.map((item, index) => ({
      id: `sequence-expose-${item.id}`,
      kind: 'stimulus',
      stimulusId: item.id,
      text: item.text,
      nextNodeId: index + 1 < arm.items.length ? `sequence-expose-${arm.items[index + 1]!.id}` : `sequence-ask-${arm.tasks[0]!.id}`,
    }));
    const questionNodes: JourneyPreviewNode[] = arm.tasks.map((task, index) => ({
      id: `sequence-ask-${task.id}`,
      kind: 'question',
      taskId: task.id,
      instructions: task.instructions,
      options: Object.entries(task.options).map(([optionId, description]) => ({
        optionId,
        description,
        nextNodeId: index + 1 < arm.tasks.length ? `sequence-ask-${arm.tasks[index + 1]!.id}` : `sequence-terminal-${arm.id}`,
      })),
      trajectoryContextIncluded: true,
    }));
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
    return { id: node.id, kind: 'question', taskId: task.id, instructions: task.instructions, options, trajectoryContextIncluded: true };
  });

  return {
    armId: arm.id,
    label: arm.label,
    presentation: 'graph',
    entryNodeId: arm.presentation.entryNodeId,
    nodes,
  };
}
