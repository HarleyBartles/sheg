import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { RunStoreError } from '../../application/run-store.js';
import { decisionRequestSchema } from '../../domain/decision/decision.js';
import { followOnLineageSchema, followOnRunRequestSchema, runRequestSchema, type FollowOnLineage, type FollowOnSourceSet, type ParsedFollowOnRunRequest } from '../../domain/run/request.js';
import { asNumber, asText, parseJson, type DatabaseRow } from './rows.js';
import { materialCatalogForRequest, resultFromStorage } from './evidence-records.js';

export function loadFollowOnSources(database: DatabaseSync, input: ParsedFollowOnRunRequest, notFound: () => Error): FollowOnSourceSet {
  const request = followOnRunRequestSchema.parse(input);
  const run = database.prepare('SELECT status, used_calls, reserved_calls, request_json FROM runs WHERE run_id = ?').get(request.sourceRunId) as DatabaseRow | undefined;
  if (!run) throw notFound();
  const stored = parseJson<{ request?: unknown; lineage?: unknown }>(run.request_json, 'source run request');
  const sourceRequest = runRequestSchema.safeParse(stored.request);
  if (!sourceRequest.success) throw new RunStoreError('data_integrity_error', 'Stored source run request is invalid.');
  let sourceLineage: FollowOnLineage | undefined;
  if (sourceRequest.data.kind === 'follow-on') {
    const parsedLineage = followOnLineageSchema.safeParse(stored.lineage);
    if (!parsedLineage.success) throw new RunStoreError('data_integrity_error', 'Stored source follow-on material lineage is invalid.');
    sourceLineage = parsedLineage.data;
  }
  const sourceStatus = asText(run.status, 'run status') as FollowOnSourceSet['sourceStatus'];
  const usedCalls = asNumber(run.used_calls, 'used calls');
  const reservedCalls = asNumber(run.reserved_calls, 'reserved calls');
  const maxOrdinal = asNumber((database.prepare('SELECT COALESCE(MAX(ordinal), -1) AS maximum FROM evaluations WHERE run_id = ?').get(request.sourceRunId) as DatabaseRow).maximum, 'maximum evaluation ordinal');
  const where = ['e.run_id = ?', 'e.ordinal <= ?'];
  const parameters: Array<string | number> = [request.sourceRunId, maxOrdinal];
  if ('references' in request.selection) {
    where.push(`EXISTS (
      SELECT 1 FROM json_each(?) AS selected
      WHERE json_extract(selected.value, '$.evaluationId') = e.evaluation_id
        AND json_extract(selected.value, '$.contextId') = e.context_id
    )`);
    parameters.push(JSON.stringify(request.selection.references));
  } else {
    const criteria = request.selection.criteria;
    if (criteria.respondentId !== undefined) { where.push('e.respondent_id = ?'); parameters.push(criteria.respondentId); }
    if (criteria.status !== undefined) { where.push('e.status = ?'); parameters.push(criteria.status); }
    if (criteria.questionId !== undefined) { where.push('e.question_id = ?'); parameters.push(criteria.questionId); }
    if (criteria.materialId !== undefined) {
      where.push("EXISTS (SELECT 1 FROM json_each(e.packet_json, '$.state.encounteredItems') AS encountered WHERE json_extract(encountered.value, '$.id') = ?)");
      parameters.push(criteria.materialId);
    }
    if (criteria.answer?.type === 'choice') {
      where.push("json_extract(e.result_json, '$.value.type') = 'choice' AND json_extract(e.result_json, '$.value.choice') = ?");
      parameters.push(criteria.answer.choiceId);
    } else if (criteria.answer?.type === 'score' || criteria.answer?.type === 'noul') {
      const field = criteria.answer.type === 'score' ? 'score' : 'noul';
      const operator = criteria.answer.operator === 'eq' ? '=' : criteria.answer.operator === 'lt' ? '<' : criteria.answer.operator === 'lte' ? '<=' : criteria.answer.operator === 'gt' ? '>' : '>=';
      where.push(`json_extract(e.result_json, '$.value.type') = '${field}' AND json_extract(e.result_json, '$.value.${field}') ${operator} ?`);
      parameters.push(criteria.answer.value);
    }
    if (criteria.outcome !== undefined) { where.push('jr.outcome = ?'); parameters.push(criteria.outcome); }
  }
  const rows = database.prepare(`SELECT e.*,
    (SELECT a.execution_json FROM evaluation_answer_attempts ea JOIN attempts a USING (attempt_id)
      WHERE ea.evaluation_id = e.evaluation_id) AS execution_json
    FROM evaluations AS e
    LEFT JOIN journey_respondents AS jr ON jr.run_id = e.run_id AND jr.respondent_id = e.respondent_id
    WHERE ${where.join(' AND ')} ORDER BY e.ordinal LIMIT 10001`).all(...parameters) as DatabaseRow[];
  if (rows.length > 10_000) throw new RunStoreError('follow_on_selection_too_large', 'Follow-on selection matched more than 10,000 evaluations. Narrow the criteria or use explicit references.');
  if ('references' in request.selection && rows.length !== request.selection.references.length) {
    throw new RunStoreError('follow_on_reference_not_found', 'One or more evaluation/context references were not found in the source run.');
  }
  const turns: FollowOnSourceSet['turns'] = rows.map((row) => {
    const packet = decisionRequestSchema.parse(parseJson(row.packet_json, 'source packet')) as FollowOnSourceSet['turns'][number]['packet'];
    const result = row.result_json === null ? undefined : resultFromStorage(parseJson(row.result_json, 'source answer'), row.execution_json === null ? undefined : parseJson(row.execution_json, 'source execution'));
    const contextId = asText(row.context_id, 'context ID');
    const respondentId = asText(row.respondent_id, 'respondent ID');
    const materials = materialCatalogForRequest(sourceRequest.data, sourceLineage, contextId, respondentId, packet.state.encounteredItems);
    const selectedMaterialId = result?.type === 'choice' && packet.question.type === 'choice' ? packet.question.materialOptions?.[result.choice] : undefined;
    const selectedMaterial = selectedMaterialId ? materials.find(({ id }) => id === selectedMaterialId) : undefined;
    const selectedSource = selectedMaterial?.sourceId && selectedMaterial.sourceSha256 ? {
      materialId: selectedMaterial.id,
      text: selectedMaterial.text,
      sourceId: selectedMaterial.sourceId,
      sourceSha256: selectedMaterial.sourceSha256,
      textSha256: createHash('sha256').update(selectedMaterial.text, 'utf8').digest('hex'),
    } : undefined;
    if (selectedMaterialId && !selectedSource) throw new RunStoreError('data_integrity_error', `Mapped Choice answer has no retained material evidence for ${selectedMaterialId}.`);
    return {
      evaluationId: asText(row.evaluation_id, 'evaluation ID'), contextId,
      respondentId, status: asText(row.status, 'evaluation status') as FollowOnSourceSet['turns'][number]['status'], packet, ...(result ? { result } : {}),
      materials,
      ...(selectedSource ? { selectedMaterial: selectedSource } : {}),
    };
  });
  return {
    sourceRunId: request.sourceRunId, sourceStatus, sourceComplete: sourceStatus === 'completed',
    version: { status: sourceStatus, usedCalls, reservedCalls, maxOrdinal }, turns,
  };
}
