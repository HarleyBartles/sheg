import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { StudyInputError } from '../errors.js';
import { loadProfiles, type ReaderProfile } from '../readers/profile.js';
import { manifestSchema } from './manifest.js';
import type { StudyManifest } from './manifest.js';

export type StudySource = { readonly path: string; readonly sha256: string };
export type Study = {
  readonly manifest: StudyManifest;
  readonly profiles: readonly ReaderProfile[];
  readonly sources: readonly StudySource[];
  readonly manifestDirectory: string;
};

const maximumManifestBytes = 200_000;

async function parseJsonFile(filePath: string, label: string): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    throw new StudyInputError(`${label} is missing or unreadable.`, { cause: error });
  }
  try {
    const text = bytes.toString('utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch (error) {
    throw new StudyInputError(`${label} must be valid UTF-8 JSON.`, { cause: error });
  }
}

export async function loadStudy(manifestPath: string, cohortPath: string | undefined): Promise<Study> {
  if (!cohortPath) throw new StudyInputError('An explicit frozen cohort is required.');

  const absoluteManifestPath = path.resolve(manifestPath);
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(absoluteManifestPath);
  } catch (error) {
    throw new StudyInputError('Manifest is missing or unreadable.', { cause: error });
  }
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
  if (!manifestJson || typeof manifestJson !== 'object' || !('version' in manifestJson) || manifestJson.version !== '1.0') {
    throw new StudyInputError('Only manifest version 1.0 is supported.');
  }
  const parsedManifest = manifestSchema.safeParse(manifestJson);
  if (!parsedManifest.success) {
    throw new StudyInputError(`Manifest is invalid: ${parsedManifest.error.issues.map((issue) => issue.message).join(' ')}`, { cause: parsedManifest.error });
  }
  const manifest = parsedManifest.data;
  const sources: StudySource[] = [];
  for (const source of manifest.sources) {
    const resolvedPath = path.resolve(path.dirname(absoluteManifestPath), source.path);
    let sourceBytes: Buffer;
    try {
      sourceBytes = await readFile(resolvedPath);
    } catch (error) {
      throw new StudyInputError(`Referenced source is missing or unreadable: ${source.path}.`, { cause: error });
    }
    const actualHash = createHash('sha256').update(sourceBytes).digest('hex');
    if (actualHash !== source.sha256.toLowerCase()) {
      throw new StudyInputError(`Referenced source hash does not match: ${source.path}.`);
    }
    sources.push({ path: resolvedPath, sha256: actualHash });
  }

  const cohortJson = await parseJsonFile(path.resolve(cohortPath), 'Frozen cohort');
  const profiles: readonly ReaderProfile[] = loadProfiles(cohortJson);

  return {
    manifest,
    profiles,
    sources,
    manifestDirectory: path.dirname(absoluteManifestPath),
  };
}
