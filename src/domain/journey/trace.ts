import type { RespondentProfile } from '../respondents/profile.js';
import type { StudyArm } from '../study/arm.js';
import { JourneyExecutionError, runJourney, type JourneyResult } from './run.js';

export async function traceStudy(
  arm: StudyArm,
  profile: RespondentProfile,
  scriptedChoices: readonly string[],
): Promise<JourneyResult> {
  let choiceIndex = 0;
  const result = await runJourney({
    arm,
    profile,
    ask: async (request) => {
      const choice = scriptedChoices[choiceIndex++];
      if (choice === undefined) {
        throw new JourneyExecutionError(`Script ended before task ${request.question.id}.`);
      }
      return { choice };
    },
  });

  if (choiceIndex < scriptedChoices.length) {
    throw new JourneyExecutionError(`Trace finished with an unused scripted choice at index ${choiceIndex}.`);
  }
  return result;
}
