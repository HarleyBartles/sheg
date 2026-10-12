# Durable Image Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an operating agent a local MCP/CLI operation that preserves an image, creates a scaling-only candidate, and returns exact saved assets and inspectable provenance without an external image utility or inference.

**Architecture:** A focused image-preparation service combines a static-image codec adapter with an immutable SQLite asset repository. Public MCP and CLI operations share schemas and service behavior; expensive image decoding/scaling occurs outside database transactions, while source/candidate/derivation writes are atomic. The existing run system remains text-only in this slice; later plans bind these assets into accepted visual study contexts.

**Tech Stack:** Node.js `>=24 <25`, TypeScript, Zod 4, existing Drizzle/`node:sqlite`, esbuild, `@jsquash/png@3.1.1`, `@jsquash/jpeg@1.6.0`, `@jsquash/webp@1.5.0`, and `@jsquash/resize@2.1.1` with local bundled WASM. These package versions were checked on 2026-10-12; pin exact versions and required license notices, then prove Node/copied-plugin viability in Task 1 before relying on them.

**Spec:** [Approved v0.4.0 visual-studies specification](../../specs/2026-10-04-v0.4.0-visual-studies.md), particularly sections 4, 10 and acceptance criteria 7, 8, 9, 14. [Parent roadmap](roadmap.md) assigns the remaining release scope.

**Execution Strategy:** `executing-plans`, because codec loading, SQLite custody, service composition and installed-runtime behavior share one pipeline and each task consumes the preceding contract. Keep implementation inline with one fresh whole-branch review. The nearest alternative is `subagent-driven-development`; its fresh per-task reviews provide isolation at the cost of repeatedly reconstructing this shared pipeline.

## Global constraints

- Preserve exact imported bytes. A preparation source and its candidate are different assets with distinct digests unless a no-op returns the original.
- Preserve the whole image, aspect ratio and orientation; scale down only. No crop, upscaling, general editing, format-selection interface, quality knob, silent runtime resizing or inference.
- Support static PNG/JPEG/WebP. Reject animation, malformed encodings, unsupported formats and wrong expected digests with actionable bounded errors.
- Use SQLite schema 9 as the released baseline. Append migration 9-to-10 in this slice if it is still the current schema; refresh and reallocate the successor if another integration changed it. Never rewrite `migrations/0000_baseline_v9/`.
- Keep secrets, image payloads and native library internals out of ordinary metadata/error output. Explicit asset export is the bounded exception for returning requested bytes.
- Installed Node.js 24 runtime has no checkout, `node_modules`, external image tool, browser canvas, WASM download or provider dependency.
- Use `.agents/runbooks/implementing.md`, its routed quality/version playbooks and the release guide. First implementation PR proposes `0.4.0-dev.1` if still unique; refresh before merge. This plan-writing commit changes no product identity.
- No arbitrary source-line wrapping, emojis or em dashes. Canonical source/skills own behavior; build generated files explicitly.
- No new test merely checks source shape. For every new behavior test, deliberately break the covered behavior, observe the expected failure, restore, and rerun. Keep mutation runs/results outside shipped source.
- This plan does not authorize paid calls, tags, merging or stable publication. Draft PR publication follows explicit task authority; the executable deliverable and local commits do not depend on a human merge checkbox.

## Review focus

- Static-looking animation or a valid header followed by corrupt content must fail real decoding, not enter custody as a supported image (Task 1).
- Portrait orientation, transparency, four distinct corners and extreme aspect ratios survive scaling without a crop, flip, stretch or background substitution (Tasks 1, 3).
- Digest/source change and a failure between source and candidate writes cannot leave a partially retained derivation; source removal after success cannot break export (Tasks 2, 3).
- A byte target that remains impossible at minimum dimensions produces explicit failure, not an oversized candidate marked fitting; requested dimensions never upscale (Task 3).
- Copied-plugin execution without network or `node_modules` must actually decode and scale, rather than succeed through source/native utilities (Tasks 1, 5).

## Files and interfaces

Create `src/domain/assets/image.ts` for asset/source/scale input and metadata schemas; `src/application/image-assets.ts` for repository/codec ports; `src/application/image-preparation.ts` for shared orchestration; `src/infrastructure/images/{codecs,headers,scale,asset-export}.ts` for real decoding, bounded container/orientation checks, scaling and explicit export; `src/infrastructure/sqlite/image-assets.ts` for the typed repository; `migrations/0001_image_assets/{migration.sql,snapshot.json}` for the reviewed successor. Adapt generated migration filenames to Drizzle's actual output, recording the final path in this plan rather than fabricating a second migration.

Modify `src/infrastructure/sqlite/{tables,schema}.ts`, `src/infrastructure/run-runtime.ts`, `src/entrypoints/{cli,mcp}.ts`, `scripts/{build,generate-contracts,check-generated}.ts` only where their existing build/runtime composition needs the new service/assets. Keep the run repository's public behavior unchanged. Add the asset repository via its existing SQLite context factory; a standalone opening helper can use the same schema runner for Plan 1's preparation connection. Later transactional run acceptance will consume the same repository implementation inside its run transaction, not duplicate asset rules.

Create `test/{image-codecs,image-assets,image-preparation}.test.ts` and purpose-built tiny fixtures under `test/fixtures/images/`. Extend existing SQLite migration, CLI, MCP, build, package and maintenance behavior tests at their owners. Do not add a new test runner. Create `docs/guides/image-preparation.md` and `skills/study-design/references/image-preparation.md`; link the latter from the canonical skill only when the tool is usable. Update generated contracts and plugin output through scripts.

The following public and inter-task types are planning-owned choices, now fixed for this slice:

```ts
type ImageFormat = 'png' | 'jpeg' | 'webp';
type ImageSource = { path: string; sha256: string } | { assetId: string };
type ImageMetadata = {
  assetId: string; sha256: string; format: ImageFormat;
  width: number; height: number; bytes: number;
};
type ScaleRequest = {
  source: ImageSource;
  maxWidth?: number; maxHeight?: number; maxBytes?: number;
};
type PreparedImage = {
  source: ImageMetadata; candidate: ImageMetadata;
  changed: boolean;
  scaling: { width: number; height: number; algorithm: 'lanczos3'; policyVersion: 1 };
  fit: 'image-target-only';
};
type ImageAssetRepository = {
  metadata(assetId: string): ImageMetadata;
  bytes(assetId: string): Uint8Array;
  saveSource(bytes: Uint8Array, metadata: ImageMetadata): ImageMetadata;
  savePrepared(sourceBytes: Uint8Array, source: ImageMetadata,
    candidateBytes: Uint8Array, candidate: ImageMetadata,
    scaling: PreparedImage['scaling']): PreparedImage;
  close(): void;
};
type DecodedImage = {
  data: Uint8ClampedArray; width: number; height: number;
  format: ImageFormat; orientation: number;
};
type StaticImageCodec = {
  decode(bytes: Uint8Array): Promise<DecodedImage>;
  scale(image: DecodedImage, width: number, height: number): Promise<DecodedImage>;
  encode(image: DecodedImage): Promise<Uint8Array>;
};
type ImagePreparationService = {
  import(source: ImageSource): Promise<ImageMetadata>;
  scale(request: ScaleRequest): Promise<PreparedImage>;
  get(assetId: string): ImageMetadata;
  export(assetId: string): Promise<{ asset: ImageMetadata; path: string }>;
  close(): void;
};
```

Asset IDs are lowercase `sha256:<64 hex>` derived from exact stored bytes. `ImageAssetError` exposes one of `image_digest_mismatch`, `image_format_unsupported`, `image_animation_unsupported`, `image_decode_failed`, `image_source_limit`, `image_scale_target_unreachable`, `image_asset_not_found`, `image_codec_unavailable`, `image_export_failed`. Normalized public messages contain no input bytes or arbitrary decoder stack. Preserve `RunStoreError` for datastore migration/recovery failures rather than translating them into image errors.

## Task 1: prove a bundled static-image codec boundary

**Files:** Create domain schemas, codec/header/scale modules and `test/image-codecs.test.ts`; modify exact dependency pins, build asset copying and license inventory. Add no public study fields yet.

**Consumes:** Exact local image bytes and Node.js 24. **Produces:** `StaticImageCodec`, validated `DecodedImage`, `ImageAssetError`, `ImageMetadata`/source/request schemas, and local codec assets usable by a copied ESM bundle.

- [x] Add static, animated, truncated and orientation fixtures with known dimensions and visibly distinct corners, including transparent PNG/WebP. Use generated tiny fixture bytes with a provenance README describing content, not test results. Test real decode and scaling at the codec boundary, including opaque errors for corruption and missing WASM.

```ts
test('scaling retains every corner without a crop or stretch', async () => {
  const source = await codec.decode(await fixture('four-corners.png'));
  const scaled = await codec.scale(source, 40, 20);
  assert.equal(scaled.width, 40);
  assert.equal(scaled.height, 20);
  assertCornerColors(scaled, ['red', 'green', 'blue', 'yellow']);
});
```

`fixture(name)` reads `test/fixtures/images/name`; `assertCornerColors` samples inset pixels and uses a small channel tolerance so interpolation is permitted but cropping/flipping is rejected. Define these helpers in the owning test, not in production. Add tests that decode an encoded candidate and check format, orientation and transparency rather than expecting exact compressed bytes.

- [x] Run `node --import tsx --test test/image-codecs.test.ts` and observe failure before adding the codec. Inspect package exports and WASM paths with `npm view`/installed package contents after installing the pinned packages. Use [jSquash's Node example](https://github.com/jamsinclair/jSquash/blob/main/examples/with-node/index.js) for explicit local WASM initialization and the [resize implementation](https://github.com/jamsinclair/jSquash/blob/main/packages/resize/index.ts) to avoid its cropping path. Do not assume a browser `ImageData` global exists.
- [x] Implement one codec adapter. Compile local WASM from bytes through `WebAssembly.compile`; initialize decode/encode/resize explicitly. Supply the minimal ImageData-compatible object and constructor needed by these packages, avoiding a browser/canvas dependency; if the package invokes a global constructor, install a narrowly scoped Node shim only when that global is absent and test it in a fresh child process. Use Lanczos3 with computed proportional dimensions and the non-cropping path. Load runtime assets from a fixed build-owned manifest relative to the bundle; never fetch or search the user's filesystem for a missing codec.
- [x] Before allocation, inspect PNG/APNG chunks, JPEG dimensions/EXIF orientation, and WebP RIFF/animation flags. Reject malformed/truncated containers and animation. Bound sources to 16 MiB encoded and 16 megapixels; real decoding must agree with header dimensions. Preserve displayed orientation with a deterministic EXIF orientation transform and remove/reset orientation in the scaled encoding so it is not applied twice. Keep original bytes untouched. Encoders preserve format, with fixed internal JPEG/WebP settings and no user quality control; PNG stays lossless. Exported candidate metadata records policy version 1.
- [x] Build an isolated codec entry through esbuild using the same Node/ESM options as `scripts/build.ts`, copy only the needed codec WASM alongside it, and run it in a temp directory with network forbidden, no `node_modules`, and no native image utility on the execution path. Repeat decode/scale/re-encode for all three formats. If the pinned dependency cannot meet this contract, stop this task and report the specific bundled-runtime blocker; do not substitute an external tool or narrow formats silently.
- [x] Deliberately change the scaler to a crop/incorrect aspect ratio and confirm the corner/aspect tests fail; restore. Remove a required WASM asset and confirm the copied-bundle failure test reaches `image_codec_unavailable`; restore. Run focused tests, rebuild intended generated output, and commit normally. The hook owns staged full verification.

## Task 2: append immutable asset custody to the released datastore

**Files:** Modify SQLite tables/schema and build migration copying; create `sqlite/image-assets.ts`, the reviewed successor migration and `test/image-assets.test.ts`; extend migration and maintenance tests without rewriting the baseline.

**Consumes:** Validated byte/digest/metadata contracts from Task 1 and `SqliteRepositoryContext`/`writeTransaction`. **Produces:** `createImageAssetRepository(context)` and `openImageAssetRepository(dataRoot)` implementing `ImageAssetRepository` with exact-byte retrieval and atomic source/candidate derivation.

- [x] Add tests that store and retrieve a valid image, save identical bytes idempotently, reject conflicting metadata for an existing digest, and return `image_asset_not_found` for an unknown reference. Use a temporary data root and the production schema runner. Assert exact returned bytes, not just a table name.
- [x] Declare `image_assets` with digest identity, format, encoded dimensions/size and BLOB bytes; declare `image_derivations` with source/candidate foreign keys and bounded versioned scaling metadata. No captions/descriptors enter byte-asset identity; those belong to study material in Plan 2. A no-op shares the original asset and does not invent a self-derivation. The derivation repository permits only validated source/candidate records, not an arbitrary editing DAG.
- [x] Run `npm run sqlite:schema:generate`, review its additive SQL, register the sequential 9-to-10 migration and schema version, and copy registered migration assets into the built plugin. Preserve the baseline ID, SQL, snapshot and checksum. Update fresh-store shape validation for the successor while retaining source-chain verification. Extend existing migration tests with a real released baseline fixture; existing synthetic-successor tests should target the next version after the new current schema when appropriate, while retaining a genuine released-9 upgrade case.
- [x] Prove the migration preserves a representative poll's request, context, answers, provider-attempt evidence and lineage. Construct the released fixture through the immutable schema-9 baseline migration and its original checksum ledger, not `openRunStore` after it starts creating schema 10. Populate its valid typed rows through existing test fixture helpers or the released contract, then open it through the new production runner. Verify the SQLite-consistent backup is schema 9 and exact source rows remain readable there. Force a successor failure through the existing migration injection seam; assert rollback, intact original schema/data, recoverable backup and no candidate asset. Future schema remains untouched and `run_storage` still reports maintenance/recovery options. Do not add another backup implementation.
- [x] Implement typed reads/writes with shared `ensureOpen` and transaction guards. Decode persisted metadata once at the repository boundary. `savePrepared` inserts source bytes, candidate bytes and derivation in one synchronous transaction after processing completes. Hash incoming bytes at this boundary rather than trusting a caller-supplied digest. No filesystem, WASM processing or provider call occurs inside the write transaction. Expose an inside-transaction helper for later run acceptance only if needed by the repository's implementation; never nest transactions implicitly.
- [x] Inject failure at derivation insertion using a test-side SQLite trigger, then assert neither new source nor candidate remains after rollback. Remove the transaction wrapper deliberately, confirm this test fails through residual rows, restore. Test close/reopen and exact-byte access after the original file is removed. Run `node --import tsx --test test/image-assets.test.ts test/sqlite-migrations.test.ts test/sqlite-schema.test.ts test/mcp-storage-recovery.test.ts`, build and commit through the normal hook.

## Task 3: explicit scaling orchestration and bounded inspection

**Files:** Create application ports/service, `images/asset-export.ts`, and `test/image-preparation.test.ts`. **Consumes:** `StaticImageCodec` and `ImageAssetRepository`. **Produces:** `createImagePreparationService(repository, codec, exportRoot): ImagePreparationService`.

- [x] Validate `ScaleRequest`: at least one positive integer target, no additional keys, no crop/quality/format fields. A file source requires an expected SHA-256; saved references resolve bytes from custody. `maxBytes` is an image-only target, not a model-call promise. Run wrong-digest and corrupt-source cases through the real import/scale path, verifying no repository writes.
- [x] Implement import by reading once, verifying expected digest, checking bounds/real decode, computing metadata, and saving those exact bytes. Recheck the digest of the already-read buffer used for storage; never verify one read then store another. Reference-based import is a bounded saved lookup, not a reread of provenance paths.
- [x] Compute initial dimensions using the display-oriented source, bounds and `factor = min(1, maxWidth/width, maxHeight/height)` for supplied dimension constraints. Round down with a minimum dimension of one and derive the other axis from the same factor. If no smaller dimensions/byte target are needed, return the original as `changed: false` without re-encoding it.
- [x] For a byte target, encode at initial proportional dimensions, inspect actual bytes, then reduce linear scale by a fixed factor of 0.8 until the target is met or neither dimension can decrease. Each attempt scales from the original decoded pixels, never from the preceding lossy candidate. Limit iterations to the finite dimension sequence. Do not reduce JPEG/WebP quality, change format, crop or claim preserved typography. If the smallest candidate cannot meet the target, throw `image_scale_target_unreachable` and retain no new preparation records. Once a candidate meets the requested image constraints, real-decode it and atomically save source/candidate/derivation.

```ts
test('source removal cannot change a saved candidate', async () => {
  const result = await service.scale({ source: sourceFile, maxWidth: 40 });
  const saved = repository.bytes(result.candidate.assetId);
  await unlink(sourceFile.path);
  assert.deepEqual(repository.bytes(result.candidate.assetId), saved);
  assert.equal(service.get(result.source.assetId).sha256, sourceFile.sha256);
});
```

Here `sourceFile` is a verified fixture copied to a temp path, and `service`/`repository` come from Tasks 1-2. Create an impossible one-byte target test and a no-upscale test, not just the happy path. Check orientation and corner content via the real codec after service scaling.

- [x] Export only the requested asset to a deterministic digest-based filename under the runtime's `asset-previews/` directory, using saved bytes and atomic replacement of the tool-owned file. Return absolute path plus metadata. No caller-selected arbitrary destination or base64 appears in metadata. Guard symlink/path escape and validate existing preview bytes before reuse; the database remains authoritative. A source/candidate view is generated only on explicit export, not ordinary status reads.
- [x] Show that bypassing the expected-digest guard fails the no-write test and that returning an oversized candidate fails the impossible-target test. Restore and rerun `node --import tsx --test test/image-preparation.test.ts test/image-assets.test.ts test/image-codecs.test.ts`; commit the working shared service.

## Task 4: expose the shared operation through MCP and CLI

**Files:** Modify runtime composition and CLI/MCP; extend `test/cli.test.ts` and `test/mcp.test.ts`; add preparation schemas to the canonical contract generator.

**Consumes:** `ImagePreparationService` from Task 3. **Produces:** MCP `image_import`, `image_scale`, `image_get` and CLI `image-import`, `image-scale`, `image-get`, all sharing schemas and errors. `image_get` uses `{ assetId, export?: boolean }`, returns bounded metadata by default and a saved preview path when explicitly exported.

- [x] Wire a lazy image-service getter into `createRunRuntime`, retaining existing run-service injection and storage/recovery behavior. It owns and closes its preparation repository connection. Reuse the production data-root resolver so MCP and CLI find the same assets. A datastore startup/migration failure leaves maintenance accessible; preparation reports that failure rather than opening a parallel fresh store. Existing injected run-service tests must not open an accidental image database merely to construct the server.
- [x] Add strict request schemas and JSON contract assets for import, scale and get. `image_import` accepts `{ source }`; `image_scale` accepts `ScaleRequest`; `image_get` accepts its metadata/export request. CLI takes one JSON request file, e.g. `node dist/cli.js image-scale --request request.json --data-root <root>`. Resolve relative file sources against the JSON request file and report the resolved path; MCP requires an absolute path or saved reference. Error parity concerns semantic code/result, not identical stderr envelopes.
- [x] Add public tests that import through one MCP connection, close it, remove the source, scale through another, then inspect/export through CLI from the same data root. Verify candidate bytes and source lineage. Reject crop/quality keys and malformed references without calling the codec or creating a preparation. Reads never scale implicitly. Missing codec and future-schema failures remain bounded/actionable, with recovery available.
- [x] Confirm preparation never invokes the provider factory, credential read or worker launcher using injected spies that throw if reached. Prove the negative test fails by deliberately inserting a launcher/provider call in the shared preparation path, then restore. Run `node --import tsx --test test/cli.test.ts test/mcp.test.ts test/mcp-storage-recovery.test.ts test/image-preparation.test.ts`. Regenerate contracts with `npm run contracts:build`, build, inspect the diff and commit through the hook.

## Task 5: ship preparation guidance and independent installed execution

**Files:** Modify build/generated parity/package tests and license copies; create the human guide and canonical agent reference; generate runtime/plugin output. Add an ADR and decision-index entry for image custody/scaling in the first implementation change that establishes that choice, rather than writing every v0.4 decision prematurely.

**Consumes:** Working shared public operations and migration/codec assets from Tasks 1-4. **Produces:** A copied self-contained plugin that actually imports/scales/exports, and instructions describing supported preparation rather than claiming visual studies already ship.

- [ ] Teach the agent to preserve a source, call the scaler for convenience, export/inspect the candidate, and explicitly select the resulting reference in later visual study designs. State that complete inference fit is separate, smaller images may erase relevant detail, descriptors are supplied by the reasoning agent in Plan 2, and this slice does not add pixel inference. The human guide explains operations, data-root custody, supported formats, bounds and recovery. Link from the existing relevant guide/skill entrypoint, not a new README workflow narrative.
- [ ] Copy each required decoder/encoder/resize WASM and license asset explicitly in `scripts/build.ts`; include successor migrations and contract assets. Extend parity checks to reject missing/extra codec assets without mutating checkout output. Do not edit `plugins/sheg/` as source. Inspect transitive codec license notices, not only npm's top-level Apache label.
- [ ] In `test/package.test.ts`, copy the packaged plugin to an isolated root without checkout or `node_modules`, disable network and native image helpers, then perform real MCP scale and CLI export after source deletion. Launch with `process.execPath`, a minimal PATH, and a test-only Node preload that rejects network fetch; do not disable the local file API needed for WASM. Verify all format fixtures work and the candidate's pixels/dimensions satisfy the input. Missing-WASM and bad-migration packaged cases must fail for those reasons. Show the installed test fails if a required WASM copy is removed and restore it. This is the required reachability proof, not an assertion that filenames exist.
- [ ] Set the currently unique intended development version in root `package.json`, run `npm run contracts:build` and `npm run build`, then `npm run plugin:package -- --validate-only`. Run focused tests and inspect the staged source/generated changes. Use the normal hooked commit; do not run full CI immediately before/after its successful isolated verification unless diagnosing a new issue. `npm run verify` remains the canonical uncommitted/published gate; never bypass the tracked hook.
- [ ] Complete one fresh whole-branch review against the plan and approved spec using the available review capability. Fix material findings, run newly relevant checks and obtain fresh review of those fixes. Commit the completed plan checklist with the delivered changes. If a Draft PR is authorized, publish to `develop`, verify remote head and checks, and attach it to the chat. Otherwise hand off the committed branch for review; never leave user approval/merge as an unfinished implementation checkbox. Preserve the parent roadmap and follow local release/planning custody policy.

## Slice exit

The installed tool can preserve and inspect a static image, create a whole-image proportional candidate and retrieve it after source removal. Its exact source/candidate/derivation survive connection changes and compatible backup/migration. All three formats have actual copied-runtime processing coverage; invalid or animated sources and impossible targets fail without partial writes. Existing text studies, attempts and recovery behave as before. The next plan may consume saved references but must implement its own visual-material acceptance, descriptor/history semantics, provider protocol and hosted admission before making any visual-study claim.
