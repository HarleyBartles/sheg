# Study inputs

The harness accepts a strict version `1.0` JSON manifest and a separate frozen cohort. `poll_check` requires both and verifies every declared source hash.

The manifest contains `study`, `sources`, `items`, `decisions`, `nodes`, `transitions`, `entryNodeId`, and `maxDecisions`. Nodes are `expose`, `decide`, or `terminal`. An expose node names one item. A decide node names one decision. Every offered choice label has exactly one outgoing edge. A terminal node contains its authored outcome label.

The cohort contains an ordered `readers` list with `id`, `archetypeId`, and `profileText`, plus `admission.rationale` and `admission.frozenAt`. Cohort order contributes to the stimulus fingerprint.

Only item text reached through expose nodes becomes reader stimulus. Source paths and hashes are integrity evidence. Source documents are not automatically passed to a model.

See the repository's [study manifest reference](../../../docs/study-manifest.md) for complete field definitions and examples.
