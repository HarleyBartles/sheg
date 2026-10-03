import type { JourneyDefinition } from '../study/arm.js';
import type { StudyPresentation } from '../study/presentation.js';

/** Compile the author-friendly sequence shorthand to the same deterministic graph used at runtime. */
export function journeyTopology(arm: JourneyDefinition): Extract<StudyPresentation, { kind: 'graph' }> {
  if (arm.presentation.kind === 'graph') return arm.presentation;
  const nodes: Extract<Extract<StudyPresentation, { kind: 'graph' }>['nodes'][number], { kind: 'expose' | 'ask' | 'terminal' }>[] = [];
  const transitions: Extract<StudyPresentation, { kind: 'graph' }>['transitions'] = [];
  const exposes = arm.items.map((item) => `sequence-expose-${item.id}`);
  const asks = arm.tasks.map((task) => `sequence-ask-${task.id}`);
  const terminal = `sequence-terminal-${arm.id}`;
  arm.items.forEach((item, index) => {
    const id = exposes[index]!;
    nodes.push({ id, kind: 'expose', itemId: item.id });
    transitions.push({ fromNodeId: id, toNodeId: exposes[index + 1] ?? asks[0]! });
  });
  arm.tasks.forEach((task, index) => {
    const id = asks[index]!;
    nodes.push({ id, kind: 'ask', taskId: task.id });
    const toNodeId = asks[index + 1] ?? terminal;
    if ('options' in task) {
      for (const optionId of Object.keys(task.options)) transitions.push({ fromNodeId: id, optionId, toNodeId });
    } else {
      const maximum = 'rubric' in task ? task.rubric.length - 1 : 1;
      transitions.push({ fromNodeId: id, when: { type: task.type, minimum: 0, maximum, minimumInclusive: true, maximumInclusive: true }, toNodeId });
    }
  });
  nodes.push({ id: terminal, kind: 'terminal', outcome: 'complete' });
  return { kind: 'graph', nodes, transitions, entryNodeId: exposes[0]!, maxDecisions: arm.tasks.length };
}
