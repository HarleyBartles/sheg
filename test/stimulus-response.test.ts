import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { respondentCohortSchema } from '../src/domain/respondents/cohort.js';
import { loadStudy } from '../src/infrastructure/study-loader.js';
import type { StudyArm } from '../src/domain/study/arm.js';
import { studyManifestSchema, type StudyManifest } from '../src/domain/study/study.js';

const sourceText = 'The passage gives enough evidence to answer the question.';
const sourceHash = createHash('sha256').update(sourceText).digest('hex');

function comprehensionArm(id: string, text = sourceText): StudyArm {
  return {
    id,
    label: id.toUpperCase(),
    sources: [{ path: `${id}.md`, sha256: sourceHash }],
    items: [{ id: 'passage', text }],
    tasks: [{
      id: 'comprehension',
      instructions: 'Which answer is supported by the passage?',
      comparisonKey: 'passage-comprehension',
      options: {
        supported: 'The passage supports this answer.',
        contradicted: 'The passage contradicts this answer.',
        unanswerable: 'The passage does not provide enough information.',
      },
      answerKeyOptionId: 'supported',
    }],
    presentation: { kind: 'sequence' as const },
  };
}


function study(arms: StudyArm[] = [comprehensionArm('control')]): StudyManifest {
  return {
    version: '2.0',
    study: { title: 'Passage comprehension', purpose: 'Check whether the passage supports the answer.' },
    arms,
  };
}

const respondent = {
  id: 'respondent-a',
  intent: 'Find a defensible answer.',
  context: 'Comfortable reading short explanatory text.',
  desired_outcome: 'Understand what the passage supports.',
  engagement_cues: 'Clear evidence.',
  friction_cues: 'Unsupported certainty.',
};

test('accepts a graph-free comprehension study with an unanswerable option and hidden answer key', () => {
  const result = studyManifestSchema.safeParse(study());
  assert.equal(result.success, true, result.success ? '' : result.error.message);
});

test('accepts a frozen cohort of distinct stimulus respondents', () => {
  const cohort = respondentCohortSchema.safeParse({ version: '3.0', respondents: [respondent] });
  assert.equal(cohort.success, true, cohort.success ? '' : cohort.error.message);
});

test('accepts matched arms that share comparison and stable option identifiers', () => {
  const left = comprehensionArm('control');
  const right = comprehensionArm('revision', 'The revised passage gives clearer evidence for the answer.');
  assert.equal(studyManifestSchema.safeParse(study([left, right])).success, true);
});

test('rejects an answer key that does not identify one offered option', () => {
  const arm = { ...comprehensionArm('control'), tasks: [{ ...comprehensionArm('control').tasks[0]!, answerKeyOptionId: 'missing' }] };
  assert.equal(studyManifestSchema.safeParse(study([arm])).success, false);
});

test('validates graph task transitions against stable offered option IDs', () => {
  const arm = {
    ...comprehensionArm('control'),
    presentation: {
      kind: 'graph' as const,
      entryNodeId: 'show-passage',
      maxDecisions: 2,
      nodes: [
        { id: 'show-passage', kind: 'expose' as const, itemId: 'passage' },
        { id: 'ask-question', kind: 'ask' as const, taskId: 'comprehension' },
        { id: 'answered', kind: 'terminal' as const, outcome: 'answered' },
        { id: 'no-answer', kind: 'terminal' as const, outcome: 'no-answer' },
        { id: 'insufficient-evidence', kind: 'terminal' as const, outcome: 'insufficient-evidence' },
      ],
      transitions: [
        { fromNodeId: 'show-passage', toNodeId: 'ask-question' },
        { fromNodeId: 'ask-question', optionId: 'supported', toNodeId: 'answered' },
        { fromNodeId: 'ask-question', optionId: 'contradicted', toNodeId: 'no-answer' },
        { fromNodeId: 'ask-question', optionId: 'unanswerable', toNodeId: 'insufficient-evidence' },
      ],
    },
  };
  assert.equal(studyManifestSchema.safeParse(study([arm])).success, true);
  arm.presentation.transitions[1]!.optionId = 'not-offered';
  assert.equal(studyManifestSchema.safeParse(study([arm])).success, false);
});

function graphArm(decisionCount: number, maxDecisions = 4): StudyArm {
  const arm = comprehensionArm('control');
  const nodes: Extract<StudyArm['presentation'], { kind: 'graph' }>['nodes'] = Array.from({ length: decisionCount }, (_, index) => ({
    id: `ask-${index}`,
    kind: 'ask' as const,
    taskId: 'comprehension',
  }));
  nodes.push({ id: 'finished', kind: 'terminal' as const, outcome: 'finished' });
  return {
    ...arm,
    presentation: {
      kind: 'graph',
      entryNodeId: 'ask-0',
      maxDecisions,
      nodes,
      transitions: nodes.flatMap((node) => node.kind === 'ask'
        ? Object.keys(arm.tasks[0]!.options).map((optionId) => ({
          fromNodeId: node.id,
          optionId,
          toNodeId: node.id === `ask-${decisionCount - 1}` ? 'finished' : `ask-${Number(node.id.slice(4)) + 1}`,
        }))
        : []),
    },
  };
}

test('rejects a graph whose reachable ask-option path cycles', () => {
  const arm = graphArm(1);
  const presentation = arm.presentation;
  assert.equal(presentation.kind, 'graph');
  presentation.transitions[0]!.toNodeId = 'ask-0';

  const result = studyManifestSchema.safeParse(study([arm]));
  assert.equal(result.success, false);
  assert.match(result.error.issues.map((issue) => issue.message).join('\n'), /cycle/i);
});

test('rejects exposure-only graph cycles', () => {
  const arm = graphArm(1);
  const presentation = arm.presentation;
  assert.equal(presentation.kind, 'graph');
  presentation.nodes.unshift({ id: 'show-passage', kind: 'expose', itemId: 'passage' });
  presentation.entryNodeId = 'show-passage';
  presentation.transitions.unshift({ fromNodeId: 'show-passage', toNodeId: 'ask-0' });
  presentation.transitions[1]!.toNodeId = 'show-passage';

  const result = studyManifestSchema.safeParse(study([arm]));
  assert.equal(result.success, false);
  assert.match(result.error.issues.map((issue) => issue.message).join('\n'), /cycle/i);
});

test('rejects every branch that cannot reach a terminal within maxDecisions', () => {
  const result = studyManifestSchema.safeParse(study([graphArm(3, 2)]));
  assert.equal(result.success, false);
  assert.match(result.error.issues.map((issue) => issue.message).join('\n'), /maxDecisions|terminal/i);
});

test('accepts a branching graph when every branch terminates within maxDecisions', () => {
  const result = studyManifestSchema.safeParse(study([graphArm(3, 3)]));
  assert.equal(result.success, true, result.success ? '' : result.error.message);
});

test('rejects duplicate respondent IDs in a frozen cohort', () => {
  const result = respondentCohortSchema.safeParse({ version: '3.0', respondents: [respondent, respondent] });
  assert.equal(result.success, false);
});

test('loads and hashes source files belonging to every arm', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'system-one-study-'));
  try {
    await writeFile(path.join(directory, 'control.md'), sourceText);
    await writeFile(path.join(directory, 'revision.md'), sourceText);
    const manifest = study([comprehensionArm('control'), comprehensionArm('revision')]);
    await writeFile(path.join(directory, 'study.json'), JSON.stringify(manifest));
    await writeFile(path.join(directory, 'respondents.json'), JSON.stringify({ version: '3.0', respondents: [respondent] }));

    const loaded = await loadStudy(path.join(directory, 'study.json'), path.join(directory, 'respondents.json'));
    assert.deepEqual(loaded.sources.map((source) => source.sha256), [sourceHash, sourceHash]);
    assert.equal(loaded.respondents.length, 1);
    assert.equal(loaded.respondents[0]?.id, 'respondent-a');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
