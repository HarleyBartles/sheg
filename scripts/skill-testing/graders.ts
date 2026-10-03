import { evaluatorResultSchema, actorTraceSchema, loadEvaluatorCatalog, loadScenarioCatalog } from '../skill-scenario.js';
import { runRequestSchema } from '../../src/domain/run/request.js';
import { z } from 'zod';

export type CriterionGrade = { criterionId: string; result: 'pass' | 'fail' | 'uncertain'; evidence: string };
export type TrialGrade = {
  actorContract: { result: 'pass' | 'fail'; issues: string[] };
  deterministic: { result: 'pass' | 'fail' | 'not-applicable'; issues: string[] };
  semantic: { result: 'pass' | 'fail' | 'uncertain' | 'not-run'; criteria: CriterionGrade[]; error?: string };
};

export const discoveryTraceSchema = z.object({
  scenarioId: z.string(),
  scenarioVersion: z.number().int().positive(),
  selectedSkill: z.enum(['study-design', 'stimulus-response-polling']).nullable(),
  rationale: z.string().min(1),
}).strict();

export function extractShegToolCalls(rawEvents: string): string[] {
  const calls: string[] = [];
  for (const line of rawEvents.split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; server?: string; tool?: string } };
      if (event.type === 'item.started' && event.item?.type === 'mcp_tool_call' && event.item.server === 'sheg' && event.item.tool) calls.push(event.item.tool);
    } catch { /* Retain malformed events for inspection; they cannot prove a Sheg call. */ }
  }
  return calls;
}

export function gradeTrial(scenarioId: string, actorValue: unknown, semanticValue?: unknown, frozenCriteria?: readonly { id: string; condition: string }[], suite: 'focused' | 'discovery' | 'workflow' = 'focused', expectedToolsByTurn: readonly (readonly string[])[] = [], observedToolsByTurn?: readonly (readonly string[])[]): TrialGrade {
  const scenario = loadScenarioCatalog().find((item) => item.id === scenarioId);
  const evaluator = loadEvaluatorCatalog().find((item) => item.scenarioId === scenarioId);
  if (!scenario || !evaluator) throw new Error(`Unknown scenario: ${scenarioId}`);
  const discovery = suite === 'discovery' ? discoveryTraceSchema.safeParse(actorValue) : undefined;
  const normalizedActorValue = suite === 'discovery' && discovery?.success ? {
    scenarioId: discovery.data.scenarioId, scenarioVersion: discovery.data.scenarioVersion, actions: [],
    finalResponse: JSON.stringify({ selectedSkill: discovery.data.selectedSkill, rationale: discovery.data.rationale }), uncertainties: [],
  } : actorValue;
  const actor = actorTraceSchema.safeParse(normalizedActorValue);
  const actorIssues = actor.success ? [] : actor.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  if (suite === 'discovery' && !discovery?.success) actorIssues.push(...(discovery?.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) ?? ['Discovery result is invalid.']));
  if (actor.success && (actor.data.scenarioId !== scenario.id || actor.data.scenarioVersion !== scenario.version)) actorIssues.push('Actor scenario identity does not match the frozen scenario.');
  const requestIssues: string[] = [];
  if (suite === 'workflow') {
    if (!observedToolsByTurn) requestIssues.push('Per-turn Sheg MCP event boundaries were not captured, so workflow tool checkpoints cannot be verified.');
    else {
      const turnCount = Math.max(expectedToolsByTurn.length, observedToolsByTurn.length);
      for (let index = 0; index < turnCount; index += 1) {
        const expected = expectedToolsByTurn[index] ?? [];
        const observed = observedToolsByTurn[index] ?? [];
        if (expected.length !== observed.length || expected.some((tool, toolIndex) => observed[toolIndex] !== tool)) {
          requestIssues.push(`Workflow turn ${index + 1} expected Sheg tools [${expected.join(', ')}] in order, observed [${observed.join(', ')}].`);
        }
      }
      if (expectedToolsByTurn.length !== observedToolsByTurn.length) requestIssues.push(`Expected ${expectedToolsByTurn.length} workflow turns with event records, observed ${observedToolsByTurn.length}.`);
    }
  }
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
