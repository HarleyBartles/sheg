import type { DatabaseSync } from 'node:sqlite';
import { hashCanonical } from '../../identity.js';
import { decisionRequestSchema } from '../../../domain/decision/decision.js';
import type { RunContextDetail } from '../../../domain/run/lifecycle.js';
import { RunStoreError } from '../../../application/run-store.js';
import { asText, parseJson, parseJsonRecord, parseStored, type DatabaseRow } from '../rows.js';

export function readRunContext(database: DatabaseSync, runId: string, evaluationId: string, contextId: string): RunContextDetail {
  const row = database.prepare(`SELECT e.*, r.request_json FROM evaluations e JOIN runs r USING (run_id)
    WHERE e.run_id = ? AND e.evaluation_id = ? AND e.context_id = ?`).get(runId, evaluationId, contextId) as DatabaseRow | undefined;
  if (!row) throw new RunStoreError('context_not_found', 'The evaluation and context handles do not identify a context in this run.');
  const stored = parseJsonRecord(row.request_json, 'run request');
  if (typeof stored.compilerFingerprint !== 'string' || stored.compilerFingerprint.length === 0) throw new RunStoreError('data_integrity_error', 'Stored compiler identity is invalid.');
  const packet = parseStored(decisionRequestSchema, parseJson(row.packet_json, 'frozen packet'), 'frozen packet');
  const packetFingerprint = asText(row.packet_fingerprint, 'packet fingerprint');
  if (hashCanonical({ packet, compilerFingerprint: stored.compilerFingerprint }) !== packetFingerprint) throw new RunStoreError('data_integrity_error', 'Stored context packet fingerprint does not match its frozen input.');
  return {
    runId, evaluationId, contextId,
    respondentId: asText(row.respondent_id, 'respondent ID'),
    questionId: asText(row.question_id, 'question ID'),
    status: asText(row.status, 'evaluation status') as RunContextDetail['status'],
    packet,
    provenance: { compilerFingerprint: stored.compilerFingerprint, packetFingerprint,
      contextFingerprint: hashCanonical({ state: packet.state, compilerFingerprint: stored.compilerFingerprint }) },
  };
}
