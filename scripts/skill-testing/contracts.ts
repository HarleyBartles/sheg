import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadEvaluatorCatalog, loadScenarioCatalog, renderActorPrompt, renderControlPrompt } from '../skill-scenario.js';
import { readGuidanceSnapshot, sha256, stableJson, type GuidanceSnapshot } from './snapshots.js';

const armConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  guidanceRoot: z.string().min(1).optional(),
  referencePaths: z.array(z.string()),
}).strict().superRefine((arm, context) => {
  if (arm.id !== 'no-guidance' && !arm.guidanceRoot) context.addIssue({ code: 'custom', path: ['guidanceRoot'], message: 'Guided arms require a skill snapshot root.' });
  if (arm.id === 'no-guidance' && arm.guidanceRoot) context.addIssue({ code: 'custom', path: ['guidanceRoot'], message: 'The no-guidance arm cannot load a skill body.' });
});

const workflowTurnSchema = z.object({ user: z.string().min(1), evidence: z.unknown().optional() }).strict();

export const campaignConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  scenarioId: z.string().min(1),
  suite: z.enum(['focused', 'discovery', 'workflow']),
  classification: z.enum(['capability', 'regression']),
  repetitions: z.number().int().min(1).max(100),
  concurrency: z.number().int().min(1).max(32),
  timeoutMs: z.number().int().min(1000).max(3600000),
  execution: z.record(z.string(), z.unknown()),
  workflowTurns: z.array(workflowTurnSchema).min(1).optional(),
  arms: z.array(armConfigSchema).min(1),
}).strict().superRefine((config, context) => {
  if (config.suite === 'workflow' && !config.workflowTurns) context.addIssue({ code: 'custom', path: ['workflowTurns'], message: 'Workflow campaigns require ordered scripted turns.' });
  if (config.suite !== 'workflow' && config.workflowTurns) context.addIssue({ code: 'custom', path: ['workflowTurns'], message: 'Scripted turns are only valid for workflow campaigns.' });
  const ids = config.arms.map((arm) => arm.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['arms'], message: 'Campaign arm IDs must be unique.' });
});

export type CampaignConfig = z.infer<typeof campaignConfigSchema>;

const trialSchema = z.object({ trialId: z.string(), armId: z.string(), repetition: z.number().int().positive(), attempts: z.array(z.string()) }).strict();
const armSchema = z.object({
  id: z.string(),
  skillReferenceHashes: z.record(z.string(), z.string()),
  actorPrompt: z.string(),
  actorPromptSha256: z.string(),
  discoveryPrompt: z.string(),
  discoveryPromptSha256: z.string(),
}).strict();

export const campaignManifestSchema = z.object({
  schemaVersion: z.literal(1),
  campaignId: z.string(),
  scenarioId: z.string(),
  scenarioVersion: z.number().int().positive(),
  suite: z.enum(['focused', 'discovery', 'workflow']),
  classification: z.enum(['capability', 'regression']),
  repetitions: z.number().int().positive(),
  concurrency: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  execution: z.record(z.string(), z.unknown()),
  workflowTurns: z.array(workflowTurnSchema).optional(),
  basis: z.object({
    requestSha256: z.string(),
    evidenceSha256: z.string(),
    criteriaSha256: z.string(),
    suite: z.string(),
    classification: z.string(),
    repetitions: z.number().int(),
    executionSha256: z.string(),
  }).strict(),
  arms: z.array(armSchema).min(1),
  trials: z.array(trialSchema),
}).strict();

export type CampaignManifest = z.infer<typeof campaignManifestSchema>;

function actorPrompt(base: string, snapshot: GuidanceSnapshot): string {
  const marker = '\n## Current skill and declared references\n';
  const boundary = base.indexOf(marker);
  if (boundary < 0) throw new Error('Scenario renderer did not expose its guidance boundary.');
  const material = [snapshot.skillMarkdown, ...Object.entries(snapshot.references).map(([name, text]) => `\n\n## Reference: ${name}\n\n${text}`)].join('');
  return `${base.slice(0, boundary)}${marker}${material}`;
}

function discoveryPrompt(base: string, ownerSkill: string, description: string): string {
  const marker = '\n## User request\n';
  const boundary = base.indexOf(marker);
  if (boundary < 0) throw new Error('Scenario renderer did not expose its request boundary.');
  const candidates = loadScenarioCatalog()
    .map((scenario) => scenario.ownerSkill)
    .filter((skill, index, all) => all.indexOf(skill) === index)
    .map((skill) => ({ name: skill, description: skill === ownerSkill ? description : readDescription(skill) }));
  const intro = 'Select which available skill, if any, should guide this request. Return the selected skill name or none and explain the trigger. Do not use skill bodies or references in this discovery trial.';
  return `${intro}\n\n## Available skills\n${JSON.stringify(candidates, null, 2)}${base.slice(boundary)}`;
}

function readDescription(skill: string): string {
  const markdown = readFileSync(path.resolve('skills', skill, 'SKILL.md'), 'utf8');
  const description = /^description:\s*(.+)$/m.exec(markdown)?.[1]?.trim();
  if (!description) throw new Error(`Skill description is missing for ${skill}.`);
  return description;
}

function freezeSnapshot(output: string, armId: string, snapshot: GuidanceSnapshot): void {
  const snapshotRoot = path.join(output, 'snapshots', armId);
  mkdirSync(path.join(snapshotRoot, 'references'), { recursive: true });
  writeFileSync(path.join(snapshotRoot, 'SKILL.md'), snapshot.skillMarkdown, { flag: 'wx' });
  for (const [name, text] of Object.entries(snapshot.references)) {
    const target = path.join(snapshotRoot, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text, { flag: 'wx' });
  }
}

export function prepareCampaign(configInput: CampaignConfig, outputRootInput: string): CampaignManifest {
  const config = campaignConfigSchema.parse(configInput);
  const outputRoot = path.resolve(outputRootInput);
  const scenario = loadScenarioCatalog().find((item) => item.id === config.scenarioId);
  if (!scenario) throw new Error(`Unknown skill scenario: ${config.scenarioId}`);
  const evaluator = loadEvaluatorCatalog().find((item) => item.scenarioId === config.scenarioId);
  if (!evaluator || evaluator.version !== scenario.version) throw new Error(`Scenario evaluator is missing or stale: ${config.scenarioId}`);
  const rendered = renderActorPrompt(config.scenarioId);
  const control = renderControlPrompt(config.scenarioId).prompt;
  const snapshots = config.arms.map((arm) => ({
    arm,
    snapshot: arm.guidanceRoot ? readGuidanceSnapshot(arm.guidanceRoot, arm.referencePaths) : undefined,
  }));
  const arms = snapshots.map(({ arm, snapshot }) => {
    const prompt = snapshot ? actorPrompt(rendered, snapshot) : control;
    const discovery = discoveryPrompt(control, scenario.ownerSkill, snapshot?.description ?? readDescription(scenario.ownerSkill));
    return {
      id: arm.id,
      skillReferenceHashes: snapshot?.hashes ?? {},
      actorPrompt: prompt,
      actorPromptSha256: sha256(prompt),
      discoveryPrompt: discovery,
      discoveryPromptSha256: sha256(discovery),
    };
  });
  const manifest: CampaignManifest = campaignManifestSchema.parse({
    schemaVersion: 1,
    campaignId: config.id,
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    suite: config.suite,
    classification: config.classification,
    repetitions: config.repetitions,
    concurrency: config.concurrency,
    timeoutMs: config.timeoutMs,
    execution: config.execution,
    ...(config.workflowTurns ? { workflowTurns: config.workflowTurns } : {}),
    basis: {
      requestSha256: sha256(scenario.userRequest),
      evidenceSha256: sha256(stableJson({ controlledEvidence: scenario.controlledEvidence, workflowTurns: config.workflowTurns ?? null })),
      criteriaSha256: sha256(stableJson(evaluator.criteria)),
      suite: config.suite,
      classification: config.classification,
      repetitions: config.repetitions,
      executionSha256: sha256(stableJson(config.execution)),
    },
    arms,
    trials: snapshots.flatMap(({ arm }) => Array.from({ length: config.repetitions }, (_, index) => {
      const trialId = `${scenario.id}@v${scenario.version}:${arm.id}:${String(index + 1).padStart(3, '0')}`;
      return { trialId, armId: arm.id, repetition: index + 1, attempts: [`${trialId}:attempt-001`] };
    })),
  });

  if (readFileCollision(outputRoot)) throw new Error(`Campaign output already exists; refusing to overwrite it: ${outputRoot}`);
  const parent = path.dirname(outputRoot);
  mkdirSync(parent, { recursive: true });
  const staging = path.join(parent, `.${path.basename(outputRoot)}-${randomUUID()}.preparing`);
  try {
    mkdirSync(staging, { recursive: false });
    for (const { arm, snapshot } of snapshots) if (snapshot) freezeSnapshot(staging, arm.id, snapshot);
    writeFileSync(path.join(staging, 'campaign.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    renameSync(staging, outputRoot);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return manifest;
}

function readFileCollision(outputRoot: string): boolean {
  return existsSync(outputRoot);
}

export function assertComparableManifests(baseline: CampaignManifest, candidate: CampaignManifest): void {
  const differences = Object.entries(baseline.basis).filter(([key, value]) => candidate.basis[key as keyof CampaignManifest['basis']] !== value).map(([key]) => key);
  if (baseline.scenarioId !== candidate.scenarioId || baseline.scenarioVersion !== candidate.scenarioVersion) differences.push('scenario identity');
  if (differences.length > 0) throw new Error(`Campaigns do not share fixed comparison inputs: ${[...new Set(differences)].join(', ')}`);
}
