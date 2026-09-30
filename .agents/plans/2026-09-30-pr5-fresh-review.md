# PR 5 Fresh Review Loop

**Status:** in-progress
**Scope:** Independently review the current full PR #5 diff after the review-correction commit. Resolve any supported findings and repeat whole-diff review until no further findings are surfaced.

## Guardrails

- Review the complete PR diff against current `origin/main`, including generated bundles and completed planning artifacts.
- Treat review output as findings to verify against current source and accepted design; fix valid defects and document technically incorrect suggestions.
- Keep PR #5 draft. Do not merge or retire the worktree.
- After any correction, regenerate generated outputs, run the repository gate through the tracked staged hook, push, and review the refreshed full diff again.

## Tasks

- [ ] Refresh `origin/main` and PR state, prepare a fresh full-diff review package for the current pushed head, and record exact base/head SHAs.
- [ ] Have an independent reviewer inspect the full diff and report concrete findings with severity and file/line evidence.
- [ ] Verify each finding against current code; add behavior coverage first for valid findings, fix them, regenerate outputs, and update a JIT plan before implementation.
- [ ] Commit and push any repairs, then prepare and review the refreshed full PR diff again.
- [ ] When a fresh independent review reports no findings, confirm the pushed PR head, checks, clean worktree, and mark this plan `completed-awaiting-retirement`.

## Exit criteria

- A fresh independent review of the latest pushed full diff reports no additional findings.
- Every valid finding from each review iteration has a tested correction in the PR.
- PR #5 remains an open Draft PR with the current reviewed commit pushed.
