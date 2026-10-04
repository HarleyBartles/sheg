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

const workflowTurnSchema = z.object({ user: z.string().min(1), evidence: z.unknown().optional(), expectedTools: z.array(z.string()).default([]), criteria: z.array(z.string().min(1)).default([]) }).strict();
const workflowSetupSchema = z.object({ kind: z.literal('partial-journey-recovery'), version: z.literal(1) }).strict();
const workflowFixtureSchema = z.object({
  id: z.string(), version: z.number().int().positive(), setup: workflowSetupSchema.optional(), turns: z.array(workflowTurnSchema).min(1),
}).strict();

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
  if (config.suite !== 'workflow' && config.workflowTurns) context.addIssue({ code: 'custom', path: ['workflowTurns'], message: 'Scripted turns are only valid for workflow campaigns.' });
  const ids = config.arms.map((arm) => arm.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['arms'], message: 'Campaign arm IDs must be unique.' });
});

export type CampaignConfig = z.input<typeof campaignConfigSchema>;

const trialSchema = z.object({ trialId: z.string(), armId: z.string(), repetition: z.number().int().positive(), attempts: z.array(z.string()) }).strict();
const evaluationBasisSchema = z.object({
  userRequest: z.string(),
  controlledEvidence: z.unknown(),
  criteria: z.array(z.object({ id: z.string(), condition: z.string() }).strict()),
  prohibitedClaims: z.array(z.string()),
}).strict();
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
  workflowSetup: workflowSetupSchema.optional(),
  evaluationBasis: evaluationBasisSchema,
  basis: z.object({
    requestSha256: z.string(),
    evidenceSha256: z.string(),
    criteriaSha256: z.string(),
  suite: z.string(),
  classification: z.string(),
  repetitions: z.number().int(),
  concurrency: z.number().int(),
  timeoutMs: z.number().int(),
  executionSha256: z.string(),
  }).strict(),
  arms: z.array(armSchema).min(1),
  trials: z.array(trialSchema),
}).strict();

export type CampaignManifest = z.infer<typeof campaignManifestSchema>;
export type WorkflowSetup = z.infer<typeof workflowSetupSchema>;

function scenarioWorkflow(scenarioId: string, ownerSkill: string, version: number): z.infer<typeof workflowFixtureSchema> {
  const workflowsRoot = path.resolve('skills', ownerSkill, 'tests', 'behavior', 'workflows');
  const fixturePath = path.resolve(workflowsRoot, `${scenarioId}.json`);
  const relative = path.relative(workflowsRoot, fixturePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Workflow fixture escapes its owning skill: ${scenarioId}`);
  const fixture = workflowFixtureSchema.parse(JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown);
  if (fixture.id !== scenarioId || fixture.version !== version) throw new Error(`Workflow fixture identity or version does not match scenario ${scenarioId}.`);
  return fixture;
}

function workflowEvidenceBasis(controlledEvidence: unknown, workflowTurns: CampaignManifest['workflowTurns'], workflowSetup?: CampaignManifest['workflowSetup']): unknown {
  return { controlledEvidence, workflowTurns: workflowTurns ?? null, ...(workflowSetup ? { workflowSetup } : {}) };
}

const campaignPreparedSchema = z.object({ type: z.literal('campaign-prepared'), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

function actorPrompt(base: string, snapshot: GuidanceSnapshot): string {
  const marker = '\n## Current skill and declared references\n';
  const boundary = base.indexOf(marker);
  if (boundary < 0) throw new Error('Scenario renderer did not expose its guidance boundary.');
  const material = [snapshot.skillMarkdown, ...Object.entries(snapshot.references).map(([name, text]) => `\n\n## Reference: ${name}\n\n${text}`)].join('');
  return `${base.slice(0, boundary)}${marker}${material}`;
}

function discoveryPrompt(base: string, scenarioId: string, scenarioVersion: number, ownerSkill: string, description: string): string {
  const marker = '\n## User request\n';
  const boundary = base.indexOf(marker);
  if (boundary < 0) throw new Error('Scenario renderer did not expose its request boundary.');
  const candidates = loadScenarioCatalog()
    .map((scenario) => scenario.ownerSkill)
    .filter((skill, index, all) => all.indexOf(skill) === index)
    .map((skill) => ({ name: skill, description: skill === ownerSkill ? description : readDescription(skill) }));
  const intro = `Select which available skill, if any, should guide this request. Return only JSON with scenarioId, scenarioVersion, selectedSkill (study-design, stimulus-response-polling, or null), and rationale. Use descriptions only; do not use skill bodies or references. scenarioId: ${scenarioId}; scenarioVersion: ${scenarioVersion}.`;
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
  const workflowFixture = config.suite === 'workflow' && !config.workflowTurns
    ? scenarioWorkflow(scenario.id, scenario.ownerSkill, scenario.version)
    : undefined;
  const workflowTurns = config.workflowTurns ?? workflowFixture?.turns;
  const workflowSetup = workflowFixture?.setup;
  if (config.suite === 'workflow' && !workflowTurns) throw new Error(`Workflow campaign ${scenario.id} requires ordered scripted turns or an owning-skill workflow fixture.`);
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
    const discovery = discoveryPrompt(control, scenario.id, scenario.version, scenario.ownerSkill, snapshot?.description ?? readDescription(scenario.ownerSkill));
    return {
      id: arm.id,
      skillReferenceHashes: snapshot?.hashes ?? {},
      actorPrompt: prompt,
      actorPromptSha256: sha256(prompt),
      discoveryPrompt: discovery,
      discoveryPromptSha256: sha256(discovery),
    };
  });
  const evaluationBasis: CampaignManifest['evaluationBasis'] = {
    userRequest: scenario.userRequest,
    controlledEvidence: scenario.controlledEvidence,
    criteria: [...evaluator.criteria, ...(workflowTurns ? [{ id: 'workflow-tool-checkpoints', condition: workflowTurns.map((turn, index) => `Turn ${index + 1}: use ${turn.expectedTools.join(', ') || 'no Sheg tool'}${turn.criteria.length ? `; ${turn.criteria.join('; ')}` : ''}`).join('\n') }] : [])],
    prohibitedClaims: evaluator.prohibitedClaims,
  };
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
    ...(workflowTurns ? { workflowTurns } : {}),
    ...(workflowSetup ? { workflowSetup } : {}),
    evaluationBasis,
    basis: {
      requestSha256: sha256(scenario.userRequest),
      evidenceSha256: sha256(stableJson(workflowEvidenceBasis(scenario.controlledEvidence, workflowTurns, workflowSetup))),
      criteriaSha256: sha256(stableJson(evaluationBasis.criteria)),
      suite: config.suite,
      classification: config.classification,
      repetitions: config.repetitions,
      concurrency: config.concurrency,
      timeoutMs: config.timeoutMs,
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
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(path.join(staging, 'campaign.json'), manifestText, { flag: 'wx' });
    const prepared = campaignPreparedSchema.parse({ type: 'campaign-prepared', manifestSha256: sha256(manifestText) });
    writeFileSync(path.join(staging, 'attempts.jsonl'), `${JSON.stringify(prepared)}\n`, { flag: 'wx' });
    renameSync(staging, outputRoot);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return manifest;
}

export function readFrozenCampaign(campaignDirectory: string): CampaignManifest {
  const root = path.resolve(campaignDirectory);
  const manifestText = readFileSync(path.join(root, 'campaign.json'), 'utf8');
  const manifest = campaignManifestSchema.parse(JSON.parse(manifestText) as unknown);
  const journal = readFileSync(path.join(root, 'attempts.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
  const prepared = journal[0] ? campaignPreparedSchema.safeParse(JSON.parse(journal[0]) as unknown) : undefined;
  if (!prepared?.success || prepared.data.manifestSha256 !== sha256(manifestText)) throw new Error('Frozen campaign manifest changed after preparation.');
  if (manifest.basis.requestSha256 !== sha256(manifest.evaluationBasis.userRequest) ||
      manifest.basis.evidenceSha256 !== sha256(stableJson(workflowEvidenceBasis(manifest.evaluationBasis.controlledEvidence, manifest.workflowTurns, manifest.workflowSetup))) ||
      manifest.basis.criteriaSha256 !== sha256(stableJson(manifest.evaluationBasis.criteria)) ||
      manifest.basis.executionSha256 !== sha256(stableJson(manifest.execution)) ||
      manifest.basis.suite !== manifest.suite || manifest.basis.classification !== manifest.classification || manifest.basis.repetitions !== manifest.repetitions ||
      manifest.basis.concurrency !== manifest.concurrency || manifest.basis.timeoutMs !== manifest.timeoutMs) {
    throw new Error('Frozen campaign basis does not match its recorded hashes.');
  }
  for (const arm of manifest.arms) {
    if (arm.actorPromptSha256 !== sha256(arm.actorPrompt) || arm.discoveryPromptSha256 !== sha256(arm.discoveryPrompt)) throw new Error(`Frozen prompt hash mismatch for arm ${arm.id}.`);
    const snapshotRoot = path.resolve(root, 'snapshots', arm.id);
    for (const [relative, expected] of Object.entries(arm.skillReferenceHashes)) {
      const target = path.resolve(snapshotRoot, relative);
      const within = path.relative(snapshotRoot, target);
      if (!within || within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) throw new Error(`Frozen snapshot path escapes arm ${arm.id}: ${relative}`);
      if (sha256(readFileSync(target, 'utf8')) !== expected) throw new Error(`Frozen snapshot hash mismatch for arm ${arm.id}: ${relative}`);
    }
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
