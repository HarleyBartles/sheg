import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { StudyInputError } from '../domain/study-input-error.js';
import type { StudyManifest } from '../domain/study/study.js';
import { studyManifestSchema } from '../domain/study/study.js';
import { loadCohort, type RespondentCohort } from '../domain/respondents/cohort.js';
import type { RespondentProfile } from '../domain/respondents/profile.js';

export type VerifiedStudySource = { readonly armId: string; readonly path: string; readonly sha256: string };
export type LoadedStudy = {
  readonly manifest: StudyManifest;
  readonly cohort: RespondentCohort;
  readonly respondents: readonly RespondentProfile[];
  readonly sources: readonly VerifiedStudySource[];
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

export async function loadStudy(manifestPath: string, cohortPath: string | undefined, options: { allowMissingCohort?: boolean } = {}): Promise<LoadedStudy> {
  if (!cohortPath && !options.allowMissingCohort) throw new StudyInputError('An explicit frozen cohort is required.');
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
  if (!manifestJson || typeof manifestJson !== 'object' || !('version' in manifestJson) || manifestJson.version !== '2.0') {
    throw new StudyInputError('Only study contract version 2.0 is supported.');
  }
  const parsedManifest = studyManifestSchema.safeParse(manifestJson);
  if (!parsedManifest.success) {
    throw new StudyInputError(`Manifest is invalid: ${parsedManifest.error.issues.map((issue) => issue.message).join(' ')}`, { cause: parsedManifest.error });
  }
  const manifest = parsedManifest.data;
  const sources: VerifiedStudySource[] = [];
  for (const arm of manifest.arms) {
    for (const source of arm.sources) {
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
      sources.push({ armId: arm.id, path: resolvedPath, sha256: actualHash });
    }
  }

  const cohort = cohortPath
    ? loadCohort(await parseJsonFile(path.resolve(cohortPath), 'Frozen respondent cohort'))
    : { archetypes: [], respondents: [] };

  return {
    manifest,
    cohort,
    respondents: cohort.respondents,
    sources,
    manifestDirectory: path.dirname(absoluteManifestPath),
  };
}
