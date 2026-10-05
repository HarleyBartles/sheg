import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { RunStoreError } from '../../application/run-store.js';
import { asNumber, asText, parseJson, type DatabaseRow } from './rows.js';
import { decodeCursor, encodeCursor, pageSize } from './cursors.js';
import { encounteredMaterialsFromState, materialCatalogForRequest, resultFromStorage, storedEvaluationFailure } from './evidence-records.js';
import { decisionRequestSchema, providerExecutionEvidenceSchema } from '../../domain/decision/decision.js';
import { hashCanonical } from '../identity.js';
import { type RunEvidencePage, type RunEvidenceQuery, type RunStatus, type RunStatusView } from '../../domain/run/lifecycle.js';
import { followOnLineageSchema, runEvidenceQuerySchema, runLifecycleSchema, runRequestSchema, type FollowOnLineage } from '../../domain/run/request.js';
import { decisionValueSchema } from '../../domain/decision/decision.js';
import { decodeStoredPayload } from './payload-codecs.js';
import { z } from 'zod';

type EvidenceCursorPayload = {
  kind: 'evidence';
  sourceRunId: string;
  criteriaFingerprint: string;
  maxOrdinal: number;
  lastOrdinal: number;
  sourceStatus: RunStatus;
  lifecycle: RunEvidencePage['lifecycle'];
  usedCalls: number;
  reservedCalls: number;
};

export type EvidenceQueryContext = {
  database: DatabaseSync;
  now(): number;
  ensureOpen(): void;
  readTransaction<T>(operation: () => T): T;
  statusInside(runId: string): RunStatusView;
  notFound(): RunStoreError;
};

export function queryEvidencePage(context: EvidenceQueryContext, input: RunEvidenceQuery): RunEvidencePage {
    context.ensureOpen();
    const parsed = runEvidenceQuerySchema.safeParse(input);
    if (!parsed.success) throw new RunStoreError('invalid_query', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    const query = parsed.data;
    const limit = pageSize(query.limit);
    const criteriaFingerprint = hashCanonical(query.criteria);
    return context.readTransaction(() => {
      const run = context.database.prepare('SELECT * FROM runs WHERE run_id = ?').get(query.sourceRunId) as DatabaseRow | undefined;
      if (!run) throw context.notFound();
      const sourceStatus = asText(run.status, 'run status') as RunStatus;
      const usedCalls = asNumber(run.used_calls, 'used calls');
      const reservedCalls = asNumber(run.reserved_calls, 'reserved calls');
      const runRecord = parseJson<{ request?: unknown; compilerFingerprint?: unknown; lineage?: unknown }>(run.request_json, 'run request');
      const parsedRequest = runRequestSchema.safeParse(runRecord.request);
      if (!parsedRequest.success || typeof runRecord.compilerFingerprint !== 'string') {
        throw new RunStoreError('data_integrity_error', 'Stored run request is invalid.');
      }
      const compilerFingerprint = runRecord.compilerFingerprint;
      let lineage: FollowOnLineage | undefined;
      if (parsedRequest.data.kind === 'follow-on') {
        const parsedLineage = followOnLineageSchema.safeParse(runRecord.lineage);
        if (!parsedLineage.success) throw new RunStoreError('data_integrity_error', 'Stored follow-on material lineage is invalid.');
        lineage = parsedLineage.data;
      }

      let cursor: EvidenceCursorPayload | undefined;
      if (query.cursor) {
        cursor = decodeCursor<EvidenceCursorPayload>(query.cursor, 'evidence');
        if (cursor.kind !== 'evidence' || cursor.sourceRunId !== query.sourceRunId || cursor.criteriaFingerprint !== criteriaFingerprint ||
            !Number.isSafeInteger(cursor.maxOrdinal) || cursor.maxOrdinal < -1 || !Number.isSafeInteger(cursor.lastOrdinal) ||
            cursor.lastOrdinal < -1 || cursor.lastOrdinal > cursor.maxOrdinal ||
            !Number.isSafeInteger(cursor.usedCalls) || cursor.usedCalls < 0 || !Number.isSafeInteger(cursor.reservedCalls) || cursor.reservedCalls < 0 ||
            !['prepared', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(cursor.sourceStatus) ||
            !runLifecycleSchema.safeParse(cursor.lifecycle).success) {
          throw new RunStoreError('invalid_cursor', 'The evidence cursor does not match this source run and criteria.');
        }
      }

      const maximumOrdinal = asNumber((context.database.prepare('SELECT COALESCE(MAX(ordinal), -1) AS maximum FROM evaluations WHERE run_id = ?').get(query.sourceRunId) as DatabaseRow).maximum, 'maximum evaluation ordinal');
      if (cursor && (cursor.maxOrdinal !== maximumOrdinal || cursor.sourceStatus !== sourceStatus || cursor.usedCalls !== usedCalls || cursor.reservedCalls !== reservedCalls)) {
        throw new RunStoreError('stale_cursor', 'The source run changed while paging this query. Start a fresh query to see its current evidence.');
      }
      const currentLifecycle = context.statusInside(query.sourceRunId).lifecycle;
      if (cursor && hashCanonical(cursor.lifecycle) !== hashCanonical(currentLifecycle)) {
        throw new RunStoreError('stale_cursor', 'The source run recovery state changed while paging this query. Start a fresh query to see its current evidence.');
      }
      const maxOrdinal = cursor?.maxOrdinal ?? maximumOrdinal;
      const where: string[] = ['e.run_id = ?', 'e.ordinal <= ?'];
      const parameters: Array<string | number> = [query.sourceRunId, maxOrdinal];
      const criteria = query.criteria;
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
        const valueExpression = criteria.answer.type === 'score' ? "json_extract(e.result_json, '$.value.score')" : "json_extract(e.result_json, '$.value.noul')";
        where.push(`json_extract(e.result_json, '$.value.type') = '${field}' AND ${valueExpression} ${criteria.answer.operator === 'eq' ? '=' : criteria.answer.operator === 'lt' ? '<' : criteria.answer.operator === 'lte' ? '<=' : criteria.answer.operator === 'gt' ? '>' : '>='} ?`);
        parameters.push(criteria.answer.value);
      }
      if (criteria.outcome !== undefined) { where.push('jr.outcome = ?'); parameters.push(criteria.outcome); }
      const whereSql = where.join(' AND ');
      const join = 'LEFT JOIN journey_respondents AS jr ON jr.run_id = e.run_id AND jr.respondent_id = e.respondent_id';
      const evaluationCoverage = {
        totalEvaluations: asNumber((context.database.prepare('SELECT COUNT(*) AS count FROM evaluations WHERE run_id = ? AND ordinal <= ?').get(query.sourceRunId, maxOrdinal) as DatabaseRow).count, 'evaluation denominator'),
        completedEvaluations: asNumber((context.database.prepare("SELECT COUNT(*) AS count FROM evaluations WHERE run_id = ? AND ordinal <= ? AND status = 'answered'").get(query.sourceRunId, maxOrdinal) as DatabaseRow).count, 'completed evaluation denominator'),
        failedEvaluations: asNumber((context.database.prepare("SELECT COUNT(*) AS count FROM evaluations WHERE run_id = ? AND ordinal <= ? AND status = 'failed'").get(query.sourceRunId, maxOrdinal) as DatabaseRow).count, 'failed evaluation denominator'),
      };
      let respondentCoverage: RunEvidencePage['coverage']['respondents'];
      {
        const total = parsedRequest.data.kind === 'journey' ? parsedRequest.data.respondents.length
          : parsedRequest.data.kind === 'poll' ? parsedRequest.data.respondents.length
            : asNumber((context.database.prepare('SELECT COUNT(DISTINCT respondent_id) AS count FROM evaluations WHERE run_id = ? AND ordinal <= ?').get(query.sourceRunId, maxOrdinal) as DatabaseRow).count, 'respondent denominator');
        const statusCounts = parsedRequest.data.kind === 'journey'
          ? context.database.prepare('SELECT status, COUNT(*) AS count FROM journey_respondents WHERE run_id = ? GROUP BY status').all(query.sourceRunId) as DatabaseRow[]
          : parsedRequest.data.kind === 'follow-on' || parsedRequest.data.kind === 'poll'
            ? context.database.prepare(`SELECT status, COUNT(*) AS count FROM (
                SELECT respondent_id, CASE
                  WHEN SUM(status = 'pending') > 0 THEN 'active'
                  WHEN SUM(status = 'failed') > 0 THEN 'failed'
                  WHEN SUM(status = 'unreached') > 0 THEN 'unreached'
                  ELSE 'answered' END AS status
                FROM evaluations WHERE run_id = ? AND ordinal <= ? GROUP BY respondent_id
              ) GROUP BY status`).all(query.sourceRunId, maxOrdinal) as DatabaseRow[]
            : context.database.prepare("SELECT status, COUNT(DISTINCT respondent_id) AS count FROM evaluations WHERE run_id = ? AND ordinal <= ? GROUP BY status").all(query.sourceRunId, maxOrdinal) as DatabaseRow[];
        const countByStatus = new Map(statusCounts.map((row) => [asText(row.status, 'respondent status'), asNumber(row.count, 'respondent count')]));
        const completed = countByStatus.get(parsedRequest.data.kind === 'journey' ? 'completed' : 'answered') ?? 0;
        const failed = countByStatus.get('failed') ?? 0;
        const unreached = countByStatus.get('unreached') ?? 0;
        respondentCoverage = { total, completed, failed, unreached, active: Math.max(0, total - completed - failed - unreached) };
      }
      const coverage = { ...evaluationCoverage, respondents: respondentCoverage };
      const lifecycle = currentLifecycle;
      const matched = (() => {
        const matchedRows = context.database.prepare(`SELECT e.evaluation_id, e.ordinal, e.status, e.respondent_id,
          json_extract(e.packet_json, '$.question') AS question_json, e.result_json
          FROM evaluations AS e ${join} WHERE ${whereSql} ORDER BY e.ordinal`).all(...parameters) as DatabaseRow[];
        const counts = { total: 0, pending: 0, answered: 0, failed: 0, unreached: 0 };
        const respondents = new Set<string>();
        const selectedMaterialIds = new Set<string>();
        const selectedMaterialRespondents = new Set<string>();
        let selectedMaterialEvaluations = 0;
        for (const row of matchedRows) {
          const status = asText(row.status, 'matched evaluation status') as keyof typeof counts;
          if (!Object.hasOwn(counts, status)) throw new RunStoreError('data_integrity_error', 'A matched evaluation has an unsupported status.');
          counts.total += 1;
          counts[status] += 1;
          const respondentId = asText(row.respondent_id, 'matched respondent ID');
          respondents.add(respondentId);
          if (status !== 'answered' || row.result_json === null) continue;
          if (typeof row.result_json !== 'string') throw new RunStoreError('data_integrity_error', 'A matched answer is not valid stored text.');
          const value = decodeStoredPayload(row.result_json, 'decision-value', decisionValueSchema);
          const question = z.object({ type: z.string(), materialOptions: z.record(z.string(), z.string()).optional() }).safeParse(parseJson(row.question_json, 'matched question'));
          if (!question.success) throw new RunStoreError('data_integrity_error', 'A matched question has invalid material mapping evidence.');
          if (value.type !== 'choice' || question.data.type !== 'choice') continue;
          const materialId = question.data.materialOptions?.[value.choice];
          if (materialId) {
            selectedMaterialEvaluations += 1;
            selectedMaterialIds.add(materialId);
            selectedMaterialRespondents.add(respondentId);
          }
        }
        return { count: counts.total, evaluations: counts, representedRespondents: respondents.size,
          selectedMaterialIds: [...selectedMaterialIds],
          selectedMaterialRespondents, selectedMaterialEvaluations,
          selectedMaterials: { evaluations: selectedMaterialEvaluations, respondents: selectedMaterialRespondents.size, distinctMaterials: selectedMaterialIds.size },
          ordinals: matchedRows.map((row) => asNumber(row.ordinal, 'matched evaluation ordinal')),
          evaluationIds: matchedRows.map((row) => asText(row.evaluation_id, 'matched evaluation ID')) };
      })();
      const matchedCoverage = { evaluations: matched.evaluations, representedRespondents: matched.representedRespondents, selectedMaterials: matched.selectedMaterials };
      const matchingOrdinalPairs = matched.ordinals.map((ordinal, index) => ({ ordinal, evaluationId: matched.evaluationIds[index]! }))
        .filter(({ ordinal }) => !cursor || ordinal > cursor.lastOrdinal);
      const pageIds = matchingOrdinalPairs.slice(0, limit + 1).map(({ evaluationId }) => evaluationId);
      const rows = pageIds.length === 0 ? [] : context.database.prepare(`SELECT e.*, jr.outcome AS route_outcome,
        (SELECT a.execution_json FROM evaluation_answer_attempts ea JOIN attempts a USING (attempt_id)
          WHERE ea.evaluation_id = e.evaluation_id) AS execution_json
        FROM evaluations AS e ${join}
        WHERE e.run_id = ? AND e.evaluation_id IN (${pageIds.map(() => '?').join(', ')}) ORDER BY e.ordinal`)
        .all(query.sourceRunId, ...pageIds) as DatabaseRow[];
      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      const endpoint = parsedRequest.data.provider.kind === 'jev'
        ? parsedRequest.data.provider.endpoint
        : parsedRequest.data.provider.baseUrl;
      const model = parsedRequest.data.provider.kind === 'jev'
        ? parsedRequest.data.provider.model
        : parsedRequest.data.provider.checkpoint;
      const items: RunEvidencePage['items'] = pageRows.map((row) => {
        const contextId = asText(row.context_id, 'context ID');
        const respondentId = asText(row.respondent_id, 'respondent ID');
        const packet = decisionRequestSchema.parse(parseJson(row.packet_json, 'evidence packet'));
        const result = row.result_json === null ? undefined : resultFromStorage(parseJson(row.result_json, 'decision result'), row.execution_json === null ? undefined : parseJson(row.execution_json, 'provider execution'));
        const failure = storedEvaluationFailure(row);
        let selectedMaterial: RunEvidencePage['items'][number]['selectedMaterial'];
        if (result?.type === 'choice') {
          const materialId = packet.question.type === 'choice' ? packet.question.materialOptions?.[result.choice] : undefined;
          if (materialId) {
            const candidate = materialCatalogForRequest(parsedRequest.data, lineage, contextId, respondentId, encounteredMaterialsFromState(packet.state)).find(({ id }) => id === materialId);
            if (!candidate || !candidate.sourceId || !candidate.sourceSha256) throw new RunStoreError('data_integrity_error', `Mapped Choice answer has no retained material evidence for ${materialId}.`);
            selectedMaterial = { materialId, text: candidate.text, sourceId: candidate.sourceId, sourceSha256: candidate.sourceSha256,
              textSha256: createHash('sha256').update(candidate.text, 'utf8').digest('hex') };
          }
        }
        return {
          sourceRunId: query.sourceRunId,
          evaluationId: asText(row.evaluation_id, 'evaluation ID'),
          contextId,
          respondentId,
          questionId: asText(row.question_id, 'question ID'),
          status: asText(row.status, 'evaluation status') as RunEvidencePage['items'][number]['status'],
          ...(result === undefined ? {} : { result }),
          ...(failure === undefined ? {} : { failure }),
          ...(selectedMaterial === undefined ? {} : { selectedMaterial }),
          ...(row.execution_json === null ? {} : { execution: providerExecutionEvidenceSchema.parse(parseJson(row.execution_json, 'provider execution')) }),
          ...(row.turn_id === null ? {} : { turnId: asText(row.turn_id, 'turn ID') }),
          ...(row.node_id === null ? {} : { nodeId: asText(row.node_id, 'node ID') }),
          ...(row.occurrence === null ? {} : { occurrence: asNumber(row.occurrence, 'turn occurrence') }),
          ...(row.route_outcome === null ? {} : { outcome: asText(row.route_outcome, 'route outcome') }),
          provenance: {
            provider: parsedRequest.data.provider.kind,
            model,
            endpoint,
            compilerFingerprint,
            contextFingerprint: hashCanonical({ state: packet.state, compilerFingerprint }),
          },
        };
      });
      const last = pageRows.at(-1);
      const sourceComplete = sourceStatus === 'completed';
      return {
        items,
        totalMatches: matched.count,
        sourceRunId: query.sourceRunId,
        sourceStatus,
        sourceComplete,
        lifecycle,
        coverage,
        matchedCoverage,
        ...(hasMore && last ? { nextCursor: encodeCursor({
          kind: 'evidence', sourceRunId: query.sourceRunId, criteriaFingerprint, maxOrdinal,
          lastOrdinal: asNumber(last.ordinal, 'evaluation ordinal'), sourceStatus,
          lifecycle, usedCalls, reservedCalls,
        } satisfies EvidenceCursorPayload) } : {}),
      };
    });
}
