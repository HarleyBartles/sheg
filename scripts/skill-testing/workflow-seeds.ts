import { createHash, randomUUID } from 'node:crypto';
import type { DecisionProvider, ProviderContextFit } from '../../src/domain/decision/provider.js';
import type { DecisionResult } from '../../src/domain/decision/decision.js';
import type { PromptState } from '../../src/domain/decision/prompt.js';
import { executeQuestionRun } from '../../src/application/question-worker.js';
import { materializeJourneyRun, prepareRun } from '../../src/application/run-inspection.js';
import { runRequestSchema } from '../../src/domain/run/request.js';
import { openRunPersistence } from '../../src/infrastructure/run-store.js';
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

const selectedMaterialRequest = runRequestSchema.parse({
  kind: 'poll',
  respondents: [
    { id: 'reader-renter', intent: 'Understand the transit claim', context: 'A first-time renter choosing where to live', desired_outcome: 'Know whether the route serves them', engagement_cues: 'Concrete trip details', friction_cues: 'Promises without evidence' },
    { id: 'reader-parent', intent: 'Understand the transit claim', context: 'A parent planning school travel', desired_outcome: 'Judge the practical reach', engagement_cues: 'Specific destinations', friction_cues: 'Missing route details' },
    { id: 'reader-resident', intent: 'Understand the transit claim', context: 'A long-time resident concerned about displacement', desired_outcome: 'Judge neighborhood effects', engagement_cues: 'Local consequences', friction_cues: 'Overstated benefits' },
  ],
  material: [
    { id: 'shared-claim', text: 'A reliable bus makes every part of a city closer.', sourceId: 'transit-claim', sourceSha256: 'a'.repeat(64) },
    ...Array.from({ length: 7 }, (_, index) => {
      const id = `p${index + 1}`;
      const text = index === 1 ? 'Passage two makes the transit claim with a concrete trip.'
        : index === 4 ? "Passage five describes how the route changes a parent's school journey."
          : `Passage ${index + 1} describes a distinct detail about the transit proposal.`;
      return { id, text, sourceId: `article-paragraph-${index + 1}`, sourceSha256: createHash('sha256').update(text, 'utf8').digest('hex') };
    }),
  ],
  questions: [{ type: 'choice', id: 'q-transit-claim', instructions: 'Which paragraph best represents the pull quote?', options: {
    ...Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`p${index + 1}`, index === 1 ? 'Passage two makes the transit claim with a concrete trip.'
      : index === 4 ? "Passage five describes how the route changes a parent's school journey."
        : `Passage ${index + 1} describes a distinct detail about the transit proposal.`])),
    'no-fit': 'None of these paragraphs represents the claim.',
  }, materialOptions: { p1: 'p1', p2: 'p2', p3: 'p3', p4: 'p4', p5: 'p5', p6: 'p6', p7: 'p7' } }],
  provider: { kind: 'jev', route: 'openrouter', model: 'typesafe/jev-1.13' },
  maxCalls: 3,
});

function fit(): ProviderContextFit {
  return { provider: 'jev', status: 'fits', method: 'deterministic-workflow-fixture', modelIdentity: 'controlled/partial-journey-recovery', tokenCount: 'estimated',
    tokens: 1, contextLimit: 32_000, headroomTokens: 0, effectiveLimit: 32_000, details: {} };
}

function choice(choiceId: 'continue' | 'leave'): DecisionResult {
  return { type: 'choice', choice: choiceId, probabilities: { continue: choiceId === 'continue' ? 0.9 : 0.1, leave: choiceId === 'leave' ? 0.9 : 0.1 },
    attempts: 1, provider: 'jev', model: 'controlled/partial-journey-recovery', latencyMs: 1, usage: {} };
}

const seedProvider: DecisionProvider = {
  measure() { return fit(); },
  async decide(request) {
    if (request.question.id === 'q-transit-claim') {
      const profile = (request.state as PromptState).respondent.profile.context;
      const choiceId = profile === 'A first-time renter choosing where to live' ? 'p2'
        : profile === 'A parent planning school travel' ? 'p5' : 'no-fit';
      const options = Object.keys(request.question.type === 'choice' ? request.question.options : {});
      const probability = 1 / Math.max(1, options.length - 1);
      const probabilities = Object.fromEntries(options.map((id) => [id, id === choiceId ? 0.8 : probability * 0.2]));
      return { type: 'choice', choice: choiceId, probabilities, attempts: 1, provider: 'jev', model: 'controlled/selected-material-follow-on', latencyMs: 1, usage: {} };
    }
    const profile = (request.state as PromptState).respondent.profile.context;
    if (request.question.id === 'interest' && profile === 'Reader A') return choice('leave');
    if (request.question.id === 'interest' && profile === 'Reader B') return choice('continue');
    throw new Error('Controlled respondent-local failure at the reached clarity turn.');
  },
};

export function seedWorkflowState(setup: Extract<WorkflowSetup, { kind: 'partial-journey-recovery' }>, dataRoot: string): Promise<{ runId: string }>;
export function seedWorkflowState(setup: Extract<WorkflowSetup, { kind: 'selected-material-follow-on' }>, dataRoot: string): Promise<{ sourceRunId: string }>;
export function seedWorkflowState(setup: WorkflowSetup, dataRoot: string): Promise<Record<string, string>>;
export async function seedWorkflowState(setup: WorkflowSetup, dataRoot: string): Promise<Record<string, string>> {
  if (setup.version !== 1) throw new Error('Unsupported workflow state fixture.');
  if (setup.kind !== 'partial-journey-recovery' && setup.kind !== 'selected-material-follow-on') throw new Error('Unsupported workflow state fixture.');
  const isSelectedMaterial = setup.kind === 'selected-material-follow-on';
  const admission = await prepareRun(isSelectedMaterial ? selectedMaterialRequest : partialJourneyRequest, seedProvider);
  if (isSelectedMaterial) {
    if (!admission.prepared) throw new Error(`Could not prepare selected-material source run: ${admission.inspection.problems.map(({ message }) => message).join('; ')}`);
    const store = openRunPersistence(dataRoot);
    try {
      const accepted = store.commands.accept(randomUUID(), admission.prepared);
      await executeQuestionRun(store, accepted.run.runId, () => seedProvider);
      const seeded = store.reads.getStatus(accepted.run.runId);
      if (seeded.status !== 'completed' || seeded.usedCalls !== 3 || seeded.maxCalls !== 3 || seeded.reservedCalls !== 0) {
        throw new Error('Selected-material workflow source did not complete at its expected controlled checkpoint.');
      }
      const answers = store.reads.queryEvidence({ sourceRunId: accepted.run.runId, criteria: { questionId: 'q-transit-claim' } });
      if (answers.items.length !== 3 || answers.items.filter(({ selectedMaterial }) => selectedMaterial).length !== 2) {
        throw new Error('Selected-material workflow source does not contain two mapped Choices and one no-fit answer.');
      }
      return { sourceRunId: accepted.run.runId };
    } finally { store.close(); }
  }
  if (!admission.journey) throw new Error(`Could not prepare partial-journey state: ${admission.inspection.problems.map(({ message }) => message).join('; ')}`);
  const store = openRunPersistence(dataRoot);
  try {
    const accepted = store.commands.acceptJourney(randomUUID(), materializeJourneyRun(admission.journey));
    await executeQuestionRun(store, accepted.run.runId, () => seedProvider);
    const seeded = store.reads.getStatus(accepted.run.runId);
    if (seeded.status !== 'partial' || seeded.usedCalls !== 3 || seeded.maxCalls !== 8 || seeded.reservedCalls !== 0) {
      throw new Error('Partial-journey workflow state did not settle at its expected safe checkpoint.');
    }
    return { runId: accepted.run.runId };
  } finally { store.close(); }
}
