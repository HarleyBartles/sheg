# Shared provider and journey rules

**Goal:** Remove concrete configuration and routing drift found in the source audit while preserving provider boundaries and saved journey behavior.

**Architecture:** One normalized provider configuration schema serves admission, preflight and historical decoding. One typed route resolver serves live journey execution and saved-path advancement. Shared System One wire contracts belong in a small provider-owned module; route-specific authentication, retries, usage requirements and diagnostics remain at their provider boundary.

**Spec:** [roadmap.md](roadmap.md). This plan intentionally excludes unmeasured performance rewrites and broad file splitting.

## Constraints

- Preserve all public request and answer contracts, provider identity, authentication ordering, context-fit admission and physical-call accounting.
- Keep historical schema decoding and fingerprint compatibility read-only and byte-preserving.
- Do not combine materially different provider requirements merely to reduce line count.
- Behavior tests should exercise boundary outcomes and wire payloads; avoid source-layout assertions.

## Tasks

- [x] Consolidate the Laya configuration schema and validation used by provider creation, preflight and legacy archive decoding; reject empty precision consistently and preserve Jev default normalization.
- [x] Extract a typed graph-transition resolver used by `runJourney` and `advanceJourney`; preserve exposed-item traversal, decision limits, and saved path identity. Add boundary tests for Choice, Score and Noul routes.
- [x] Consolidate the duplicated System One question/answer wire contracts and question rendering only where the adapters share behavior. Keep native TypeSafe usage requirements, OpenRouter retry/auth behavior, credential timing and public error wording explicit.
- [x] Run focused provider, journey, preflight, archive and worker tests; run typecheck and lint before marking the plan complete.
