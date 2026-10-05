import type { EvidenceCriteria } from '../../domain/run/request.js';

const numericOperators = { eq: '=', lt: '<', lte: '<=', gt: '>', gte: '>=' } as const;

export function evaluationCriteriaSql(criteria: EvidenceCriteria): { sql: string[]; parameters: Array<string | number> } {
  const sql: string[] = [];
  const parameters: Array<string | number> = [];
  if (criteria.respondentId !== undefined) { sql.push('e.respondent_id = ?'); parameters.push(criteria.respondentId); }
  if (criteria.status !== undefined) { sql.push('e.status = ?'); parameters.push(criteria.status); }
  if (criteria.questionId !== undefined) { sql.push('e.question_id = ?'); parameters.push(criteria.questionId); }
  if (criteria.materialId !== undefined) {
    sql.push("EXISTS (SELECT 1 FROM json_each(e.packet_json, '$.state.encounteredItems') AS encountered WHERE json_extract(encountered.value, '$.id') = ?)");
    parameters.push(criteria.materialId);
  }
  if (criteria.answer?.type === 'choice') {
    sql.push("json_extract(e.result_json, '$.value.type') = 'choice' AND json_extract(e.result_json, '$.value.choice') = ?");
    parameters.push(criteria.answer.choiceId);
  } else if (criteria.answer?.type === 'score' || criteria.answer?.type === 'noul') {
    const field = criteria.answer.type;
    sql.push(`json_extract(e.result_json, '$.value.type') = '${field}' AND json_extract(e.result_json, '$.value.${field}') ${numericOperators[criteria.answer.operator]} ?`);
    parameters.push(criteria.answer.value);
  }
  if (criteria.outcome !== undefined) { sql.push('jr.outcome = ?'); parameters.push(criteria.outcome); }
  return { sql, parameters };
}
