# Test Suite Value Audit

**Status:** in-progress
**Scope:** Audit the repository's tests in the context of the current PR. Remove tests that are change detectors, tautological, redundant with stronger coverage, or otherwise unable to catch a meaningful regression. Preserve valuable behavioral coverage and avoid expanding the test suite or broad refactoring.

## Decisions

- A test earns its place when it protects a concrete behavior or invariant and can fail for a meaningful regression.
- Prefer one clear owner for each invariant at the cheapest proving layer.
- Do not retain tests solely to preserve implementation shape, test counts, source literals, or file-change detection.
- Distinguish genuine integration/contract checks from exact-string or output-presence checks that only mirror the implementation.

## Tasks

- [ ] Inventory and review test cases across `test/`, including helpers, fixtures, and package-level checks.
- [ ] Remove only tests whose regression-detection value does not justify their maintenance cost; document the rationale in the change.
- [ ] Run the full repository verification and review the resulting diff for lost behavior coverage.
- [ ] Mark this plan `completed-awaiting-retirement`, commit the audit, and push the PR update.

## Exit criteria

- Remaining tests protect meaningful behavior or consumer contracts.
- No test is kept merely as a tautology, change detector, or redundant mirror of stronger coverage.
- Full repository verification passes.
