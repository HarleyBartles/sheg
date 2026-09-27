# Study inputs

The harness accepts a strict version `1.0` JSON manifest and a separate frozen cohort. `poll_check` requires both and verifies every declared source hash.

The manifest contains `study`, `sources`, `items`, `decisions`, `nodes`, `transitions`, `entryNodeId`, and `maxDecisions`. Nodes are `expose`, `decide`, or `terminal`. An expose node names one item. A decide node names one decision. Every offered choice label has exactly one outgoing edge. A terminal node contains its authored outcome label.

The version `2.0` cohort shape is defined by the [frozen cohort JSON Schema](../../../contracts/frozen-cohort.schema.json), with related [reader profile](../../../contracts/reader-profile.schema.json) and [archetype](../../../contracts/reader-archetype.schema.json) contracts. These schemas are the normative file shapes; this guide focuses on study input workflow. See [archetypes and cohorts](archetypes-and-cohorts.md) for authoring and expansion guidance. Cohort order and concrete profile content contribute to the stimulus fingerprint. The manifest shape is documented in the [study manifest JSON Schema](../../../contracts/study-manifest.schema.json).

Only item text reached through expose nodes becomes reader stimulus. Source paths and hashes are integrity evidence. Source documents are not automatically passed to a model.

See the repository's [study manifest reference](../../../docs/reference/study-manifest.md) for complete field definitions and examples.
