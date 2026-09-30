# PR 5 Review Corrections Plan

**Status:** completed-awaiting-retirement
**Scope:** Resolve all four findings from the independent PR #5 review and verify the complete repository gate.

## Guardrails

- Preserve the completed implementation plans as `completed-awaiting-retirement`; this is a new JIT repair plan.
- Choice agreement reflects selected option identity when task meanings are comparable.
- Preflight must not claim fit when future typed histories are not conservatively bounded.
- Incomplete journey reports retain durable exposure and response path evidence.
- Typed route intervals must be nonempty and exhaustive.

## Tasks

- [x] Add focused behavior tests for choice agreement, conservative typed-history preflight, partial journey event paths, and zero-width exclusive intervals; run each to observe the expected failure.
- [x] Fix Choice agreement to compare selected option IDs while retaining comparability checks.
- [x] Make packet traversal/preflight mark any unbounded future typed response history incomplete or unverified, without suppressing runtime admission checks.
- [x] Reconstruct report event paths for incomplete/failed journeys from durable presentation and decision evidence, including an explicit pending response boundary when a task was presented but no decision was stored.
- [x] Reject zero-width Score/Noul intervals unless the single endpoint is inclusive.
- [x] Run focused behavior tests and the staged `npm run verify` gate; regenerate and commit the runtime bundles.

## Exit criteria

- All four review findings have behavior coverage and are resolved.
- Full verification passes and the current PR head is pushed.
- All four findings are resolved and the correction commit passed the staged repository gate.
