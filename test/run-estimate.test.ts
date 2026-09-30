import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadRespondents } from '../src/domain/respondents/cohort.js';
import { estimateRunDecisionCalls } from '../src/domain/journey/route-bounds.js';
import { studyManifestSchema } from '../src/domain/study/study.js';
import type { StudyArm } from '../src/domain/study/arm.js';

const fixtures = new URL('./fixtures/', import.meta.url);
const manifest = studyManifestSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL('article.json', fixtures)), 'utf8')));
const cohort = JSON.parse(readFileSync(fileURLToPath(new URL('cohort.json', fixtures)), 'utf8')) as unknown;
const respondents = loadRespondents(cohort);
const arm = manifest.arms[0]!;

test('reports the minimum and maximum reachable calls for short and long graph branches', () => {
  assert.deepEqual(estimateRunDecisionCalls([arm], respondents.slice(0, 1)), {
    minimumDecisionCalls: 1,
    maximumDecisionCalls: 3,
  });
});

test('aggregates every arm and respondent while sequences always ask every task', () => {
  const sequence: StudyArm = { ...arm, id: 'sequence', presentation: { kind: 'sequence' } };
  const secondSequence: StudyArm = { ...arm, id: 'sequence-two', tasks: arm.tasks.slice(0, 2), presentation: { kind: 'sequence' } };
  assert.deepEqual(estimateRunDecisionCalls([sequence, secondSequence], respondents.slice(0, 2)), {
    minimumDecisionCalls: 10,
    maximumDecisionCalls: 10,
  });
});

test('counts each route through a reconverged continuation without expanding complete journeys', () => {
  const reconverged: StudyArm = {
    ...arm,
    presentation: {
      kind: 'graph',
      entryNodeId: 'start',
      maxDecisions: 2,
      nodes: [
        { id: 'start', kind: 'ask', taskId: 'entry-response' },
        { id: 'merge', kind: 'ask', taskId: 'entry-response' },
        { id: 'finished', kind: 'terminal', outcome: 'finished' },
      ],
      transitions: [
        { fromNodeId: 'start', optionId: 'continue', toNodeId: 'merge' },
        { fromNodeId: 'start', optionId: 'leave', toNodeId: 'merge' },
        { fromNodeId: 'merge', optionId: 'continue', toNodeId: 'finished' },
        { fromNodeId: 'merge', optionId: 'leave', toNodeId: 'finished' },
      ],
    },
  };
  assert.deepEqual(estimateRunDecisionCalls([reconverged], respondents.slice(0, 1)), {
    minimumDecisionCalls: 2,
    maximumDecisionCalls: 2,
  });
});
