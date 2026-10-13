import type { SQLOutputValue } from 'node:sqlite';
import { RunStoreError } from '../../application/run-store.js';
import { providerFailureEvidenceSchema } from '../../domain/decision/provider-failure.js';
import { decisionFailureDetailSchema, decisionResultSchema, decisionValueSchema, providerExecutionEvidenceSchema } from '../../domain/decision/decision.js';
import { asText, type DatabaseRow } from './rows.js';
import type { FollowOnLineage, ParsedRunRequest, RunMaterialItem } from '../../domain/run/request.js';
import type { DecisionResult } from '../../domain/decision/decision.js';
import type { DecisionRequest } from '../../domain/decision/decision.js';
import type { PromptState } from '../../domain/decision/prompt.js';
import { journeyControlSuccessors, journeyTopology } from '../../domain/journey/topology.js';
import type { EvaluationFailure } from '../../domain/run/lifecycle.js';
import { decodeStoredPayload, encodeStoredPayload } from './payload-codecs.js';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { isImageMaterial } from '../../domain/study/stimulus.js';

const evaluationFailureEvidenceSchema = z.object({
  detail: decisionFailureDetailSchema.optional(),
  providerFailure: providerFailureEvidenceSchema.optional(),
}).strict();
const attemptEvaluationFailureSchema = evaluationFailureEvidenceSchema.extend({
  code: z.string().min(1),
  message: z.string(),
}).strict();

function mergeMaterialCatalog(...collections: readonly (readonly RunMaterialItem[])[]): RunMaterialItem[] {
  const merged = new Map<string, RunMaterialItem>();
  for (const collection of collections) for (const item of collection) {
    const previous = merged.get(item.id);
    const imageConflict = previous && 'type' in previous && previous.type === 'image' && 'type' in item && item.type === 'image' &&
      (previous.altText !== item.altText || previous.caption !== item.caption || JSON.stringify(previous.asset) !== JSON.stringify(item.asset));
    if (previous && (previous.text !== item.text || previous.sourceId && item.sourceId && previous.sourceId !== item.sourceId || previous.sourceSha256 && item.sourceSha256 && previous.sourceSha256 !== item.sourceSha256 || imageConflict)) {
      throw new RunStoreError('data_integrity_error', `Stored material ${item.id} has conflicting text or source provenance.`);
    }
    merged.set(item.id, previous ? { ...previous, ...(item.sourceId === undefined ? {} : { sourceId: item.sourceId }), ...(item.sourceSha256 === undefined ? {} : { sourceSha256: item.sourceSha256 }) } : { ...item });
  }
  return [...merged.values()];
}

export function materialCatalogForRequest(request: ParsedRunRequest, lineage: FollowOnLineage | undefined, contextId: string, respondentId: string, encountered: readonly { id: string; text: string }[] = []): RunMaterialItem[] {
  const source = request.kind === 'poll' ? request.material : request.kind === 'journey' ? request.journey.items : request.material ?? [];
  const inherited = request.kind === 'follow-on'
    ? lineage?.materialSnapshots.filter((snapshot) => snapshot.contextId === contextId && snapshot.respondentId === respondentId).flatMap(({ materials }) => materials) ?? []
    : [];
  return mergeMaterialCatalog(source, inherited, encountered);
}

export function materialCatalogForExactContext(request: ParsedRunRequest, lineage: FollowOnLineage | undefined, contextId: string, respondentId: string,
  packet: DecisionRequest & { state: PromptState }, branchId?: string): RunMaterialItem[] {
  const catalog = materialCatalogForRequest(request, lineage, contextId, respondentId, packet.state.encounteredItems);
  const siblingMaterialIds = request.kind === 'journey' && branchId ? siblingJourneyMaterialIds(request, branchId) : new Set<string>();
  const exposedVisualIds = new Set([
    ...(packet.visualMaterials ?? []).map(({ id }) => id),
    ...packet.state.trajectory.responses.flatMap((response) => response.visualEvidence?.materials.map(({ materialId }) => materialId) ?? []),
  ]);
  return catalog.filter((material) => !siblingMaterialIds.has(material.id) && (!isImageMaterial(material) || exposedVisualIds.has(material.id)));
}

function siblingJourneyMaterialIds(request: Extract<ParsedRunRequest, { kind: 'journey' }>, branchId: string): Set<string> {
  const graph = journeyTopology(request.journey);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const assignments = branchId.split('/').slice(1).flatMap((part) => {
    const separator = part.indexOf('=');
    return separator > 0 ? [{ forkNodeId: part.slice(0, separator), conditionId: part.slice(separator + 1) }] : [];
  });
  const exposuresFrom = (entryNodeId: string): Set<string> => {
    const exposed = new Set<string>();
    const pending = [entryNodeId];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const nodeId = pending.pop()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      const node = nodes.get(nodeId);
      if (!node) continue;
      if (node.kind === 'expose') exposed.add(node.itemId);
      if (node.kind === 'ask') {
        const task = request.journey.tasks.find(({ id }) => id === node.taskId);
        if (task?.type === 'choice') for (const id of Object.values(task.materialOptions ?? {})) exposed.add(id);
      }
      pending.push(...journeyControlSuccessors(graph, nodeId).map(({ toNodeId }) => toNodeId));
    }
    return exposed;
  };
  const siblings = new Set<string>();
  for (const { forkNodeId, conditionId } of assignments) {
    const fork = nodes.get(forkNodeId);
    if (fork?.kind !== 'fork') continue;
    const selected = fork.conditions.find(({ id }) => id === conditionId);
    if (!selected) continue;
    const selectedExposures = exposuresFrom(selected.entryNodeId);
    for (const condition of fork.conditions) if (condition.id !== conditionId) {
      for (const materialId of exposuresFrom(condition.entryNodeId)) if (!selectedExposures.has(materialId)) siblings.add(materialId);
    }
  }
  return siblings;
}

export function assertRetainedImageAsset(database: DatabaseSync, runId: string, material: RunMaterialItem): void {
  if (!isImageMaterial(material)) return;
  const row = database.prepare(`SELECT ia.asset_id, ia.sha256, ia.format, ia.width, ia.height, ia.byte_length
    FROM run_visual_assets AS rva JOIN image_assets AS ia ON ia.asset_id = rva.asset_id
    WHERE rva.run_id = ? AND rva.material_id = ?`).get(runId, material.id) as DatabaseRow | undefined;
  if (!row || row.asset_id !== material.asset.assetId || row.sha256 !== material.asset.sha256 || row.format !== material.asset.format ||
      row.width !== material.asset.width || row.height !== material.asset.height || row.byte_length !== material.asset.bytes) {
    throw new RunStoreError('data_integrity_error', `Mapped Choice answer has no retained image asset matching ${material.id}.`);
  }
}

export function encounteredMaterialsFromState(state: Record<string, unknown>): Array<{ id: string; text: string }> {
  if (!Array.isArray(state.encounteredItems)) return [];
  return state.encounteredItems.flatMap((item) => typeof item === 'object' && item !== null &&
    'id' in item && typeof item.id === 'string' && 'text' in item && typeof item.text === 'string'
    ? [{ id: item.id, text: item.text }]
    : []);
}

export function resultFromStorage(value: unknown, execution: unknown): DecisionResult {
  return decodeResultAndExecution(value, execution).result;
}

export function decodeResultAndExecution(value: unknown, execution: unknown): { result: DecisionResult; execution: import('../../domain/decision/decision.js').ProviderExecutionEvidence } {
  const typed = decodeStoredPayload(JSON.stringify(value), 'decision-value', decisionValueSchema);
  const evidence = providerExecutionEvidenceSchema.parse(execution);
  return { result: decisionResultSchema.parse({ ...typed, ...evidence }), execution: evidence };
}

export function failureEvidenceFromStorage(value: SQLOutputValue | undefined): Partial<Pick<EvaluationFailure, 'detail' | 'providerFailure'>> {
  if (value === null || value === undefined) return {};
  const decoded = decodeStoredPayload(asText(value, 'evaluation failure evidence'), 'evaluation-failure-evidence', evaluationFailureEvidenceSchema);
  return { ...(decoded.detail ? { detail: decoded.detail } : {}), ...(decoded.providerFailure ? { providerFailure: decoded.providerFailure } : {}) };
}

export function failureEvidenceJson(failure: EvaluationFailure): string | null {
  if (!failure.detail && !failure.providerFailure) return null;
  return encodeStoredPayload('evaluation-failure-evidence', {
    ...(failure.detail ? { detail: failure.detail } : {}),
    ...(failure.providerFailure ? { providerFailure: failure.providerFailure } : {}),
  }, evaluationFailureEvidenceSchema);
}

export function storedEvaluationFailure(row: DatabaseRow): EvaluationFailure | undefined {
  if (row.failure_code === null) return undefined;
  const evidence = failureEvidenceFromStorage(row.failure_detail_json);
  return {
    code: asText(row.failure_code, 'failure code'),
    message: asText(row.failure_message, 'failure message'),
    ...evidence,
  };
}

export function evaluationFailureJson(failure: EvaluationFailure): string {
  return encodeStoredPayload('attempt-evaluation-failure', failure, attemptEvaluationFailureSchema);
}

export function evaluationFailureFromJson(value: SQLOutputValue | undefined): EvaluationFailure | undefined {
  if (value === null || value === undefined) return undefined;
  const decoded = decodeStoredPayload(asText(value, 'attempt evaluation failure'), 'attempt-evaluation-failure', attemptEvaluationFailureSchema);
  return {
    code: decoded.code,
    message: decoded.message,
    ...(decoded.detail === undefined ? {} : { detail: decoded.detail }),
    ...(decoded.providerFailure === undefined ? {} : { providerFailure: decoded.providerFailure }),
  };
}


