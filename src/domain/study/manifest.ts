import { z } from 'zod';

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

export const sourceReferenceSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f\d]{64}$/i),
}).strict();

const itemSchema = z.object({
  id: identifier,
  text: z.string().trim().min(1),
}).strict();

const decisionSchema = z.object({
  id: identifier,
  instructions: z.string().trim().min(1),
  criteria: z.record(identifier, z.string().trim().min(1)).refine((criteria) => Object.keys(criteria).length > 0),
}).strict();

const nodeSchema = z.discriminatedUnion('kind', [
  z.object({ id: identifier, kind: z.literal('expose'), itemId: identifier }).strict(),
  z.object({ id: identifier, kind: z.literal('decide'), decisionId: identifier }).strict(),
  z.object({ id: identifier, kind: z.literal('terminal'), outcome: identifier }).strict(),
]);

const transitionSchema = z.object({
  fromNodeId: identifier,
  choice: identifier.optional(),
  toNodeId: identifier,
}).strict();

export const manifestSchema = z.object({
  version: z.literal('1.0'),
  study: z.object({
    title: z.string().trim().min(1),
    purpose: z.string().trim().min(1),
  }).strict(),
  sources: z.array(sourceReferenceSchema).min(1),
  items: z.array(itemSchema).min(1),
  decisions: z.array(decisionSchema).min(1),
  nodes: z.array(nodeSchema).min(1),
  transitions: z.array(transitionSchema).min(1),
  entryNodeId: identifier,
  maxDecisions: z.number().int().positive(),
}).strict().superRefine((manifest, context) => {
  const allIds = [
    ...manifest.items.map((item) => item.id),
    ...manifest.decisions.map((decision) => decision.id),
    ...manifest.nodes.map((node) => node.id),
  ];
  if (new Set(allIds).size !== allIds.length) {
    context.addIssue({ code: 'custom', path: [], message: 'Item, decision, and node IDs must be unique.' });
  }

  const itemIds = new Set(manifest.items.map((item) => item.id));
  const decisionById = new Map(manifest.decisions.map((decision) => [decision.id, decision]));
  const nodeById = new Map(manifest.nodes.map((node) => [node.id, node]));
  if (!nodeById.has(manifest.entryNodeId)) {
    context.addIssue({ code: 'custom', path: ['entryNodeId'], message: `Unknown entry node ${manifest.entryNodeId}.` });
  }

  for (const [index, node] of manifest.nodes.entries()) {
    if (node.kind === 'expose' && !itemIds.has(node.itemId)) {
      context.addIssue({ code: 'custom', path: ['nodes', index, 'itemId'], message: `Node references unknown item ${node.itemId}.` });
    }
    if (node.kind === 'decide' && !decisionById.has(node.decisionId)) {
      context.addIssue({ code: 'custom', path: ['nodes', index, 'decisionId'], message: `Node references unknown decision ${node.decisionId}.` });
    }
  }

  const outgoing = new Map<string, typeof manifest.transitions>();
  for (const [index, edge] of manifest.transitions.entries()) {
    const source = nodeById.get(edge.fromNodeId);
    if (!source) {
      context.addIssue({ code: 'custom', path: ['transitions', index, 'fromNodeId'], message: `Transition references unknown source node ${edge.fromNodeId}.` });
      continue;
    }
    if (!nodeById.has(edge.toNodeId)) {
      context.addIssue({ code: 'custom', path: ['transitions', index, 'toNodeId'], message: `Transition references unknown target node ${edge.toNodeId}.` });
    }
    const edges = outgoing.get(edge.fromNodeId) ?? [];
    outgoing.set(edge.fromNodeId, [...edges, edge]);
    if (source.kind === 'terminal') {
      context.addIssue({ code: 'custom', path: ['transitions', index], message: 'Terminal nodes cannot have outgoing transitions.' });
    }
    if (source.kind === 'expose' && edge.choice !== undefined) {
      context.addIssue({ code: 'custom', path: ['transitions', index, 'choice'], message: 'Exposure transitions must be unconditional.' });
    }
  }

  for (const [index, node] of manifest.nodes.entries()) {
    const edges = outgoing.get(node.id) ?? [];
    if (node.kind === 'terminal') {
      if (edges.length > 0) context.addIssue({ code: 'custom', path: ['nodes', index], message: 'Terminal nodes cannot have outgoing transitions.' });
      continue;
    }
    if (node.kind === 'expose') {
      if (edges.length !== 1 || edges[0]?.choice !== undefined) {
        context.addIssue({ code: 'custom', path: ['nodes', index], message: 'Each exposure node must have exactly one unconditional transition.' });
      }
      continue;
    }
    const decision = decisionById.get(node.decisionId);
    const offeredLabels = Object.keys(decision?.criteria ?? {});
    const edgeLabels = edges.map((edge) => edge.choice);
    if (edgeLabels.some((label) => label === undefined) ||
        new Set(edgeLabels).size !== edgeLabels.length ||
        edgeLabels.length !== offeredLabels.length ||
        offeredLabels.some((label) => !edgeLabels.includes(label))) {
      context.addIssue({ code: 'custom', path: ['nodes', index], message: 'Decision transitions must contain exactly one edge for each offered label.' });
    }
  }

  if (nodeById.has(manifest.entryNodeId)) {
    const visited = new Set<string>();
    const pending = [manifest.entryNodeId];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const edge of outgoing.get(current) ?? []) pending.push(edge.toNodeId);
    }
    const unreachable = manifest.nodes.filter((node) => !visited.has(node.id)).map((node) => node.id);
    if (unreachable.length > 0) {
      context.addIssue({ code: 'custom', path: ['nodes'], message: `Graph contains unreachable nodes: ${unreachable.join(', ')}.` });
    }
  }

  const visibleBytes = manifest.items.reduce((total, item) => total + Buffer.byteLength(item.text, 'utf8'), 0);
  if (visibleBytes > 80_000) {
    context.addIssue({ code: 'custom', path: ['items'], message: 'Study stimulus text exceeds the 80 KB limit.' });
  }
});

export type StudyManifest = z.infer<typeof manifestSchema>;
