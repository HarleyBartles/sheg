import type { RespondentProfile } from '../respondents/profile.js';
import type { DecisionValue } from '../decision/decision.js';
import type { StudyArm } from '../study/arm.js';
import { JourneyExecutionError, runJourney, type JourneyResult } from './run.js';

export async function traceStudy(
  arm: StudyArm,
  profile: RespondentProfile,
  scriptedChoices: readonly string[] | readonly DecisionValue[],
): Promise<JourneyResult> {
  let choiceIndex = 0;
  const result = await runJourney({
    arm,
    profile,
    ask: async (request) => {
      const scripted = scriptedChoices[choiceIndex++];
      if (scripted === undefined) {
        throw new JourneyExecutionError(`Script ended before task ${request.question.id}.`);
      }
      return typeof scripted === 'string' ? { choice: scripted } : scripted;
    },
  });

  if (choiceIndex < scriptedChoices.length) {
    throw new JourneyExecutionError(`Trace finished with an unused scripted choice at index ${choiceIndex}.`);
  }
  return result;
}
