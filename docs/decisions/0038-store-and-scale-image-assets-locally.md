# ADR-0038: Store and scale image assets locally

- Status: Accepted
- Date: 2026-10-12
- Supersedes: None

## Context

Future visual studies need stable image identities across MCP connections, CLI operations, and later study runs. A file path alone is mutable and may disappear; sending an image to a model is a separate operation with provider-specific capability and context constraints. Authors and agents also need to inspect any scaled image before deciding whether its reduced detail is acceptable.

## Options considered

- Keep only source file paths and scale temporary copies. This avoids datastore changes, but cannot reliably retrieve exact bytes after a source moves or changes and does not preserve derivation history.
- Store exact source and candidate bytes in Sheg's shared datastore with digest identities and explicit derivation. This adds migration and local storage responsibility while making references durable across entrypoints and source-file removal.
- Send source images directly to a provider and treat its request handling as custody. This couples persistence to provider execution, prevents provider-independent preparation, and provides no local preview boundary.

## Decision

Store exact validated static image bytes in the shared Sheg SQLite datastore. Identify each asset by its SHA-256 digest. Persist source, candidate, and scaling derivation atomically after image processing succeeds. Import requires an expected digest for a file source; saved references read bytes from Sheg custody rather than rereading provenance paths.

Image preparation is a local, provider-independent operation. It supports static PNG, JPEG, and WebP within the documented size and pixel bounds. Scaling preserves the whole image, format, and aspect ratio, never enlarges, and exposes no crop or quality control. `maxBytes` is an encoded image target only; it does not promise full inference context fit. Export is explicit and writes a digest-named preview beneath the selected Sheg data root, while the database remains authoritative.

## Consequences

Supported released schema upgrades append an image-asset migration and preserve prior run evidence with the existing backup and recovery process. MCP and CLI share image assets through the same data-root resolver. Removing a source file does not invalidate imported bytes. Users and agents must inspect scaled candidates when detail matters. Provider selection, pixel inference, semantic descriptions, multimodal admission, and visual-study contracts remain separate decisions for the visual-studies implementation.
