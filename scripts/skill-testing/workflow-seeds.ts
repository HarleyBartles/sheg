import { randomUUID } from 'node:crypto';
import type { DecisionProvider, ProviderContextFit } from '../../src/domain/decision/provider.js';
import type { DecisionResult } from '../../src/domain/decision/decision.js';
import type { PromptState } from '../../src/domain/decision/prompt.js';
import { executeQuestionRun } from '../../src/application/question-worker.js';
import { materializeJourneyRun, prepareRun } from '../../src/application/run-inspection.js';
import { runRequestSchema } from '../../src/domain/run/request.js';
import { openRunStore } from '../../src/infrastructure/run-store.js';
import type { CampaignManifest } from './contracts.js';

type WorkflowSetup = NonNullable<CampaignManifest['workflowSetup']>;

const partialJourneyRequest = runRequestSchema.parse({
  kind: 'journey',
  respondents: [
    { id: 'reader-a', intent: 'Understand the claim', context: 'Reader A', desired_outcome: 'Decide what to do', engagement_cues: 'Specific evidence', friction_cues: 'Unsupported claims' },
    { id: 'reader-b', intent: 'Understand the claim', context: 'Reader B', desired_outcome: 'Decide what to do', engagement_cues: 'Specific evidence', friction_cues: 'Unsupported claims' },
  ],
  journey: {
    id: 'partial-journey-recovery', label: 'Partial journey recovery fixture',
    items: [{ id: 'opening', text: 'The article introduces a service change.' }, { id: 'evidence', text: 'The article explains who benefits and what changes.' }],
    tasks: [
      { id: 'interest', type: 'choice', instructions: 'Would you continue reading?', options: { continue: 'Continue', leave: 'Leave' } },
      { id: 'clarity', type: 'score', instructions: 'How clear was the evidence?', rubric: ['Unclear', 'Mixed', 'Clear'] },
    ],
    presentation: { kind: 'graph', entryNodeId: 'opening-node', maxDecisions: 2, nodes: [
      { id: 'opening-node', kind: 'expose', itemId: 'opening' },
      { id: 'ask-interest', kind: 'ask', taskId: 'interest' },
      { id: 'evidence-node', kind: 'expose', itemId: 'evidence' },
      { id: 'ask-clarity', kind: 'ask', taskId: 'clarity' },
      { id: 'left', kind: 'terminal', outcome: 'left' },
      { id: 'clear', kind: 'terminal', outcome: 'clear' },
    ], transitions: [
      { fromNodeId: 'opening-node', toNodeId: 'ask-interest' },
      { fromNodeId: 'ask-interest', optionId: 'continue', toNodeId: 'evidence-node' },
      { fromNodeId: 'ask-interest', optionId: 'leave', toNodeId: 'left' },
      { fromNodeId: 'evidence-node', toNodeId: 'ask-clarity' },
      { fromNodeId: 'ask-clarity', when: { type: 'score', minimum: 0, maximum: 2, minimumInclusive: true, maximumInclusive: true }, toNodeId: 'clear' },
    ] },
  },
  provider: { kind: 'jev', route: 'typesafe', model: 'jev-latest' },
  maxCalls: 8,
});

function fit(): ProviderContextFit {
  return { provider: 'jev', status: 'fits', method: 'deterministic-workflow-fixture', modelIdentity: 'jev-latest', tokenCount: 'estimated',
    tokens: 1, contextLimit: 32_000, headroomTokens: 0, effectiveLimit: 32_000, details: {} };
}

function choice(choiceId: 'continue' | 'leave'): DecisionResult {
  return { type: 'choice', choice: choiceId, probabilities: { continue: choiceId === 'continue' ? 0.9 : 0.1, leave: choiceId === 'leave' ? 0.9 : 0.1 },
    attempts: 1, provider: 'jev', model: 'jev-latest', latencyMs: 1, usage: {} };
}

const seedProvider: DecisionProvider = {
  measure() { return fit(); },
  async decide(request) {
    const profile = (request.state as PromptState).respondent.profile.context;
    if (request.question.id === 'interest' && profile === 'Reader A') return choice('leave');
    if (request.question.id === 'interest' && profile === 'Reader B') return choice('continue');
    throw new Error('Controlled respondent-local failure at the reached clarity turn.');
  },
};

export async function seedWorkflowState(setup: WorkflowSetup, dataRoot: string): Promise<{ runId: string }> {
  if (setup.kind !== 'partial-journey-recovery' || setup.version !== 1) throw new Error('Unsupported workflow state fixture.');
  const admission = await prepareRun(partialJourneyRequest, seedProvider);
  if (!admission.journey) throw new Error(`Could not prepare partial-journey state: ${admission.inspection.problems.map(({ message }) => message).join('; ')}`);
  const store = openRunStore(dataRoot);
  try {
    const accepted = store.acceptJourney(randomUUID(), materializeJourneyRun(admission.journey));
    await executeQuestionRun(store, accepted.run.runId, () => seedProvider);
    const seeded = store.getStatus(accepted.run.runId);
    if (seeded.status !== 'partial' || seeded.usedCalls !== 3 || seeded.maxCalls !== 8 || seeded.reservedCalls !== 0) {
      throw new Error('Partial-journey workflow state did not settle at its expected safe checkpoint.');
    }
    return { runId: accepted.run.runId };
  } finally { store.close(); }
}
