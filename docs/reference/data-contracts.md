# Data contracts

The JSON Schemas shipped in `skills/stimulus-response-polling/assets/` are the consumer-facing contracts and travel with the installed plugin skill:

- [Respondent archetype](../../skills/stimulus-response-polling/assets/respondent-archetype.schema.json)
- [Respondent archetype library](../../skills/stimulus-response-polling/assets/respondent-archetype-library.schema.json)
- [Respondent profile](../../skills/stimulus-response-polling/assets/respondent-profile.schema.json)
- [Respondent cohort](../../skills/stimulus-response-polling/assets/respondent-cohort.schema.json)
- [Study manifest](../../skills/stimulus-response-polling/assets/study-manifest.schema.json)

The library schema references the standalone archetype schema by its `$id`. The cohort schema references the archetype-library and respondent-profile schemas. Consumers validating these contracts should load the referenced schema files into their validator; the URIs are identifiers and do not imply HTTP fetches.

Runtime validators in `src/domain/respondents/archetype.ts`, `src/domain/respondents/profile.ts`, `src/domain/respondents/cohort.ts`, and the study modules under `src/domain/study/` are authoritative for executable validation. Schemas are generated from those definitions with `npm run contracts:build`. Cross-record constraints appear in each schema's `x-validation-rules` and are enforced by runtime validators. File-backed JSON parsing, source resolution, and hashing live in `src/infrastructure/study-loader.ts`.

Standard JSON Schema validation alone does not enforce `x-validation-rules`. In particular, a profile can satisfy each field's 500-character limit while exceeding the combined 1,500-character prose limit. Call `poll_check` on the cohort before running a study.
