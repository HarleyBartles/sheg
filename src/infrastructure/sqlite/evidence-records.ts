import type { SQLOutputValue } from 'node:sqlite';
import { RunStoreError } from '../../application/run-store.js';
import { providerFailureEvidenceSchema } from '../../domain/decision/provider-failure.js';
import { decisionFailureDetailSchema, decisionResultSchema, decisionValueSchema, providerExecutionEvidenceSchema } from '../../domain/decision/decision.js';
import { asText, parseJson, type DatabaseRow } from './rows.js';
import type { FollowOnLineage, ParsedRunRequest, RunMaterialItem } from '../../domain/run/request.js';
import type { DecisionResult } from '../../domain/decision/decision.js';
import type { EvaluationFailure } from '../../domain/run/lifecycle.js';

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
  const complete = decisionResultSchema.safeParse(value);
  if (complete.success) return complete.data;
  const typed = decisionValueSchema.parse(value);
  const evidence = providerExecutionEvidenceSchema.parse(execution);
  return decisionResultSchema.parse({ ...typed, ...evidence });
}

export function failureEvidenceFromStorage(value: SQLOutputValue | undefined): Partial<Pick<EvaluationFailure, 'detail' | 'providerFailure'>> {
  if (value === null || value === undefined) return {};
  const parsed = parseJson<Record<string, unknown>>(value, 'evaluation failure evidence');
  // Original schema-8 records contain a bare typed-answer detail. Preserve their bytes and meaning.
  if ('reason' in parsed) return { detail: decisionFailureDetailSchema.parse(parsed) };
  return { ...(parsed.detail === undefined ? {} : { detail: decisionFailureDetailSchema.parse(parsed.detail) }), ...(parsed.providerFailure === undefined ? {} : { providerFailure: providerFailureEvidenceSchema.parse(parsed.providerFailure) }) };
}

export function failureEvidenceJson(failure: EvaluationFailure): string | null {
  if (failure.providerFailure) return JSON.stringify({ ...(failure.detail ? { detail: failure.detail } : {}), providerFailure: providerFailureEvidenceSchema.parse(failure.providerFailure) });
  return failure.detail ? JSON.stringify(failure.detail) : null;
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
  return JSON.stringify(failure);
}

export function evaluationFailureFromJson(value: SQLOutputValue | undefined): EvaluationFailure | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = parseJson<Record<string, unknown>>(value, 'attempt evaluation failure');
  if (typeof parsed.code !== 'string' || typeof parsed.message !== 'string') throw new RunStoreError('data_integrity_error', 'Stored attempt evaluation failure is invalid.');
  const detail = parsed.detail === undefined ? undefined : decisionFailureDetailSchema.parse(parsed.detail);
  return { code: parsed.code, message: parsed.message, ...(detail ? { detail } : {}), ...(parsed.providerFailure === undefined ? {} : { providerFailure: providerFailureEvidenceSchema.parse(parsed.providerFailure) }) };
}


