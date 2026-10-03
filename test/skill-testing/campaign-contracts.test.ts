import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertComparableManifests, prepareCampaign, type CampaignConfig } from '../../scripts/skill-testing/contracts.js';

function fixture(): { root: string; config: CampaignConfig; cleanup: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sheg-skill-campaign-contracts-'));
  const old = path.join(root, 'old');
  const candidate = path.join(root, 'candidate');
  const setupArm = (directory: string, label: string) => {
    mkdirSync(path.join(directory, 'references'), { recursive: true });
    writeFileSync(path.join(directory, 'SKILL.md'), `---\ndescription: ${label} guidance\n---\n${label} skill body`);
    writeFileSync(path.join(directory, 'references', 'policy.md'), `${label} reference`);
  };
  setupArm(old, 'old');
  setupArm(candidate, 'candidate');
  const config: CampaignConfig = {
    id: 'frozen-skill-check',
    scenarioId: 'selected-material-isolation-no-fit',
    suite: 'focused',
    classification: 'capability',
    repetitions: 2,
    concurrency: 1,
    timeoutMs: 60000,
    execution: { adapter: 'codex', model: 'test-model', reasoning: 'medium' },
    arms: [
      { id: 'old', guidanceRoot: old, referencePaths: ['references/policy.md'] },
      { id: 'candidate', guidanceRoot: candidate, referencePaths: ['references/policy.md'] },
    ],
  };
  return { root, config, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('preparation freezes each guidance arm and renders prompts from the frozen copy', () => {
  const input = fixture();
  try {
    const output = path.join(input.root, 'campaign');
    const manifest = prepareCampaign(input.config, output);
    writeFileSync(path.join(input.root, 'old', 'references', 'policy.md'), 'mutated after preparation');
    const oldArm = manifest.arms.find((arm) => arm.id === 'old');
    assert.ok(oldArm);
    assert.match(oldArm.actorPrompt, /old reference/);
    assert.doesNotMatch(oldArm.actorPrompt, /mutated after preparation/);
    assert.equal(readFileSync(path.join(output, 'snapshots', 'old', 'references', 'policy.md'), 'utf8'), 'old reference');
  } finally { input.cleanup(); }
});

test('comparison rejects changes to scenario evidence, criteria, or execution settings', () => {
  const input = fixture();
  try {
    const first = prepareCampaign(input.config, path.join(input.root, 'first'));
    const changed = prepareCampaign({
      ...input.config,
      execution: { ...input.config.execution, model: 'different-model' },
    }, path.join(input.root, 'second'));
    assert.throws(() => assertComparableManifests(first, changed), /execution/i);
  } finally { input.cleanup(); }
});

test('preparation rejects missing guidance references and output collisions', () => {
  const input = fixture();
  try {
    const missingReference: CampaignConfig = {
      ...input.config,
      arms: input.config.arms.map((arm) => ({ ...arm, referencePaths: ['references/missing.md'] })),
    };
    assert.throws(() => prepareCampaign(missingReference, path.join(input.root, 'missing')), /reference/i);
    const output = path.join(input.root, 'collision');
    prepareCampaign(input.config, output);
    assert.throws(() => prepareCampaign(input.config, output), /exist|collision|overwrite/i);
  } finally { input.cleanup(); }
});

test('trial identities are unique and discovery snapshots descriptions without skill bodies', () => {
  const input = fixture();
  try {
    const config: CampaignConfig = {
      ...input.config,
      suite: 'discovery',
      arms: [{ id: 'candidate', guidanceRoot: path.join(input.root, 'candidate'), referencePaths: [] }],
    };
    const manifest = prepareCampaign(config, path.join(input.root, 'discovery'));
    assert.equal(new Set(manifest.trials.map((trial) => trial.trialId)).size, 2);
    assert.ok(manifest.arms[0]?.discoveryPrompt.includes('candidate guidance'));
    assert.ok(!manifest.arms[0]?.discoveryPrompt.includes('candidate skill body'));
    const noGuidance = prepareCampaign({
      ...input.config,
      arms: [{ id: 'no-guidance', referencePaths: [] }],
    }, path.join(input.root, 'no-guidance'));
    assert.doesNotMatch(noGuidance.arms[0]!.actorPrompt, /candidate skill body|candidate reference/);
    assert.deepEqual(noGuidance.arms[0]!.skillReferenceHashes, {});
  } finally { input.cleanup(); }
});
