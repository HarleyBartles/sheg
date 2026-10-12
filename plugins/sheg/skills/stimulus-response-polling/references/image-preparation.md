# Prepare an image for later study design

Use these tools only to validate, preserve, scale, or inspect static image assets. Image operations are local. They do not call a provider, describe pixels, answer a study question, or make visual respondent studies available through the current `run_*` tools.

Keep the original image. For a local file, calculate its SHA-256 digest and call `image_import` with the absolute path and digest. For CLI JSON requests, a relative file path resolves from the request file's directory; MCP requires an absolute path. Retain the returned `assetId` as the stable reference to the exact stored bytes.

Call `image_scale` only when a smaller image is useful for inspection or for a later supported inference request. Supply `maxWidth`, `maxHeight`, or `maxBytes`, and use the returned candidate `assetId`. Scaling keeps the whole image, format, and proportions. It does not crop, enlarge, change quality, or guarantee that typography or other fine details remain readable. `maxBytes` constrains only the encoded image file; it says nothing about full-request context fit.

Call `image_get` without `export` to read metadata only. Set `export: true` when the user or your inspection requires a local preview. Inspect the returned path and confirm that the visual distinctions relevant to the user's question survive at the prepared size. If they do not, retain the original and choose a larger candidate.

The agent remains responsible for the image description and the study question. This preparation flow does not create alt text or store a semantic description. A future visual study must deliberately pair its image reference with an agent-authored description and inspect the complete inference packet. Do not claim that a saved or exported image has been shown to respondents, or pass its `assetId` to a `run_*` tool as if those tools accepted images.

Import and scaling store immutable source/candidate bytes and their derivation in the shared Sheg datastore. A missing or moved source file does not invalidate an imported asset. If image preparation reports datastore recovery is required, inspect `run_storage`; do not switch roots or manipulate database files to get around that state.
