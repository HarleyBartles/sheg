# PR 5 Review Corrections Plan

**Status:** in-progress
**Scope:** Resolve all four findings from the independent PR #5 review, verify the complete repository gate, then request a fresh review of the updated full PR diff.

## Guardrails

- Preserve the completed implementation plans as `completed-awaiting-retirement`; this is a new JIT repair plan.
- Choice agreement reflects selected option identity when task meanings are comparable.
- Preflight must not claim fit when future typed histories are not conservatively bounded.
- Incomplete journey reports retain durable exposure and response path evidence.
- Typed route intervals must be nonempty and exhaustive.

## Tasks

- [ ] Add focused behavior tests for choice agreement, conservative typed-history preflight, partial journey event paths, and zero-width exclusive intervals; run each to observe the expected failure.
- [ ] Fix Choice agreement to compare selected option IDs while retaining comparability checks.
- [ ] Make packet traversal/preflight mark any unbounded future typed response history incomplete or unverified, without suppressing runtime admission checks.
- [ ] Reconstruct report event paths for incomplete/failed journeys from durable presentation and decision evidence, including an explicit pending response boundary when a task was presented but no decision was stored.
- [ ] Reject zero-width Score/Noul intervals unless the single endpoint is inclusive.
- [ ] Run focused tests and `npm run verify`; update this plan's boxes and mark it `completed-awaiting-retirement` after success.
- [ ] Push fixes to PR #5, prepare a fresh full-diff review package, and repeat review/fix/re-review until no findings remain.

## Exit criteria

- All four review findings have behavior coverage and are resolved.
- Full verification passes and the current PR head is pushed.
- A fresh independent review reports no additional findings.
