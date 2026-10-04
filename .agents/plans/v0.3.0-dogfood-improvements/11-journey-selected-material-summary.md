# Count selected journey material in matched query coverage

> **For agentic workers:** execute this plan task-by-task with the approved test-first workflow.

**Goal:** Make matched selected-material coverage count valid Choice answers from journey storage without changing any persisted evidence.

**Base:** `develop` at `716e1971640053162d4dcf2db11e1ec5e568dd59` after PR #22.

**Target:** `0.3.0-dev.13`, authored only in root `package.json`; regenerate derived version surfaces with `npm run build`.

**Bug:** Journey settlement persists full `DecisionResult` objects in `result_json`; grouped polls persist bare typed values. The matched coverage loop currently accepts only `decisionValueSchema`, silently skipping journey Choices even though evidence rows render them correctly through `resultFromStorage`.

**Scope:** Normalize both existing storage forms through the existing storage conversion before matched-coverage counting. Add run-store behavior coverage for mapped journey Choice answers, no-fit exclusion, distinct-material/respondent/evaluation counts, and stable totals across evidence pagination. Do not rewrite stored JSON, run migrations, make paid provider calls, or change row-level selected-material custody.

## Task 1: Retire Plan 10 and update the roadmap in this successor slice

- [x] Verify PR #22 is merged and its merge commit is in current `develop`.
- [x] Retire the completed Plan 10 child artifact, mark Plan 10 merged in the roadmap, remove stale Plan 10 worktree/base details, and make Plan 11 the active JIT plan.
- [x] Preserve the roadmap's unreleased-v0.3.0 requirements and the broader dogfood specification.

## Task 2: Prove journey selected-material coverage behavior

- [x] Add a journey fixture with mapped Choice answers selecting two distinct materials and a no-fit response with no mapping.
- [x] Query by the selected question and assert the row-level selected materials and aggregate evaluations, respondents, and distinct materials.
- [x] Paginate the matching rows and assert each page reports the same full snapshot aggregate, with no-fit excluded.
- [x] Run the focused test first and confirm it fails because journey `result_json` is not normalized by the current summary loop.

## Task 3: Normalize supported stored answer representations

- [x] Replace strict `decisionValueSchema` parsing in matched coverage with the existing `resultFromStorage`, passing stored provider execution when present.
- [x] Preserve both complete journey `DecisionResult` and bare grouped-poll value behavior; leave historical stored bytes untouched.
- [x] Re-run focused tests and the complete `npm run verify` gate.

## Task 4: Set and validate dev.13 package identity

- [x] Change only root `package.json` to `0.3.0-dev.13`, then run `npm run build` to regenerate derived version surfaces.
- [x] Validate `npm run verify`, generated package parity, and `git diff --check` before publication.

## Task 5: Review, publish, and close out

- [ ] Request a fresh review of the complete branch and resolve all actionable findings.
- [ ] Push the reviewed branch and open a PR into `develop`; verify its exact head and hosted `sheg-verify` result.
- [ ] Keep the worktree while the PR is open; retire it only after an authorized merge and verified merge identity.

**Non-goals:** Live reproduction, paid inference, data rewrites, schema changes, release tagging, or GitHub Release publication.
