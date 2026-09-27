# Author archetypes and prepare reader cohorts

Use this workflow when the user wants to create a reusable reader archetype, expand archetypes into readers for one poll, combine bundled and custom archetypes, or supply profiles directly.

## The three artifacts

- An **archetype** is a reusable pattern of reader motivation and perspective. It defines what remains true across its readers and the dimensions that may vary.
- A **reader profile** is one concrete participant's starting perspective on the particular study subject. It is shaped by both the archetype and the material being polled.
- A **frozen cohort** is the ordered set of concrete profiles used in a poll. The harness polls these profiles, never archetypes directly.

Use the [data contract assets](../../../contracts/README.md) for the normative shapes and validation constraints: [archetype](../../../contracts/reader-archetype.schema.json), [reader profile](../../../contracts/reader-profile.schema.json), and [frozen cohort](../../../contracts/frozen-cohort.schema.json). The [bundled archetype library](../../../dist/data/reader-archetypes.json) provides reusable starting points and quality examples. Its source is `src/domain/readers/reader-archetypes.json` in this repository.

The plugin ships archetypes, not reader profiles. A user can choose shipped archetypes, provide custom contract-compliant archetypes, mix both, or bypass archetypes and provide concrete profiles directly.

## Write or adapt archetypes

Keep an archetype reusable across studies. Its perspective should describe a meaningful reader purpose, not a presumed reaction to a particular article, chapter, or webpage. State the traits every expansion must preserve, then choose variation dimensions that create distinct behavior, knowledge, motivation, or attention. Avoid demographic shorthand and stereotypes.

Use the contract schema to check the artifact shape and the bundled library as examples of useful lenses. Give custom or adapted archetypes new IDs; do not silently redefine a shipped archetype under its existing ID. If an archetype is used in a poll, include its exact definition in that cohort's snapshot.

## Expand archetypes for one poll

1. Inspect the actual material and study question. Choose the user-approved bundled and/or custom archetypes that probe useful reader perspectives. Do not assume every library entry belongs in every cohort.
2. Ask for or derive an explicit number of profiles per selected archetype. Choose a balanced set of variation values that produce distinct starting perspectives while preserving every archetype invariant.
3. Write each concrete profile against the specific study subject. Describe the reader before they encounter the material. Do not preload the profile with the material's claims, people, events, ending, or expected reaction unless that is credible prior knowledge independent of the material.
4. Put exact snapshots of all used archetypes in the cohort. For each archetype-derived reader, select a declared value for every axis and make the concrete perspective consistent with those choices.
5. Inspect the cohort as a whole for meaningful differences, preserved invariants, and fit with the study question. Freeze it before polling.

The cohort snapshot makes expansion auditable and independent of later library edits. The runner sends only the concrete reader perspective fields to the model. It does not send archetype definitions, variation metadata, study purpose, or content that the reader's graph path has not exposed.

## Supply profiles directly

A user may skip archetypes and author a cohort of concrete reader profiles directly. Follow the [reader profile](../../../contracts/reader-profile.schema.json) and [frozen cohort](../../../contracts/frozen-cohort.schema.json) contracts. Leave `archetypeId` and `variation` out of direct profiles and omit the cohort's top-level `archetypes` array when it is not needed. Keep profiles poll-specific, distinct, and frozen before outcomes are viewed.

After authoring either route, read [study inputs](manifest.md), then call `poll_check` on the exact manifest, cohort, provider configuration, and budgets. Fix validation errors; do not silently rewrite the user's cohort.
