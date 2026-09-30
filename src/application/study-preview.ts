import { loadStudy } from '../infrastructure/study-loader.js';
import { previewStudyJourney } from '../domain/journey/preview.js';

export async function previewStudy(manifestPath: string) {
  const study = await loadStudy(manifestPath, undefined, { allowMissingCohort: true });
  return previewStudyJourney(study.manifest.arms);
}
