import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { respondentCohortSchema } from '../src/domain/respondents/profile.js';
import { loadStudy } from '../src/domain/study/load-study.js';
import { manifestSchema, type StudyManifest, type StudyArm } from '../src/domain/study/manifest.js';

const sourceText = 'The passage gives enough evidence to answer the question.';
const sourceHash = createHash('sha256').update(sourceText).digest('hex');

function comprehensionArm(id: string, text = sourceText) {
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
  arrival_intent: 'Find a defensible answer.',
  background: 'Comfortable reading short explanatory text.',
  desired_payoff: 'Understand what the passage supports.',
  drawn_in_by: 'Clear evidence.',
  put_off_by: 'Unsupported certainty.',
};

test('accepts a graph-free comprehension study with an unanswerable option and hidden answer key', () => {
  const result = manifestSchema.safeParse(study());
  assert.equal(result.success, true, result.success ? '' : result.error.message);
});

test('accepts a frozen cohort of distinct stimulus respondents', () => {
  const cohort = respondentCohortSchema.safeParse({ version: '3.0', respondents: [respondent] });
  assert.equal(cohort.success, true, cohort.success ? '' : cohort.error.message);
});

test('accepts matched arms that share comparison and stable option identifiers', () => {
  const left = comprehensionArm('control');
  const right = comprehensionArm('revision', 'The revised passage gives clearer evidence for the answer.');
  assert.equal(manifestSchema.safeParse(study([left, right])).success, true);
});

test('rejects an answer key that does not identify one offered option', () => {
  const arm = { ...comprehensionArm('control'), tasks: [{ ...comprehensionArm('control').tasks[0]!, answerKeyOptionId: 'missing' }] };
  assert.equal(manifestSchema.safeParse(study([arm])).success, false);
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
  assert.equal(manifestSchema.safeParse(study([arm])).success, true);
  arm.presentation.transitions[1]!.optionId = 'not-offered';
  assert.equal(manifestSchema.safeParse(study([arm])).success, false);
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
