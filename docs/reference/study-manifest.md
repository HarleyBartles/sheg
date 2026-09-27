# Study manifest reference

The standalone manifest is strict JSON with `version: "1.0"`. See the runnable [article fixture](../../test/fixtures/article.json), [chapter fixture](../../test/fixtures/chapter.json), and companion [frozen cohort](../../test/fixtures/cohort.json).

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

The version `2.0` frozen cohort has an ordered `readers` list, concrete perspective fields, and an admission record. Its normative shape is the [frozen cohort JSON Schema](../../contracts/frozen-cohort.schema.json), with the related [reader profile](../../contracts/reader-profile.schema.json) and [archetype](../../contracts/reader-archetype.schema.json) contracts. Cohort order and concrete profile content are part of the stimulus fingerprint. The Codex skill's [archetype and cohort guide](../../skills/simulated-reader-polling/references/archetypes-and-cohorts.md) teaches authoring, expansion, and direct-profile workflows.
