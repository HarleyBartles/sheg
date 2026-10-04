# Plan 6: Native TypeSafe inference and realistic author validation

Status: Approved for execution from the v0.3.0 dogfood roadmap.

## Outcome

The native TypeSafe route passes Sheg's evidence-backed context admission, sends authenticated typed requests through the existing secure credential path, and completes an author study and selected-material follow-up before v0.3.0 ships. Native responses retain served provider/model identity, typed answers, usage and physical-call evidence in durable storage.

## Base and version

- Base branch: `develop` after Plan 5 PR #17, commit `f956b2149fe93e10e098b62eada45345192ef232`.
- Feature target: `develop`.
- Product version for this intentional checkpoint: `0.3.0-dev.8` in `package.json`, both root `package-lock.json` version fields, `plugin.json` and MCP initialization through the package authority.
- Current canonical worktree: `Z:/_agent-worktrees/sheg/codex/v0.3.0-study-guidance`.

## Evidence-backed admission contract

TypeSafe's official model reference currently says Jev 1.13 (`jev-1.13.0`) accepts 64k tokens per request and limits `state` plus the longest question to 32k. The docs say `jev-latest` points to `jev-1.13.0`, and that aliases move when releases ship. The official API schema reports the served model and token usage but does not expose a context-limit field. Sources: [TypeSafe model reference](https://docs.typesafe.ai/models) and [TypeSafe OpenAPI schema](https://api.typesafe.ai/openapi.json), checked 2026-10-04.

For native `jev-latest`, use 32,000 tokens as Sheg's context ceiling for the complete serialized request, including shared state and all questions. This uses the stricter official 32k constraint for the entire request rather than separately measuring only the longest question, and it remains below the published 64k aggregate bound. Apply the existing UTF-8-bytes-divided-by-three estimate and 20% reserve, giving an effective estimated admission limit of 25,600. Keep the existing `tokenCount: estimated` semantics and expose the evidence source/date. This policy is intentionally bounded but cannot promise exact provider-tokenizer equivalence; an actual provider refusal remains a surfaced provider failure. Do not use the OpenRouter model's context metadata or change its policy.

## Files and ownership

- `src/providers/jev/model-metadata.ts` owns route-and-model-specific published context evidence and the native policy ceiling.
- `src/providers/jev.ts` owns actual serialized request measurement and admission before credential retrieval or HTTP dispatch; change it only if tests prove metadata alone cannot express the native policy.
- `test/jev.test.ts` owns estimator boundary, native admission-before-dispatch, native endpoint/auth, typed response, provider/model, usage, attempt-count and safe-failure behavior tests.
- `test/application-preflight.test.ts` owns configured native-route fit and credential-availability projection.
- `test/mcp.test.ts` owns any needed stored-run accounting or durable-recall integration coverage not already present.
- `docs/providers/jev.md` documents the current native fit policy, evidence limits, and behavior when served model identity or fit differs.
- Add one accepted ADR in `docs/decisions/` for the native context-fit contract and update `docs/decisions/README.md` in the same change.
- Update authoritative candidate version files to `0.3.0-dev.8`; regenerate derived `dist/` output with the build, never edit it as source.
- Use transient files and datastore only under `Z:/_agent-scratch/sheg/` for live validation. Do not commit campaign outputs, database copies, reports, receipts, provider responses, or credential material.

## Tasks

## Task 1: Prove native admission from official limits

Add failing tests for native single and batch measurement before changing the implementation. Verify the published source/date, 32,000 context ceiling, 20% reserve, 25,600 effective estimated threshold, exact serialized request coverage, and distinction from OpenRouter metadata. Verify that an oversized native request is refused before Credential Manager reads or HTTP dispatch and reports zero physical attempts. Unknown native model names remain unavailable unless route-specific evidence exists. Add a native preflight case that reports fit for a small request when the credential is available, while missing credentials remain a separate status.

Set `typesafe/jev-latest` metadata from the official evidence. Keep model alias movement explicit in provider documentation and require a fresh official-source check before stable release. Run `npm test -- --test-name-pattern` only if the repository's Node test runner accepts the filter; otherwise run the focused test file directly as `node --import tsx --test test/jev.test.ts test/application-preflight.test.ts`.

## Task 2: Prove native transport and durable evidence

Extend route-specific tests to assert the native endpoint, selected TypeSafe Credential Manager target, bearer-header construction, serialized model/state/questions, typed answers, actual served model identity, usage and one physical attempt per fetch. Add safe authorization/provider failure coverage proving credential and raw response text do not leak. Keep the existing OpenRouter path coverage intact.

If existing tests do not prove stored provider/model identity and physical-call accounting through the application/store boundary, add a focused integration case using an injected deterministic provider. Do not duplicate provider tests in the MCP suite.

## Task 3: Update decision and provider documentation

Document the official limits, checked date, native Sheg estimate/reserve policy, alias movement, admission failure behavior, and the fact that fit is estimated rather than exact. Add an ADR with the chosen contract and update its index. Do not describe the estimate as a guarantee that TypeSafe will accept every request.

## Task 4: Validate the built candidate with TypeSafe and an author follow-up

Confirm `Sheg/Jev/TypeSafe` is available through the secure credential status path without printing, copying, or placing the token in arguments, environment variables, scratch logs, or test output. Inspect Portfolio read-only and select a real article with an author-supplied pull quote and enough distinct paragraphs for a meaningful choice study. Freeze varied respondent profiles appropriate to the author's decision; do not repeat identical inputs as a substitute for coverage.

Build the candidate and start the built MCP server in an isolated transient `SHEG_DATA_DIR`. Submit a native TypeSafe study asking respondents which paragraph best represents the pull quote. Query exact selected-material evidence, then start one follow-on for selecting respondents that reuses their exact selected paragraph with the pull quote under isolated context and asks whether that paragraph expresses the quote on its own. Keep earlier article text and answers out of the isolated packet. Use the actual native route and stored credential for both runs.

Verify both runs complete with typed answers, response model identity, provider route, usage, and attempt records matching actual physical requests. Restart the MCP process against the same transient data root and verify durable recall of requests, answers, selected-material lineage, attempts and status. Verify safe failure reporting through automated unauthorized/malformed-response tests; do not cause unnecessary paid failures. Keep total paid API calls within the authorized initial 500-call budget and request approval before exceeding it. Remove transient database and run outputs after validation.

## Task 5: Set the development checkpoint and complete handoff checks

Set the product version to `0.3.0-dev.8` in the authoritative files, build generated artifacts, and verify extracted/copy-built MCP initialization reports the same product version. Run focused tests, `npm run build`, and `npm run verify`; let the tracked hook run its staged-snapshot gate. Prepare a feature PR into `develop` after all implementation and live acceptance evidence is reviewed. Do not tag or publish a release.

## Acceptance

- Native TypeSafe `run_inspect`/preflight fits an in-policy request and refuses an oversized one before any provider dispatch.
- OpenRouter's existing context-fit metadata and behavior are unchanged.
- The native route uses the selected secure credential, sends to the official native endpoint, validates Choice/Score/Noul answers, and records the returned model and physical usage accurately.
- Automated tests prove fit boundaries, zero-dispatch refusal, authentication destination, typed transport, identity/accounting and safe failures.
- A real native TypeSafe author study and selected-material isolation follow-up complete within the approved budget, and both remain recallable after MCP restart.
- Provider documentation and one indexed ADR explain the actual evidence, policy and estimator limitation.
- All candidate version surfaces align at `0.3.0-dev.8`; generated artifacts are reproducible; the repository gate passes.

## Review focus

Check that the entire serialized native request is measured under the stated stricter bound, no OpenRouter context assumption is reused, and estimate/headroom are represented honestly. Review the real follow-on packet for per-respondent selected material, isolation and pull-quote inclusion, and verify durable provider/model/attempt evidence without credential leakage.
