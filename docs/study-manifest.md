# Study manifest reference

The standalone manifest is strict JSON with `version: "1.0"`. See the runnable [article fixture](../test/fixtures/article.json), [chapter fixture](../test/fixtures/chapter.json), and companion [frozen cohort](../test/fixtures/cohort.json).

## Fields

- `study`: `title` and `purpose` metadata. Purpose is not included in reader state.
- `sources`: files and SHA-256 hashes used for integrity checks.
- `items`: stable IDs and reader-visible text.
- `decisions`: stable IDs, instructions, and a `criteria` map whose keys are choice labels.
- `nodes`: graph nodes of kind `expose` (`itemId`), `decide` (`decisionId`), or `terminal` (`outcome`).
- `transitions`: one unconditional edge from each expose node and exactly one edge per offered choice from each decision node.
- `entryNodeId`: first graph node.
- `maxDecisions`: hard ceiling that bounds cycles.

Keep IDs unique and references valid. Every node must be reachable. Give every terminal branch an authored outcome; the engine does not infer one. Keep optional items behind explicit graph edges. Run `check` after any source, manifest, or cohort edit because source hashes and the stimulus fingerprint must reflect the exact study being polled.

The frozen cohort has an ordered `readers` list with `id`, `archetypeId`, and `profileText`, plus `admission.rationale` and `admission.frozenAt`. Cohort order is part of the stimulus fingerprint.
