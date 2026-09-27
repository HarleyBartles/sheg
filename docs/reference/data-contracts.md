# Data contracts

The JSON Schemas shipped in `skills/stimulus-response-polling/assets/` are the consumer-facing contracts and travel with the installed plugin skill:

- [Reader archetype](../../skills/stimulus-response-polling/assets/reader-archetype.schema.json)
- [Reader archetype library](../../skills/stimulus-response-polling/assets/reader-archetype-library.schema.json)
- [Respondent profile](../../skills/stimulus-response-polling/assets/respondent-profile.schema.json)
- [Respondent cohort](../../skills/stimulus-response-polling/assets/respondent-cohort.schema.json)
- [Study manifest](../../skills/stimulus-response-polling/assets/study-manifest.schema.json)

Runtime validators in `src/domain/readers/archetype.ts`, `src/domain/respondents/profile.ts`, and `src/domain/study/manifest.ts` are authoritative for executable validation. Schemas are generated from those definitions with `npm run contracts:build`. Cross-record constraints appear in each schema's `x-validation-rules` and are enforced by runtime validators.
