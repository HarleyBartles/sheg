# ADR-0009: Generalize and group respondent archetypes

- Status: Accepted
- Date: 2026-09-27
- Supersedes: The archetype taxonomy decision in [ADR-0008](0008-model-stimulus-task-respondent-and-matched-arms.md)

## Context

The product models bounded text stimulus, typed tasks, respondents, and responses across domains. The inherited archetypes were written for engineering-focused portfolio articles and used fields such as `arrival_intent` and `desired_payoff`. That vocabulary and emphasis made the archetype family appear specific to readers of technical articles, even though the same respondent concepts should apply to fiction, research papers, documentation, and other text stimuli.

The initial set also contains several useful perspectives with distinct emphases. Keeping them in one undifferentiated library makes discovery harder, while categorizing each archetype as belonging exclusively to one subject domain would prevent useful mixing.

## Decision

Use respondent archetypes as the generalized authoring contract. The shared perspective fields are `intent`, `context`, `desired_outcome`, `engagement_cues`, and `friction_cues`. Keep the variation axes and invariants that guide creation of study-specific respondent profiles.

Store the contract in `src/domain/respondents/archetype.ts`; keep concrete profiles and cohorts in their sibling domain modules. Store the bundled group files in `src/domain/respondents/archetype-groups/` and describe them in `src/domain/respondents/archetype-catalogue.ts`. Group membership supports discovery and is not exclusive: users may mix archetypes from any groups with custom archetypes.

Ship archetypes, not ready-made respondent profiles. The skill teaches authors how to create a contract-compliant archetype and how to expand it into distinct profiles against a particular stimulus and task. Users may also provide a frozen cohort of profiles directly without archetypes.

Name consumer schema assets `respondent-archetype.schema.json` and `respondent-archetype-library.schema.json`. Build distribution from a clean `dist/` and package each semantic group once under `dist/data/respondent-archetypes/`.

## Consequences

- The domain and package surfaces describe respondents; reading remains a supported use case rather than the type taxonomy.
- Existing substantive archetypes remain available while their fields and placement become domain-neutral.
- Catalog grouping improves discovery without constraining study construction or implying a universal subject taxonomy.
- The archetype and library schemas are generated from the runtime contract, making the plugin self-contained for consumers.
- Historical ADRs retain their original context; the current archetype decisions live here.
