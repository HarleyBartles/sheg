import { evaluatorResultSchema, actorTraceSchema, loadEvaluatorCatalog, loadScenarioCatalog } from '../skill-scenario.js';
import { runRequestSchema } from '../../src/domain/run/request.js';
import { z } from 'zod';

export type CriterionGrade = { criterionId: string; result: 'pass' | 'fail' | 'uncertain'; evidence: string };
export type TrialGrade = {
  actorContract: { result: 'pass' | 'fail'; issues: string[] };
  deterministic: { result: 'pass' | 'fail' | 'not-applicable'; issues: string[] };
  semantic: { result: 'pass' | 'fail' | 'uncertain' | 'not-run'; criteria: CriterionGrade[]; error?: string };
};

export interface FrozenScenarioForGrading {
  id: string;
  version: number;
  controlledEvidence: unknown;
}

function selectedMaterialIssues(requestValue: unknown, controlledEvidence: unknown): string[] {
  if (!requestValue || typeof requestValue !== 'object' || (requestValue as { kind?: unknown }).kind !== 'follow-on') return [];
  if (!controlledEvidence || typeof controlledEvidence !== 'object') return [];
  const queryResult = (controlledEvidence as { queryResult?: { items?: unknown } }).queryResult;
  if (!queryResult || !Array.isArray(queryResult.items)) return [];
  if ((requestValue as { sourceRunId?: unknown }).sourceRunId !== (queryResult as { sourceRunId?: unknown }).sourceRunId) return ['Follow-on request sourceRunId does not match the source run in frozen evidence.'];
  const items = queryResult.items.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null);
  const request = requestValue as { sourceRunId?: unknown; selection?: { criteria?: Record<string, unknown>; references?: Array<{ evaluationId: string; contextId: string }> }; context?: { mode?: string; materialIds?: string[] }; material?: Array<{ id: string; text: string; sourceId?: string; sourceSha256?: string }> };
  const selected = request.selection?.references
    ? items.filter((item) => request.selection!.references!.some((reference) => reference.evaluationId === item.evaluationId && reference.contextId === item.contextId))
    : items.filter((item) => Object.entries(request.selection?.criteria ?? {}).every(([key, value]) => {
      if (key === 'answer' && value && typeof value === 'object') {
        const answer = value as { type?: unknown; choiceId?: unknown; operator?: unknown; value?: unknown };
        const result = item.result as { type?: unknown; choice?: unknown; score?: unknown; noul?: unknown } | undefined;
        if (answer.type === 'choice') return result !== undefined && (result.type === 'choice' || result.type === undefined) && result.choice === answer.choiceId;
        const actual = answer.type === 'score' ? result?.score : answer.type === 'noul' ? result?.noul : undefined;
        if (typeof actual !== 'number' || typeof answer.value !== 'number') return false;
        switch (answer.operator) {
          case 'eq': return actual === answer.value;
          case 'lt': return actual < answer.value;
          case 'lte': return actual <= answer.value;
          case 'gt': return actual > answer.value;
          case 'gte': return actual >= answer.value;
          default: return false;
        }
      }
      if (key === 'materialId') return (item.selectedMaterial as { materialId?: unknown } | undefined)?.materialId === value;
      return item[key] === value;
    }));
  if (request.selection?.references && request.selection.references.some((reference) => !items.some((item) => item.evaluationId === reference.evaluationId && item.contextId === reference.contextId))) return ['Follow-on selection contains a reference absent from the frozen evidence.'];
  if (!selected.length) return ['Follow-on selection does not resolve to any exact respondent evidence in the frozen evidence.'];
  if (selected.some((item) => !item.selectedMaterial)) return ['Follow-on selection includes a respondent whose frozen evidence has no selected material (including no-fit results).'];
  if (selected.length && selected.some((item) => item.sourceRunId !== (queryResult as { sourceRunId?: unknown }).sourceRunId)) return ['Follow-on request does not target the source run in the frozen evidence.'];
  const materialIds = [...new Set(selected.map((item) => (item.selectedMaterial as { materialId: string }).materialId))];
  if (materialIds.length > 1) return ['The selected respondents have different material, which one shared follow-on request cannot provide individually.'];
  if (materialIds.length === 1) {
    if (request.context?.mode !== 'fresh-material') return ['Selected material must be supplied as fresh material to isolate it from the source context.'];
    const expectedMaterial = selected[0]!.selectedMaterial as { materialId: string; text: string; sourceId?: string; sourceSha256?: string };
    const hasExactReference = request.context.materialIds?.length === 1 && request.context.materialIds[0] === expectedMaterial.materialId;
    const hasExactInline = request.material?.length === 1 && request.material[0]?.id === expectedMaterial.materialId && request.material[0]?.text === expectedMaterial.text && request.material[0]?.sourceId === expectedMaterial.sourceId && request.material[0]?.sourceSha256 === expectedMaterial.sourceSha256;
    if (request.material && !hasExactInline) return [`Inline follow-on material must contain only the exact frozen selected material ${materialIds[0]}.`];
    if (request.context.materialIds && !hasExactReference) return [`Follow-on material must contain only selected material ${materialIds[0]}.`];
    if (!hasExactReference && !hasExactInline) return [`Follow-on material must contain only selected material ${materialIds[0]}.`];
  }
  return [];
}

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

export function gradeTrial(scenarioId: string, actorValue: unknown, semanticValue?: unknown, frozenCriteria?: readonly { id: string; condition: string }[], suite: 'focused' | 'discovery' | 'workflow' = 'focused', expectedToolsByTurn: readonly (readonly string[])[] = [], observedToolsByTurn?: readonly (readonly string[])[], frozenScenario?: FrozenScenarioForGrading): TrialGrade {
  const scenario = frozenScenario ?? loadScenarioCatalog().find((item) => item.id === scenarioId);
  const evaluator = frozenCriteria ? undefined : loadEvaluatorCatalog().find((item) => item.scenarioId === scenarioId);
  if (!scenario || scenario.id !== scenarioId || (!frozenCriteria && !evaluator)) throw new Error(`Unknown scenario: ${scenarioId}`);
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
    const requestValue = action.input.request ?? action.input;
    const request = runRequestSchema.safeParse(requestValue);
    if (!request.success) requestIssues.push(`actions.${index}: ${request.error.issues.map((issue) => issue.message).join('; ')}`);
    else requestIssues.push(...selectedMaterialIssues(request.data, scenario.controlledEvidence).map((issue) => `actions.${index}: ${issue}`));
  }
  const semantic = semanticValue === undefined ? undefined : evaluatorResultSchema.safeParse(semanticValue);
  const criteriaBasis = frozenCriteria ?? evaluator!.criteria;
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
