import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { StudyInputError } from './errors.js';
import { loadProfiles, validateCohort, type ReaderProfile } from './profiles.js';

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const sourceSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f\d]{64}$/i),
}).strict();

const manifestSchema = z.object({
  version: z.literal('1.0'),
  entry: z.enum(['article', 'scan']),
  source: sourceSchema,
  title: z.string().trim().min(1),
  promise: z.string().trim().min(1),
  beats: z.array(z.object({ id: identifier, text: z.string().trim().min(1) }).strict()).min(1),
  scanCards: z.array(z.object({
    id: identifier,
    title: z.string().trim().min(1),
    beatId: identifier,
  }).strict()),
  asides: z.array(z.object({
    id: identifier,
    title: z.string().trim().min(1),
    text: z.string().trim().min(1),
    offerAfterBeatId: identifier,
  }).strict()),
  conditions: z.array(z.object({
    id: identifier,
    beatIds: z.array(identifier).min(1),
    asideIds: z.array(identifier),
  }).strict()).min(1),
  maxDecisions: z.number().int().positive(),
}).strict().superRefine((manifest, context) => {
  if (manifest.entry === 'article' && manifest.scanCards.length !== 0) {
    context.addIssue({ code: 'custom', path: ['scanCards'], message: 'Article entry must not define scan cards.' });
  }
  if (manifest.entry === 'scan' && manifest.scanCards.length === 0) {
    context.addIssue({ code: 'custom', path: ['scanCards'], message: 'Scan entry requires at least one visible scan card.' });
  }

  const beatIds = manifest.beats.map((beat) => beat.id);
  const asideIds = manifest.asides.map((aside) => aside.id);
  const cardIds = manifest.scanCards.map((card) => card.id);
  const conditionIds = manifest.conditions.map((condition) => condition.id);
  const allIds = [...beatIds, ...asideIds, ...cardIds, ...conditionIds];
  if (new Set(allIds).size !== allIds.length) {
    context.addIssue({ code: 'custom', path: [], message: 'Manifest IDs must be unique across beats, cards, asides, and conditions.' });
  }

  const beatSet = new Set(beatIds);
  const asideById = new Map(manifest.asides.map((aside) => [aside.id, aside]));
  for (const [index, card] of manifest.scanCards.entries()) {
    if (!beatSet.has(card.beatId)) {
      context.addIssue({ code: 'custom', path: ['scanCards', index, 'beatId'], message: `Scan card points to unknown beat ${card.beatId}.` });
    }
  }
  for (const [index, aside] of manifest.asides.entries()) {
    if (!beatSet.has(aside.offerAfterBeatId)) {
      context.addIssue({ code: 'custom', path: ['asides', index, 'offerAfterBeatId'], message: `Aside must point to an existing beat: ${aside.offerAfterBeatId}.` });
    }
  }

  let minimumDecisionCount = manifest.entry === 'scan' ? 1 : 0;
  for (const [index, condition] of manifest.conditions.entries()) {
    const uniqueBeatIds = new Set(condition.beatIds);
    const uniqueAsideIds = new Set(condition.asideIds);
    if (uniqueBeatIds.size !== condition.beatIds.length || condition.beatIds.some((id) => !beatSet.has(id))) {
      context.addIssue({ code: 'custom', path: ['conditions', index, 'beatIds'], message: 'Condition beat IDs must be unique and refer to existing beats.' });
    }
    const orderedBeats = beatIds.filter((id) => uniqueBeatIds.has(id));
    if (orderedBeats.some((id, beatIndex) => condition.beatIds[beatIndex] !== id)) {
      context.addIssue({ code: 'custom', path: ['conditions', index, 'beatIds'], message: 'Condition beats must follow manifest order.' });
    }
    if (uniqueAsideIds.size !== condition.asideIds.length || condition.asideIds.some((id) => !asideById.has(id))) {
      context.addIssue({ code: 'custom', path: ['conditions', index, 'asideIds'], message: 'Condition aside IDs must be unique and refer to existing asides.' });
    }
    for (const asideId of condition.asideIds) {
      const aside = asideById.get(asideId);
      if (aside && !uniqueBeatIds.has(aside.offerAfterBeatId)) {
        context.addIssue({ code: 'custom', path: ['conditions', index, 'asideIds'], message: `Aside ${asideId} is offered after a beat excluded by this condition.` });
      }
    }
    for (const card of manifest.scanCards) {
      if (!uniqueBeatIds.has(card.beatId)) {
        context.addIssue({ code: 'custom', path: ['conditions', index, 'beatIds'], message: `Scan card ${card.id} targets a beat excluded by this condition.` });
      }
    }
    const requiredDecisions = condition.beatIds.length + condition.asideIds.length * 2 + (manifest.entry === 'scan' ? 1 : 0);
    minimumDecisionCount = Math.max(minimumDecisionCount, requiredDecisions);
  }
  if (manifest.maxDecisions < minimumDecisionCount) {
    context.addIssue({ code: 'custom', path: ['maxDecisions'], message: `Decision ceiling must allow at least ${minimumDecisionCount} decisions for this route.` });
  }
});

export type StudyManifest = z.infer<typeof manifestSchema>;
export type StudySource = { readonly path: string; readonly sha256: string };
export type Study = {
  readonly manifest: StudyManifest;
  readonly profiles: readonly ReaderProfile[];
  readonly sources: readonly StudySource[];
  readonly manifestDirectory: string;
};

const maximumManifestBytes = 200_000;
const maximumVisibleBytes = 80_000;
const archetypeCatalogueUrl = new URL('../skills/simulated-reader-polling/assets/reader-archetypes.json', import.meta.url);

async function readJson(filePath: string, label: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new StudyInputError(`${label} is missing or unreadable.`, { cause: error });
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch (error) {
    throw new StudyInputError(`${label} must be valid UTF-8 JSON.`, { cause: error });
  }
}

export async function loadStudy(manifestPath: string, cohortPath: string | undefined): Promise<Study> {
  if (!cohortPath) {
    throw new StudyInputError('An explicit frozen reader cohort is required.');
  }

  const resolvedManifestPath = path.resolve(manifestPath);
  const manifestBytes = await readFile(resolvedManifestPath).catch((error: unknown) => {
    throw new StudyInputError('Manifest is missing or unreadable.', { cause: error });
  });
  if (manifestBytes.length === 0 || manifestBytes.length > maximumManifestBytes) {
    throw new StudyInputError('Manifest is empty or exceeds the 200 KB limit.');
  }
  let manifestJson: unknown;
  try {
    const text = manifestBytes.toString('utf8');
    manifestJson = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch (error) {
    throw new StudyInputError('Manifest must be valid UTF-8 JSON.', { cause: error });
  }

  if (!manifestJson || typeof manifestJson !== 'object' ||
      !('version' in manifestJson) || manifestJson.version !== '1.0') {
    throw new StudyInputError('Only manifest version 1.0 is supported.');
  }

  const manifestResult = manifestSchema.safeParse(manifestJson);
  if (!manifestResult.success) {
    throw new StudyInputError(`Manifest is invalid: ${manifestResult.error.issues.map((issue) => issue.message).join(' ')}`, { cause: manifestResult.error });
  }
  const manifest = manifestResult.data;
  const resolvedSourcePath = path.resolve(path.dirname(resolvedManifestPath), manifest.source.path);
  const sourceBytes = await readFile(resolvedSourcePath).catch((error: unknown) => {
    throw new StudyInputError('Referenced source is missing or unreadable.', { cause: error });
  });
  const actualHash = createHash('sha256').update(sourceBytes).digest('hex');
  if (actualHash !== manifest.source.sha256.toLowerCase()) {
    throw new StudyInputError('Referenced source hash does not match the manifest.');
  }

  const visibleText = [
    manifest.title,
    manifest.promise,
    ...manifest.beats.map((beat) => beat.text),
    ...manifest.scanCards.map((card) => card.title),
    ...manifest.asides.flatMap((aside) => [aside.title, aside.text]),
  ].join('');
  if (Buffer.byteLength(visibleText, 'utf8') > maximumVisibleBytes) {
    throw new StudyInputError('Visible study text exceeds the 80 KB limit.');
  }

  const cohortJson = await readJson(path.resolve(cohortPath), 'Frozen cohort');
  const profiles = loadProfiles(cohortJson);
  const catalogueJson = await readJson(fileURLToPath(archetypeCatalogueUrl), 'Bundled archetype catalogue');
  const catalogueResult = z.array(z.object({ id: z.string() }).passthrough()).safeParse(catalogueJson);
  if (!catalogueResult.success) {
    throw new StudyInputError('Bundled archetype catalogue is invalid.', { cause: catalogueResult.error });
  }
  const archetypeIds = new Set(catalogueResult.data.map((archetype) => archetype.id));
  validateCohort(profiles, archetypeIds);

  return {
    manifest,
    profiles,
    sources: [{ path: resolvedSourcePath, sha256: actualHash }],
    manifestDirectory: path.dirname(resolvedManifestPath),
  };
}
