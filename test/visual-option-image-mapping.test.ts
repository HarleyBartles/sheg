import assert from 'node:assert/strict';
import test from 'node:test';
import { inlineRunRequestSchema } from '../src/domain/run/request.js';
import { studyManifestSchema } from '../src/domain/study/study.js';

const digest = 'a'.repeat(64);
const portrait = { id: 'silk', type: 'image' as const, text: '', altText: 'A calm specialist in a blue coat holding a thread spool.',
  asset: { assetId: `sha256:${digest}`, sha256: digest, format: 'png' as const, width: 320, height: 400, bytes: 12_000 } };

test('pixel Choice options may map to their exact bound image materials without turning images into text selections', () => {
  const request = inlineRunRequestSchema.safeParse({ kind: 'poll', respondents: [{ id: 'reader-a', intent: 'Choose a character', context: 'Reads fantasy', desired_outcome: 'Find the protagonist', engagement_cues: 'Distinctive designs', friction_cues: 'Unclear role' }],
    material: [portrait], questions: [{ type: 'choice', id: 'character-match', instructions: 'Which portrait best fits the character brief?',
      options: { silk: 'Portrait A', 'no-fit': 'Neither' }, materialOptions: { silk: 'silk' }, visual: { mode: 'pixels', materialIds: ['silk'] } }],
    provider: { kind: 'clef', accountId: '0123456789abcdef0123456789abcdef', model: 'clef' }, maxCalls: 1 });
  assert.equal(request.success, true, request.success ? '' : request.error.message);

  const unbound = inlineRunRequestSchema.safeParse({ kind: 'poll', respondents: [{ id: 'reader-a', intent: 'Choose a character', context: 'Reads fantasy', desired_outcome: 'Find the protagonist', engagement_cues: 'Distinctive designs', friction_cues: 'Unclear role' }],
    material: [portrait], questions: [{ type: 'choice', id: 'character-match', instructions: 'Which portrait best fits the character brief?',
      options: { silk: 'Portrait A', 'no-fit': 'Neither' }, materialOptions: { silk: 'silk' } }],
    provider: { kind: 'clef', accountId: '0123456789abcdef0123456789abcdef', model: 'clef' }, maxCalls: 1 });
  assert.equal(unbound.success, false);
  const described = inlineRunRequestSchema.safeParse({ kind: 'poll', respondents: [{ id: 'reader-a', intent: 'Choose a character', context: 'Reads fantasy', desired_outcome: 'Find the protagonist', engagement_cues: 'Distinctive designs', friction_cues: 'Unclear role' }],
    material: [portrait], questions: [{ type: 'choice', id: 'character-match', instructions: 'Which portrait best fits the character brief?',
      options: { silk: 'Portrait A', 'no-fit': 'Neither' }, materialOptions: { silk: 'silk' }, visual: { mode: 'described', materialIds: ['silk'] } }],
    provider: { kind: 'clef', accountId: '0123456789abcdef0123456789abcdef', model: 'clef' }, maxCalls: 1 });
  assert.equal(described.success, false);

  const study = studyManifestSchema.safeParse({ version: '2.0', study: { title: 'Character fit', purpose: 'Compare portraits with the character brief.' }, arms: [{
    id: 'portrait-test', label: 'Portrait test', sources: [{ path: 'character-brief.md', sha256: 'b'.repeat(64) }], items: [portrait], tasks: [{ type: 'choice', id: 'character-match', instructions: 'Which portrait best fits the character brief?',
      options: { silk: 'Portrait A', 'no-fit': 'Neither' }, materialOptions: { silk: 'silk' }, visual: { mode: 'pixels', materialIds: ['silk'] } }],
    presentation: { kind: 'sequence' },
  }] });
  assert.equal(study.success, true, study.success ? '' : study.error.message);
});
