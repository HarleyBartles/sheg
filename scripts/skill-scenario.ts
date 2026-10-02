import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const scenarioSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  version: z.number().int().positive(),
  ownerSkill: z.enum(['study-design', 'stimulus-response-polling']),
  referencePaths: z.array(z.string()),
  userRequest: z.string().min(1),
  controlledEvidence: z.unknown(),
}).strict();

const evaluatorSchema = z.object({
  scenarioId: z.string(),
  version: z.number().int().positive(),
  criteria: z.array(z.object({ id: z.string(), condition: z.string().min(1) }).strict()).min(1),
  prohibitedClaims: z.array(z.string()),
}).strict();

export const actorTraceSchema = z.object({
  scenarioId: z.string(),
  scenarioVersion: z.number().int().positive(),
  actions: z.array(z.object({ tool: z.string(), input: z.record(z.string(), z.unknown()) }).strict()),
  finalResponse: z.string().min(1),
  uncertainties: z.array(z.string()),
}).strict();

export const evaluatorResultSchema = z.object({
  scenarioId: z.string(),
  criterionResults: z.array(z.object({
    criterionId: z.string(),
    result: z.enum(['pass', 'fail', 'uncertain']),
    evidence: z.string().min(1),
  }).strict()),
  notes: z.string(),
}).strict();

export const baselineTraceSchema = z.object({
  scenarioId: z.string(),
  scenarioVersion: z.number().int().positive(),
  trialId: z.string().min(1),
  mode: z.literal('guided'),
  model: z.string().min(1),
  reasoning: z.string().min(1),
  skillReferenceHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  guided: z.object({ actor: actorTraceSchema, evaluator: evaluatorResultSchema }).strict(),
  controls: z.array(z.object({
    mode: z.literal('no-guidance'),
    model: z.string().min(1),
    reasoning: z.string().min(1),
    skillReferenceHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    inputPromptSha256: z.string().regex(/^[a-f0-9]{64}$/),
    actor: z.record(z.string(), z.unknown()),
    evaluator: evaluatorResultSchema,
  }).strict()),
  simulationOnly: z.literal(true),
  toolUseAudit: z.literal('not-captured'),
}).strict();

export type Scenario = z.infer<typeof scenarioSchema>;
export type ActorTrace = z.infer<typeof actorTraceSchema>;

export function assertReferencePathContained(ownerSkill: string, referencePath: string): string {
  const skillRoot = path.resolve(root, 'skills', ownerSkill);
  const referencesRoot = path.resolve(skillRoot, 'references');
  const resolved = path.resolve(skillRoot, referencePath);
  const relative = path.relative(referencesRoot, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Reference path is outside the shipped references tree: ${referencePath}`);
  }
  try {
    const realReferencesRoot = realpathSync(referencesRoot);
    const realResolved = realpathSync(resolved);
    const realRelative = path.relative(realReferencesRoot, realResolved);
    if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      throw new Error(`Reference path resolves outside the shipped references tree: ${referencePath}`);
    }
    if (!statSync(realResolved).isFile()) throw new Error(`Reference path is not a file in the shipped references tree: ${referencePath}`);
    return realResolved;
  } catch (error) {
    if (error instanceof Error && error.message.includes('shipped references tree')) throw error;
    throw new Error(`Scenario reference is missing or unreadable in the shipped references tree: ${referencePath}`, { cause: error });
  }
}

function loadJson<T>(filePath: string, schema: z.ZodType<T>): T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read JSON fixture ${filePath}: ${String(error)}`, { cause: error });
  }
  return z.array(schema).parse(parsed);
}

function loadOwnedCatalog<T>(name: string, schema: z.ZodType<T>): T[] {
  const skills = ['study-design', 'stimulus-response-polling'];
  const records = skills.flatMap((skill) => loadJson(path.join(root, 'skills', skill, 'tests', 'behavior', name), schema));
  return records;
}

export function loadScenarioCatalog(): Scenario[] {
  const scenarios = loadOwnedCatalog('scenarios.json', scenarioSchema);
  const ids = scenarios.map((scenario) => scenario.id);
  if (new Set(ids).size !== ids.length) throw new Error('Scenario IDs must be unique across skill catalogs.');
  for (const scenario of scenarios) {
    if (!['study-design', 'stimulus-response-polling'].includes(scenario.ownerSkill)) throw new Error(`Unknown owner skill for ${scenario.id}`);
    for (const reference of scenario.referencePaths) {
      const resolved = assertReferencePathContained(scenario.ownerSkill, reference);
      readFileSync(resolved);
    }
  }
  return scenarios;
}

export function loadEvaluatorCatalog() {
  const evaluators = loadOwnedCatalog('evaluators.json', evaluatorSchema);
  const scenarios = loadScenarioCatalog();
  const ids = evaluators.map((evaluator) => evaluator.scenarioId);
  if (new Set(ids).size !== ids.length) throw new Error('Each scenario must have exactly one evaluator.');
  if (ids.length !== scenarios.length || scenarios.some((scenario) => !ids.includes(scenario.id))) {
    throw new Error('Evaluator catalog must pair exactly with the scenario catalog.');
  }
  for (const evaluator of evaluators) {
    const scenario = scenarios.find((item) => item.id === evaluator.scenarioId)!;
    if (scenario.version !== evaluator.version) throw new Error(`Version mismatch for evaluator ${evaluator.scenarioId}.`);
    if (new Set(evaluator.criteria.map((criterion) => criterion.id)).size !== evaluator.criteria.length) {
      throw new Error(`Criterion IDs must be unique for ${evaluator.scenarioId}.`);
    }
  }
  return evaluators;
}

function findScenario(id: string): Scenario {
  const scenario = loadScenarioCatalog().find((item) => item.id === id);
  if (!scenario) throw new Error(`Unknown skill scenario: ${id}`);
  return scenario;
}

function readSkillMaterial(scenario: Scenario): string {
  const skillPath = path.join(root, 'skills', scenario.ownerSkill, 'SKILL.md');
  const title = scenario.ownerSkill === 'stimulus-response-polling' ? 'Stimulus-response polling' : 'Study design';
  const refs = scenario.referencePaths.map((reference) => {
    const fullPath = assertReferencePathContained(scenario.ownerSkill, reference);
    return `\n\n## Reference: ${reference}\n\n${readFileSync(fullPath, 'utf8')}`;
  }).join('');
  return `# ${title}\n\n${readFileSync(skillPath, 'utf8')}${refs}`;
}

export function renderActorPrompt(scenarioId: string): string {
  const scenario = findScenario(scenarioId);
  return [
    'You are acting as a Sheg user-facing agent in a controlled skill behavior scenario.',
    'Use the supplied skill and references to respond to the user request. Treat the evidence below as a mock fixture, not a live tool result.',
    'Do not call tools, connectors, inference providers, or external services. If a tool action would help, record it as a proposed action only.',
    'Return only JSON with scenarioId, scenarioVersion, actions (objects with tool and input), finalResponse, and uncertainties.',
    `scenarioId: ${scenario.id}`,
    `scenarioVersion: ${scenario.version}`,
    `\n## User request\n${scenario.userRequest}`,
    `\n## Controlled evidence (mock only)\n${JSON.stringify(scenario.controlledEvidence, null, 2)}`,
    `\n## Current skill and declared references\n${readSkillMaterial(scenario)}`,
  ].join('\n');
}

export function renderControlPrompt(scenarioId: string): { prompt: string; sha256: string } {
  const scenario = findScenario(scenarioId);
  const prompt = [
    'You are acting as a Sheg user-facing agent in a controlled skill behavior scenario without supplied skill guidance. Use only the mock evidence below to respond to the request.',
    'Do not call tools, connectors, inference providers, or external services. If an action would help, describe it in the response rather than executing it.',
    'Return only JSON with scenarioId, scenarioVersion, actions (objects with tool and input), finalResponse, and uncertainties.',
    `scenarioId: ${scenario.id}`,
    `scenarioVersion: ${scenario.version}`,
    `\n## User request\n${scenario.userRequest}`,
    `\n## Controlled evidence (mock only)\n${JSON.stringify(scenario.controlledEvidence, null, 2)}`,
  ].join('\n');
  return { prompt, sha256: createHash('sha256').update(prompt).digest('hex') };
}

export function renderEvaluatorPrompt(
  scenarioId: string,
  actorTrace: unknown,
  options: { controlIndex?: number } = {},
): string {
  const scenario = findScenario(scenarioId);
  let observedActorTrace = actorTrace;
  let traceSelection = 'raw actor output';
  const wrappedTrace = z.object({
    scenarioId: z.string().optional(),
    scenarioVersion: z.number().int().positive().optional(),
    guided: z.object({ actor: z.unknown() }).passthrough().optional(),
    controls: z.array(z.object({ actor: z.unknown() }).passthrough()).optional(),
  }).passthrough().safeParse(actorTrace);
  const wrapperShaped = typeof actorTrace === 'object' && actorTrace !== null &&
    ('guided' in actorTrace || 'controls' in actorTrace);
  if (!wrappedTrace.success && wrapperShaped) {
    throw new Error('Stored trace wrapper is malformed.');
  }
  if (wrappedTrace.success && (wrappedTrace.data.guided || wrappedTrace.data.controls)) {
    if (wrappedTrace.data.scenarioId !== scenario.id) {
      throw new Error(`Stored trace does not match scenario ${scenario.id}.`);
    }
    if (wrappedTrace.data.scenarioVersion !== scenario.version) {
      throw new Error(`Stored trace version ${String(wrappedTrace.data.scenarioVersion)} does not match current version ${scenario.version}.`);
    }
    if (options.controlIndex === undefined && !wrappedTrace.data.guided) {
      throw new Error('Stored trace wrapper has no guided actor.');
    }
  }
  if (options.controlIndex !== undefined) {
    if (!Number.isInteger(options.controlIndex) || options.controlIndex < 1) {
      throw new Error('Control index must be a positive one-based integer.');
    }
    if (!wrappedTrace.success) throw new Error('A control index requires a stored trace wrapper.');
    const control = wrappedTrace.data.controls?.[options.controlIndex - 1];
    if (!control) throw new Error(`Stored trace has no control at index ${options.controlIndex}.`);
    observedActorTrace = control.actor;
    traceSelection = `no-guidance control ${options.controlIndex}`;
  } else if (wrappedTrace.success && wrappedTrace.data.guided) {
    observedActorTrace = wrappedTrace.data.guided.actor;
    traceSelection = 'guided actor';
  }
  const traceIdentity = z.object({
    scenarioId: z.string().optional(),
    scenarioVersion: z.number().int().positive().optional(),
  }).passthrough().safeParse(observedActorTrace);
  if (traceIdentity.success) {
    if (traceIdentity.data.scenarioId !== undefined && traceIdentity.data.scenarioId !== scenario.id) {
      throw new Error(`Actor trace does not match scenario ${scenario.id}.`);
    }
    if (traceIdentity.data.scenarioVersion !== undefined && traceIdentity.data.scenarioVersion !== scenario.version) {
      throw new Error(`Actor trace version ${traceIdentity.data.scenarioVersion} does not match current version ${scenario.version}.`);
    }
  }
  if (!traceIdentity.success && typeof observedActorTrace === 'object' && observedActorTrace !== null) {
    if ('scenarioId' in observedActorTrace) throw new Error('Actor trace scenarioId must be a string when present.');
    if ('scenarioVersion' in observedActorTrace) throw new Error('Actor trace scenarioVersion must be a positive integer when present.');
  }
  const evaluator = loadEvaluatorCatalog().find((item) => item.scenarioId === scenarioId)!;
  return [
    'Evaluate the observed actor trace against the supplied observable criteria. Judge claims and actions from evidence, not phrase matching.',
    'Return only JSON with scenarioId, criterionResults (criterionId, result: pass|fail|uncertain, evidence), and notes. Cite the trace for every criterion.',
    `scenarioId: ${scenario.id}`,
    `trace selection: ${traceSelection}`,
    `\n## User request\n${scenario.userRequest}`,
    `\n## Controlled evidence (mock only)\n${JSON.stringify(scenario.controlledEvidence, null, 2)}`,
    `\n## Private evaluation criteria\n${JSON.stringify(evaluator.criteria, null, 2)}`,
    `\n## Prohibited claims\n${JSON.stringify(evaluator.prohibitedClaims, null, 2)}`,
    `\n## Actor trace (preserve the observed output exactly, including any contract violations)\n${JSON.stringify(observedActorTrace, null, 2)}`,
  ].join('\n');
}

function main(args: string[]): void {
  if (args[0] === '--list') {
    for (const scenario of loadScenarioCatalog()) process.stdout.write(`${scenario.id}\t${scenario.version}\t${scenario.ownerSkill}\n`);
    return;
  }
  if (args[0] === '--actor-prompt' && args[1]) {
    process.stdout.write(`${renderActorPrompt(args[1])}\n`);
    return;
  }
  if (args[0] === '--control-prompt' && args[1]) {
    process.stdout.write(`${JSON.stringify({ scenarioId: args[1], ...renderControlPrompt(args[1]) }, null, 2)}\n`);
    return;
  }
  if (args[0] === '--evaluator-prompt' && args[1] && args[2]) {
    const trace: unknown = JSON.parse(readFileSync(args[2], 'utf8'));
    const controlIndex = args[3] === '--control' && args[4] ? Number(args[4]) : undefined;
    if (args.length > 3 && controlIndex === undefined) throw new Error('Expected --control <one-based-index>.');
    if (args.length > 5) throw new Error('Too many evaluator prompt arguments.');
    process.stdout.write(`${renderEvaluatorPrompt(args[1], trace, controlIndex === undefined ? {} : { controlIndex })}\n`);
    return;
  }
  throw new Error('Usage: npm run skill:scenario -- --list | --actor-prompt <id> | --control-prompt <id> | --evaluator-prompt <id> <trace.json> [--control <one-based-index>]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; }
}
