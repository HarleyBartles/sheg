# Data contracts

These JSON Schema files are the published, machine-readable contracts for files authored or consumed by the plugin. Skills and documentation explain workflows and link here; they do not redefine these shapes.

The authoritative runtime validators are the Zod schemas in `src/domain/readers/profile.ts` and `src/domain/study/manifest.ts`. Regenerate the contract assets after changing those schemas with `npm run contracts:build`.

JSON Schema covers structural constraints. Rules that depend on relationships between records are listed in each schema's `x-validation-rules` extension and enforced by the runtime Zod validator. A file must pass both the published schema and the plugin's runtime validation before use.

- [Reader archetype](reader-archetype.schema.json)
- [Concrete reader profile](reader-profile.schema.json)
- [Frozen reader cohort](frozen-cohort.schema.json)
- [Study manifest](study-manifest.schema.json)
