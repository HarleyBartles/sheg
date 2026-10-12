# Clef Visual Polling and Compact History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run explicitly configured native Cloudflare Clef polls and sequential journeys over transactionally frozen image assets, then carry supplied visual descriptions and typed outcomes forward without resending pixels.

**Architecture:** Extend the existing typed material and packet path, with image bytes resolved from Plan 1 custody and copied into accepted run snapshots transactionally. Add a distinct Clef provider/configuration, Cloudflare credential target, wire compiler, conservative admission policy, and response decoder; preserve shared run reservations and lifecycle behavior. Keep automatic provider selection, matched forks, multi-provider runs, and follow-on semantics for later plans.

**Tech Stack:** TypeScript, Zod, Node.js 24, SQLite, Windows Credential Manager, native Cloudflare Workers AI REST, existing MCP/CLI, node:test.

**Spec:** `.agents/specs/2026-10-04-v0.4.0-visual-studies.md`, especially sections 5-8, 10-12; dependency roadmap `.agents/plans/v0.4.0-visual-studies/roadmap.md`.

**Execution Strategy:** `executing-plans` - provider, packet, worker, storage, and journey changes form a strict dependency chain over shared public contracts and one call-accounting boundary. Inline execution preserves schema/compiler context; a fresh whole-branch review supplies independent scrutiny. Parallel implementation would create overlapping changes to the same contracts and migration path.

## Global Constraints

- Preserve released v0.3.0 behavior and append a migration after current schema 10; do not rewrite released migrations or old payloads.
- Require explicit Clef configuration in this slice; do not infer provider selection, silently substitute providers/models, or add post-dispatch fallback.
- Use the native Cloudflare Workers AI account REST route with an allowlisted HTTPS origin, validated account/model selectors, redirects refused, and a separate secure token target.
- Every visual material requires a supplied factual descriptor; show current pixels for the authored visual evaluation, omit the descriptor from its pixel prompt by default, and carry descriptor, exact caption, and exact typed reaction into later stages.
- A one-image context question may refer to image position 0; all-image group questions bind every sent image in material order. Limit each call to 4 images and 64 questions. Reject unsupported encodings, image dimensions, bytes, request body, question schema, and fit before reservation/dispatch.
- Do not silently truncate text, history, criteria, or pixels. Unknown or unverified fit is unavailable. The observed hosted text ceiling was 64,000 input tokens with tail truncation in the probe; use a conservative, documented estimator and headroom below that observed ceiling.
- Keep one declared physical batch as one provider attempt and preserve existing reservation, uncertainty, retry/recovery and per-answer failure semantics.
- Keep pixel bytes out of logs, diagnostics, durable request JSON, report output, and compact history. Persist immutable asset references and exact content digests.
- No live API calls in automated tests, hooks, CI, or normal `npm run verify`; use deterministic local HTTP fixtures for provider contract tests.
- Run the canonical staged-snapshot hook for commits and `npm run verify` before publication; generated contract/plugin output is derived from canonical source.

## Review Focus

- A corrupt, missing, or changed image reference at acceptance cannot produce a partially accepted run or a request using replacement bytes; prove rollback via a deliberate post-asset-insert failure.
- Pixels are resent only when the authored stage explicitly needs them; later text history preserves the supplied descriptor, exact caption, and typed Clef reaction without embedding image data; break the history projection and observe the journey behavior test fail.
- A packet over the conservative text/media/body/schema envelope is refused before provider call reservation and network dispatch; deliberately bypass admission and prove the zero-attempt test fails.
- Clef response identity/type/probability/rubric failures invalidate only affected answers when the envelope is valid, while wrong served-model or malformed execution metadata invalidates the provider execution; mutation proof must distinguish both scopes.
- The copied plugin can make a mocked-image Clef request with no checkout or `node_modules`, and the Windows credential helper accepts only the fixed Clef target; remove the copied transport asset or relax the target allowlist and prove the relevant behavioral test fails.

---

### Task 1: Define visual material and image-bound question contracts

**Files:** Modify `src/domain/study/stimulus.ts`, `src/domain/run/request.ts`, the packet/domain contracts reached by `rg` for `material`, `PromptState`, `DecisionRequest`, and `FrozenEvaluation`; extend focused domain tests such as `test/stimulus-response.test.ts`, `test/decision.test.ts`, and `test/journey.test.ts`.

**Consumes:** Plan 1 `ImageMetadata`/`sha256:<digest>` references and current text `stimulusItemSchema`. **Produces:** a strict text-or-image material union and a packet-level visual binding containing ordered material ID, image asset ID/digest, supplied alt text, optional exact caption, and an explicit pixel-use policy. Text material retains its existing shape and semantics.

- [ ] Add behavior cases showing existing text-only request JSON still parses unchanged; a valid image needs an immutable asset reference and nonblank supplied alt text; incomplete digest pairs, duplicate material IDs, missing references, and a question bound to unknown/non-image material fail at request validation.
- [ ] Add a discriminated visual question binding that distinguishes pixel inspection from described-evidence-only questions and permits a bounded image index for a single-image question; define group binding as an explicit ordered list rather than an implicit all-images default.
- [ ] Run the focused tests to observe the new cases fail for missing schema behavior, then implement one material semantic owner in the domain layer. Do not make an image `src` path or data URL part of an accepted study request.
- [ ] Add packet projection tests proving current pixels are not accompanied by their alt text unless the question explicitly selects described-evidence mode; preserve caption as distinct visible evidence. Deliberately include alt text in the default pixel projection and verify the negative behavior test fails.
- [ ] Run `node --import tsx --test test/stimulus-response.test.ts test/decision.test.ts test/journey.test.ts`; commit the completed contract slice.

### Task 2: Add Cloudflare configuration and separate secure credential custody

**Files:** Modify `src/providers/config.ts`, `src/providers/factory.ts`, `src/infrastructure/credentials/windows.ts`, `src/infrastructure/credentials/windows-credential.ps1`, `test/windows-credentials.test.ts`, and provider-config/readiness tests. The current repository has no credential setup/status/removal CLI or MCP commands, so their public surface is added in Task 7.

**Consumes:** Existing Jev/Laya config and `WindowsCredentialStore` boundary. **Produces:** strict `{ kind: 'clef', accountId, model: 'clef' | 'clef-flash', timeoutMs }` configuration, explicit readiness resolution, and a fixed `Sheg/Clef/Cloudflare` credential route that cannot be redirected into a Jev target.

- [ ] Add schema tests for valid account IDs and the two explicit model selectors, and reject malformed account IDs, selectors, arbitrary endpoint fields, and additional properties.
- [ ] Extend credential routing with a closed union for existing Jev routes plus Cloudflare Clef; preserve current Jev target defaults and behavior. The PowerShell helper must accept only the existing Jev/Test forms and the single exact `Sheg/Clef/Cloudflare` target.
- [ ] Add credential-helper tests for status/read/setup/remove argument routing and injection attempts; prove arbitrary target input is rejected by the helper before any Credential Manager API operation using the fixture harness.
- [ ] Extend readiness tests so missing/malformed/unavailable Clef credentials yield bounded route-specific errors, and a Clef credential can never be requested through a Jev route. Deliberately map the Clef target to a Jev target and verify the isolation test fails. Construct the distinct provider adapter in Task 3 after its transport exists.
- [ ] Run focused config, credential, and readiness tests and commit.

### Task 3: Implement the native Clef wire compiler and conservative admission

**Files:** Create `src/providers/clef/config.ts`, `src/providers/clef/compiler.ts`, `src/providers/clef/fit.ts`, `src/providers/clef/transport.ts`, and `src/providers/clef.ts`; modify provider domain interfaces only where required; create `test/clef-provider.test.ts` and `test/clef-fit.test.ts`.

**Consumes:** Task 1 visual packet contract, Task 2 validated config/credential route, current provider decision/result schemas. **Produces:** a `ClefProvider` implementing the shared decision-provider boundary with Clef-only wire projection, fit evidence, route identity, and response decoding.

- [ ] Capture native endpoint behavior in deterministic HTTP fixtures for `POST /client/v4/accounts/{accountId}/ai/run/@cf/cloudflare/{model}` with the model segment derived from validated config, bearer token from the secure store, `redirect: 'error'`, JSON content type, and bounded timeout. Tests assert URL, body, headers, and secret absence from returned errors without printing the token.
- [ ] Compile text state, ordered `data:image/<format>;base64,...` image inputs, image/question bindings, Noul questions, Choice criteria, and Score rubric legends into the direct REST envelope. Keep the account origin constant and reject redirects, arbitrary URLs, unsupported MIME, and provider/model identity mismatches.
- [ ] Implement admission from the exact same compiled projection used by transport. Enforce 4 images, 64 questions, PNG/JPEG/WebP actual metadata, 4 MiB per image, 16 MP per image, 8 MiB aggregate decoded image bytes, and 13 MiB final JSON body. Count duplicate attachments as transmitted bytes. Ensure the four image and question constraints compose before dispatch.
- [ ] Estimate text/schema/framing tokens from the non-image projection using conservative UTF-8 bytes divided by 3 rounded up, reserve 20 percent headroom, and declare fit unavailable over 51,200 estimated tokens (80 percent of the probe-observed 64,000 truncation plateau). Track image-token allowance separately at 1,027 tokens per image (documented 1,024 patch tokens plus markers), include the media allowance in total, and refuse if total exceeds the same 51,200 conservative budget. Label estimates as estimates; never claim tokenizer measurement.
- [ ] Test just-under/over every bound, multi-image aggregation, image bytes excluded from text estimates but included in final body, exact projection equivalence, and unknown/corrupt asset metadata. Prove the >51,200 case never reaches fetch and has zero attempts; temporarily remove its admission branch and show the test fails.
- [ ] Parse Cloudflare response envelope and validate returned question IDs, answer kinds, selected option IDs, probability ranges and normalized sums, exact rubric legends, Noul range, usage, and served-model identity. A valid execution envelope with one malformed answer preserves valid siblings under existing batch rules; malformed execution identity fails at run scope. Mutation proof must show one sibling survives only because answer validation is question-local.
- [ ] Run focused Clef provider tests and commit.

### Task 4: Freeze image bytes and material evidence in accepted runs

**Files:** Modify run acceptance/application services, `src/application/run-inspection.ts`, packet/compiler owners discovered in Task 1, `src/infrastructure/sqlite` request/context repositories and migration registry, `src/infrastructure/run-store.ts`, build migration copying, and relevant inspection/storage/migration tests. Add the next sequential migration after schema 10.

**Consumes:** Validated visual materials and `ImageAssetRepository` from Plan 1. **Produces:** transactionally accepted run snapshots binding each image material to immutable stored bytes and digest, with inspection exposing logical bindings and byte counts but never raw bytes.

- [ ] Add acceptance tests that import and accept an image-backed poll, then modify/delete the source and confirm the stored accepted packet resolves to the exact originally accepted bytes and digest.
- [ ] Add journey acceptance tests for an image at an ordinary step, ensuring only that step's evaluation snapshot includes pixel bytes while prior and subsequent steps retain their distinct logical history.
- [ ] Extend the active schema additively; store only asset references/digests and frozen logical request/projection metadata, relying on existing image asset custody rather than duplicating BLOBs into JSON. Migration must preserve schema-10 stores and all old rows unchanged.
- [ ] Include image repository writes and run/evaluation snapshots within the acceptance transaction boundary. Inject failure after asset lookup/insertion and prove no partial run, dangling asset reference, or leaked accepted snapshot survives rollback. Remove the transaction wrapper temporarily and confirm the rollback behavior test fails.
- [ ] Make inspection show asset digest, item order, supplied descriptor/caption, selected pixel mode, estimated fit basis, and configured Clef identity. Assert no data URL or byte array appears in output, logs, or reports.
- [ ] Run targeted acceptance, journey, migration, backup, storage recovery, and run-inspection tests; rebuild copied migration assets and commit.

### Task 5: Execute Clef polls through shared reservation and answer lifecycle

**Files:** Modify `src/application/question-worker.ts`, shared execution identity/result contracts, run readiness and execution factory wiring, `src/application/preflight.ts`, run acceptance/preflight paths, and tests for workers, decision batches, preflight, and recoverable runs.

**Consumes:** Task 3 `ClefProvider` and Task 4 frozen visual packet. **Produces:** explicit Clef poll execution through the existing reservation/accounting and settlement boundary, with Clef provenance preserved on every evaluation.

- [ ] Add mocked provider-worker tests proving accepted pixel questions call Clef once per declared batch with the exact frozen pixels, while invalid fit fails before `reserveBatch` and before transport.
- [ ] Add a mixed valid/malformed answer fixture proving valid sibling answers settle while failed siblings remain individually retryable; add wrong served-model, missing credentials, HTTP authorization, timeout-after-dispatch, and invalid-envelope cases asserting existing run/evaluation failure scope and attempt accounting.
- [ ] Keep provider identity checks and reservation/retry handling shared at `question-worker`; keep Clef wire decode specific. Do not convert Clef to Jev shapes before typed Sheg validation.
- [ ] Add regression behavior for Jev and Laya text-only calls to ensure the new provider union does not alter their provider/model evidence or text-only request packets. This is compatibility coverage for touched shared paths, not a tautological type assertion.
- [ ] Deliberately bypass the pre-reservation fit path in the worker fixture and confirm the no-attempt/no-fetch assertion fails; restore and run focused worker, decision, run, and preflight tests; commit.

### Task 6: Carry compact visual history through ordinary sequential journeys

**Files:** Modify journey packet walker/topology/trace owners, `src/domain/journey/run.ts`, `src/application/run-inspection.ts`, `src/application/question-worker.ts`, journey persistence codecs and tests.

**Consumes:** Accepted visual material snapshot and provider execution evidence. **Produces:** sequential journeys that show current image pixels only when authored, then carry a structured compact visual record containing material identity, supplied descriptor, exact caption, question identity, and exact typed reaction into subsequent history.

- [ ] Add a journey test with a text stage, a Clef visual stage, and a later text stage. Assert the first packet has no image; the visual packet has exactly its bound current image and no default alt-text leakage; the later packet has no image and includes the supplied description, exact caption, typed answer, provider, model, and encounter ordering.
- [ ] Add explicit pixel-reuse and described-evidence cases. Pixel reuse attaches the same frozen image only when authored; described-evidence uses the supplied descriptor as text and does not claim pixel inspection.
- [ ] Persist the compact visual event distinctly from ordinary text material and typed response so source descriptors are not rewritten from model output. Validate stored events at the persistence boundary and retain old journey row decoding.
- [ ] Add interruption/resume coverage proving a successfully settled visual stage is not replayed and its compact event appears exactly once. Break event persistence/cursor advancement and confirm the test detects duplicate or missing history.
- [ ] Run journey, packet compiler, journey resume/recovery, migration, and storage round-trip tests; commit.

### Task 7: Expose setup, inspection, and run behavior to MCP and CLI

**Files:** Modify `src/mcp`, `src/cli`, runtime composition, public schemas and contract generation inputs; extend `test/mcp.test.ts`, `test/cli.test.ts`, contract tests, and create `docs/providers/clef.md`.

**Consumes:** Accepted Clef polls, visual journeys, secure credential setup and packet evidence. **Produces:** discoverable credential management and usable request/inspection workflows through the same public domain contract for MCP and CLI.

- [ ] Add one CLI and one MCP path for credential status/setup/removal and assert they share the same fixed route and bounded errors; credential values must be prompted/read by the helper and never accepted as ordinary request data.
- [ ] Add end-to-end mocked MCP and CLI workflows: use Plan 1 image import, submit an image poll, inspect the frozen packet/evaluation, and verify source deletion after acceptance cannot affect execution. Preserve relative-path resolution rules and saved asset references.
- [ ] Generate public contracts from canonical schemas; add a consumer guide at `docs/providers/clef.md` for account ID, token permissions, fixed Windows target, supported model selectors, admission envelope, estimation limits, and no-fallback semantics. Link from the provider operations index or existing provider-selection guidance.
- [ ] Prove an unknown arbitrary Clef endpoint cannot be sent through either entrypoint; prove no credential text can be surfaced by inspect/status; run focused CLI/MCP/contract tests and commit.

### Task 8: Ship the native Clef provider in the independent package

**Files:** Modify `scripts/build.ts`, build manifests, package/runtime tests, canonical Sheg skill references under `skills/`, provider guidance link, `.agents/specs`/decision records and index; update `package.json` to the next unique development identity on the 0.4.0 line.

**Consumes:** Working source provider, contracts, storage, CLI/MCP and guide from Tasks 1-7. **Produces:** copied self-contained package that accepts, executes and inspects mocked visual studies without checkout assets or `node_modules`.

- [ ] Write an ADR for native Cloudflare route, separate token custody, explicit provider selection, conservative image/text admission, and compact supplied-description history. Add its index entry; keep it scoped to accepted implementation choices rather than pre-accepting later routing/fork designs.
- [ ] Update the canonical skill with a concrete agent workflow: choose a saved image asset, author/verify factual alt text and exact caption, inspect packet fit, select Clef explicitly for pixel-required questions, choose one-image vs all-image bindings intentionally, and ask the human before changing the article/script excerpt to fit. Explain that a successful response is model evidence, not human cohort research or guaranteed visual truth.
- [ ] Extend `test/package.test.ts` to copy the built plugin into an isolated temp root, use mocked local HTTP and temporary credentials, and perform image import, mocked Clef poll, sequential visual journey, resume/inspection, and source-removal checks without reading checkout files or `node_modules`. Remove the copied provider runtime asset and prove the installed test fails specifically at provider load/dispatch; restore it.
- [ ] Set the unique ordinary-merge dev identity only in root `package.json`, run `npm run contracts:build`, `npm run build`, and `npm run plugin:package -- --validate-only`; inspect generated output and license/asset manifests. Do not edit `plugins/sheg/` as source.
- [ ] Run focused tests, then `npm run verify` before publication. Stage intended source and generated artifacts, inspect the staged diff, and commit through the normal hook. Do not duplicate full CI immediately around a successful hooked commit.
- [ ] Complete a fresh whole-branch review against this plan, the approved spec, source-quality checks, and compatibility contract. Fix every material finding and obtain fresh review of those fixes. Open a feature PR to `develop`, verify head/checks, refresh remote `develop` and the intended version immediately before merge, merge when all gates pass, verify remote merge/tree and attach the PR. Update the roadmap Plan 2 row and implementation cursor based on the delivered merge; proceed to just-in-time Plan 3 only from the refreshed develop base.

## Slice exit

An installed Sheg package can accept a bounded image-backed poll or ordinary sequential journey with an explicitly configured native Clef provider, exact image asset custody, supplied factual descriptions, typed validated answers, conservative no-truncation admission, and durable compact visual history. Every Clef call uses the shared physical-attempt ledger and can be inspected with asset/provider/projection evidence; credentials remain isolated from Jev and outside persisted study data. Existing text-only Jev/Laya flows still work. This slice does not claim automatic provider selection, matched experiments, cohort evidence, pixel-judgment accuracy, article/character recipes, or follow-on visual semantics.
