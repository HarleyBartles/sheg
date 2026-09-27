# Data contracts

The JSON Schemas shipped directly in `skills/simulated-reader-polling/assets/` are the consumer-facing contracts. They travel with the skill that teaches agents how to author these files:

- [Reader archetype](../../skills/simulated-reader-polling/assets/reader-archetype.schema.json)
- [Reader archetype library](../../skills/simulated-reader-polling/assets/reader-archetype-library.schema.json)
- [Concrete reader profile](../../skills/simulated-reader-polling/assets/reader-profile.schema.json)
- [Frozen reader cohort](../../skills/simulated-reader-polling/assets/frozen-cohort.schema.json)
- [Study manifest](../../skills/simulated-reader-polling/assets/study-manifest.schema.json)

The runtime validators are the authoritative executable validation in `src/domain/readers/profile.ts` and `src/domain/study/manifest.ts`. The schemas are generated from those Zod definitions with `npm run contracts:build`. Cross-record rules that JSON Schema cannot express are listed in each asset's `x-validation-rules` extension and enforced by the runtime validators.
