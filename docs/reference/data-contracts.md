# Data contracts

The JSON Schemas shipped in `skills/stimulus-response-polling/assets/` are the consumer-facing contracts and travel with the installed plugin skill:

- [Respondent archetype](../../skills/stimulus-response-polling/assets/respondent-archetype.schema.json)
- [Respondent archetype library](../../skills/stimulus-response-polling/assets/respondent-archetype-library.schema.json)
- [Respondent profile](../../skills/stimulus-response-polling/assets/respondent-profile.schema.json)
- [Respondent cohort](../../skills/stimulus-response-polling/assets/respondent-cohort.schema.json)
- [Study manifest](../../skills/stimulus-response-polling/assets/study-manifest.schema.json)

Runtime validators in `src/domain/respondents/archetype.ts`, `src/domain/respondents/profile.ts`, `src/domain/respondents/cohort.ts`, and the study modules under `src/domain/study/` are authoritative for executable validation. Schemas are generated from those definitions with `npm run contracts:build`. Cross-record constraints appear in each schema's `x-validation-rules` and are enforced by runtime validators. File-backed JSON parsing, source resolution, and hashing live in `src/infrastructure/study-loader.ts`.
