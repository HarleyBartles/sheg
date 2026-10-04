# Contract correctness implementation plan

> **For agentic workers:** Use executing-plans to implement this plan sequentially, with focused behavior verification and a fresh whole-branch review at final PR completion.

**Goal:** Make evidence summaries authoritative, preserve safe provider failure reasons, and normalize shared typed-answer contracts before unifying entrypoints.

**Architecture:** Domain contracts own typed answer projection and safe provider failure evidence. Cursor inputs select stored evidence positions; they cannot supply authoritative counts. Existing durable settlement remains atomic and persisted historical bytes remain untouched.

**Tech Stack:** Node 24, TypeScript, Zod, SQLite, node:test.

**Spec:** [roadmap.md](roadmap.md), including the approved source audit and invariants.

**Execution Strategy:** executing-plans, Native inline execution.

## Global constraints

Preserve request compatibility, migration paths, original compiler fingerprints, existing answer bytes and physical-call charging. Never retain raw provider bodies or credentials as diagnostics. Tests exercise meaningful missing behavior. No paid inference, release branch changes or tags.

## Review focus

- Modified evidence cursors cannot invent query totals or selected-material coverage; valid pagination retains accurate totals.
- Zero-attempt context refusal retains safe fit reason/measurements and incurs zero calls.
- Transport/HTTP run-wide failures retain safe diagnostics and stop further scheduling.
- Normalized typed answers preserve all authored answer fields and strip execution fields deliberately.
- Choice answer keys must identify an own offered option, including adversarial inherited names.

### Task 1: Own typed answer and validation contracts

**Files:** src/domain/decision/decision.ts, src/domain/decision/validate.ts, src/domain/study/task.ts; projection consumers in question-worker.ts, run-inspection.ts, providers/jev.ts and reports.ts. Supporting tests: test/decision.test.ts, test/stimulus-response.test.ts.

**Interfaces:** Export decisionValueFromResult(result: DecisionResult): DecisionValue. DecisionError carries a stable DecisionFailureReason; validation maps reasons without parsing prose. One providerExecutionEvidenceSchema defines result metadata and batch execution.

- [x] Add a task-schema behavior case rejecting inherited answerKeyOptionId names while accepting offered own keys. Add validation cases showing invalid type, unknown option, distribution and rubric failures retain the expected machine reason independent of message wording.
- [x] Run node --import tsx --test test/decision.test.ts test/stimulus-response.test.ts and witness the missing behavior.
- [x] Implement own-key validation, shared result metadata/projection and construction-time validation reasons; replace duplicated projections without changing serialized answers.
- [x] Run the focused checks and npm run typecheck; inspect the diff and commit the completed task.

### Task 2: Preserve safe provider failures

**Files:** src/domain/decision/provider.ts (or a cohesive sibling failure contract), src/providers/jev.ts, src/providers/laya.ts, src/application/question-worker.ts, src/domain/run/request.ts and lifecycle.ts as necessary for evidence validation. Supporting tests: test/question-worker.test.ts, test/jev.test.ts, test/laya.test.ts.

**Interfaces:** A domain-owned provider error/failure contract carries attempts, scope, safe category and optional context-fit evidence. Existing public provider error exports remain compatible wrappers if callers depend on them. Application code handles the shared contract instead of concrete adapter classes.

- [x] Add an execution behavior case for zero-attempt known context overflow, checking recalled answer/attempt diagnostics and unchanged call use. Add a safe HTTP authentication case that stops subsequent respondents and never exposes provider payloads.
- [x] Run node --import tsx --test test/question-worker.test.ts and witness the missing diagnostics.
- [x] Implement typed provider failure evidence at the actual throw boundaries; extend persisted failure validation with optional fields without rewriting historical records or enlarging migration scope.
- [x] Run node --import tsx --test test/question-worker.test.ts test/jev.test.ts test/laya.test.ts and npm run typecheck; inspect and commit.

### Task 3: Make evidence pagination authoritative

**Files:** src/infrastructure/run-store.ts and the evidence cursor/query contract. Supporting tests: test/run-store.test.ts.

**Interfaces:** Public RunEvidencePage fields remain unchanged. A cursor supplies position and verified source revision, not trusted summaries. Historical unsigned cursors may be rejected with the existing invalid-cursor contract rather than believed.

- [ ] Add a settled mapped Choice pagination case that alters totals/material coverage in a returned cursor, and verifies refusal or database-derived accurate counts. Include valid pagination and an unlinked no-fit answer to prove counts use real selected materials.
- [ ] Run node --import tsx --test test/run-store.test.ts and witness the false totals before correction.
- [ ] Derive summaries from stored evidence or protect a server-authored snapshot using an explicit integrity mechanism; keep query/source binding and revision checks intact.
- [ ] Run node --import tsx --test test/run-store.test.ts test/run-service.test.ts test/mcp.test.ts and npm run typecheck; inspect and commit.

### Completion

- [ ] Run npm run verify after regenerating canonical contract/package outputs affected by schema changes. Update the live roadmap and write Plan 2 against the delivered seams. Keep results off-repository; Git and the PR carry publication history.
