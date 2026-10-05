import type { SQLOutputValue } from 'node:sqlite';
import { RunStoreError } from '../../application/run-store.js';
import { providerFailureEvidenceSchema } from '../../domain/decision/provider-failure.js';
import { decisionFailureDetailSchema, decisionResultSchema, decisionValueSchema, providerExecutionEvidenceSchema } from '../../domain/decision/decision.js';
import { asText, type DatabaseRow } from './rows.js';
import type { FollowOnLineage, ParsedRunRequest, RunMaterialItem } from '../../domain/run/request.js';
import type { DecisionResult } from '../../domain/decision/decision.js';
import type { EvaluationFailure } from '../../domain/run/lifecycle.js';
import { decodeStoredPayload, encodeStoredPayload } from './payload-codecs.js';
import { z } from 'zod';

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
    if (previous && (previous.text !== item.text || previous.sourceId && item.sourceId && previous.sourceId !== item.sourceId || previous.sourceSha256 && item.sourceSha256 && previous.sourceSha256 !== item.sourceSha256)) {
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


