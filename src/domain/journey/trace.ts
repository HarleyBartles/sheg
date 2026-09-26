import type { ReaderProfile } from '../readers/profile.js';
import type { StudyManifest } from '../study/manifest.js';
import { JourneyExecutionError, runJourney, type JourneyResult } from './run.js';

export async function traceStudy(
  study: StudyManifest,
  profile: ReaderProfile,
  scriptedChoices: readonly string[],
): Promise<JourneyResult> {
  let choiceIndex = 0;
  const result = await runJourney({
    study,
    profile,
    ask: async (request) => {
      const choice = scriptedChoices[choiceIndex++];
      if (choice === undefined) {
        throw new JourneyExecutionError(`Script ended before decision ${request.question.id}.`);
      }
      return { choice };
    },
  });

  if (choiceIndex < scriptedChoices.length) {
    throw new JourneyExecutionError(`Trace finished with an unused scripted choice at index ${choiceIndex}.`);
  }
  return result;
}
