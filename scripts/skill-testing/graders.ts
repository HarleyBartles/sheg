import { evaluatorResultSchema, actorTraceSchema, loadEvaluatorCatalog, loadScenarioCatalog } from '../skill-scenario.js';
import { runRequestSchema } from '../../src/domain/run/request.js';

export type CriterionGrade = { criterionId: string; result: 'pass' | 'fail' | 'uncertain'; evidence: string };
export type TrialGrade = {
  actorContract: { result: 'pass' | 'fail'; issues: string[] };
  deterministic: { result: 'pass' | 'fail' | 'not-applicable'; issues: string[] };
  semantic: { result: 'pass' | 'fail' | 'uncertain' | 'not-run'; criteria: CriterionGrade[]; error?: string };
};

export function gradeTrial(scenarioId: string, actorValue: unknown, semanticValue?: unknown, frozenCriteria?: readonly { id: string; condition: string }[]): TrialGrade {
  const scenario = loadScenarioCatalog().find((item) => item.id === scenarioId);
  const evaluator = loadEvaluatorCatalog().find((item) => item.scenarioId === scenarioId);
  if (!scenario || !evaluator) throw new Error(`Unknown scenario: ${scenarioId}`);
  const actor = actorTraceSchema.safeParse(actorValue);
  const actorIssues = actor.success ? [] : actor.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  if (actor.success && (actor.data.scenarioId !== scenario.id || actor.data.scenarioVersion !== scenario.version)) actorIssues.push('Actor scenario identity does not match the frozen scenario.');
  const requestIssues: string[] = [];
  if (actor.success) for (const [index, action] of actor.data.actions.entries()) {
    if (!['run_inspect', 'run_start', 'run_list', 'run_query', 'run_get', 'run_cancel', 'run_resume', 'run_delete', 'run_storage'].includes(action.tool)) {
      actorIssues.push(`actions.${index}: unknown Sheg tool ${action.tool}.`);
      continue;
    }
    if (!['run_inspect', 'run_start'].includes(action.tool)) continue;
    const request = runRequestSchema.safeParse(action.input.request ?? action.input);
    if (!request.success) requestIssues.push(`actions.${index}: ${request.error.issues.map((issue) => issue.message).join('; ')}`);
  }
  const semantic = semanticValue === undefined ? undefined : evaluatorResultSchema.safeParse(semanticValue);
  const criteriaBasis = frozenCriteria ?? evaluator.criteria;
  if (semantic?.success && (semantic.data.scenarioId !== scenario.id || semantic.data.criterionResults.length !== criteriaBasis.length || criteriaBasis.some((criterion) => !semantic.data.criterionResults.some((grade) => grade.criterionId === criterion.id)))) {
    return { actorContract: { result: actorIssues.length ? 'fail' : 'pass', issues: actorIssues }, deterministic: { result: requestIssues.length ? 'fail' : actor.success ? 'pass' : 'not-applicable', issues: requestIssues }, semantic: { result: 'uncertain', criteria: [], error: 'Evaluator output does not match the frozen scenario criteria.' } };
  }
  if (semantic && !semantic.success) return { actorContract: { result: actorIssues.length ? 'fail' : 'pass', issues: actorIssues }, deterministic: { result: requestIssues.length ? 'fail' : actor.success ? 'pass' : 'not-applicable', issues: requestIssues }, semantic: { result: 'uncertain', criteria: [], error: semantic.error.issues.map((issue) => issue.message).join('; ') } };
  const criteria = semantic?.success ? semantic.data.criterionResults : [];
  return {
    actorContract: { result: actorIssues.length ? 'fail' : 'pass', issues: actorIssues },
    deterministic: { result: requestIssues.length ? 'fail' : actor.success && actor.data.actions.some((action) => ['run_inspect', 'run_start'].includes(action.tool)) ? 'pass' : 'not-applicable', issues: requestIssues },
    semantic: semantic ? { result: criteria.some((item) => item.result === 'fail') ? 'fail' : criteria.some((item) => item.result === 'uncertain') ? 'uncertain' : 'pass', criteria } : { result: 'not-run', criteria: [] },
  };
}

export function calibrationAgreement(expected: readonly CriterionGrade[], observed: readonly CriterionGrade[]): { agreement: number; disputed: string[] } {
  const ids = expected.map(({ criterionId }) => criterionId);
  const observedById = new Map(observed.map((grade) => [grade.criterionId, grade]));
  const disputed = ids.filter((id) => observedById.get(id)?.result !== expected.find((grade) => grade.criterionId === id)?.result);
  return { agreement: ids.length ? (ids.length - disputed.length) / ids.length : 1, disputed };
}
