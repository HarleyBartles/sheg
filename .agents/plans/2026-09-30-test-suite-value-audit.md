# Test Suite Value Audit

**Status:** completed-awaiting-retirement
**Scope:** Audit the repository's tests in the context of the current PR. Remove tests that are change detectors, tautological, redundant with stronger coverage, or otherwise unable to catch a meaningful regression. Keep repository-owned lint focused on Sheg-owned source by excluding pinned third-party vendor code. Preserve valuable behavioral coverage and avoid expanding the test suite or broad refactoring.

## Decisions

- A test earns its place when it protects a concrete behavior or invariant and can fail for a meaningful regression.
- Prefer one clear owner for each invariant at the cheapest proving layer.
- Do not retain tests solely to preserve implementation shape, test counts, source literals, or file-change detection.
- Distinguish genuine integration/contract checks from exact-string or output-presence checks that only mirror the implementation.
- Exclude pinned third-party source from repository-owned lint rather than editing vendored contents to appease local lint rules.

## Tasks

- [x] Inventory and review test cases across `test/`, including helpers, fixtures, and package-level checks.
- [x] Remove only tests whose regression-detection value does not justify their maintenance cost; document the rationale in the change.
- [x] Exclude the pinned Laya vendor directory from ESLint without changing vendor source.
- [x] Run the full repository verification and review the resulting diff for lost behavior coverage.
- [x] Mark this plan `completed-awaiting-retirement`, commit the audit, and push the PR update.

## Audit findings

- Removed the exact prompt-contract hash assertion, which only pinned a source-derived value, and repeated same-input fingerprint equality; runtime fingerprints already incorporate the declared prompt contract hash, and other tests cover fingerprint inputs.
- Removed packaged-skill prose assertions; the copied-plugin smoke test still checks the executable package and verifies every relative skill link resolves.
- Removed packet-size variant scenarios duplicated at the MCP layer; packet-sizing behavior remains covered in `packet-sizing.test.ts`, and MCP retains a successful measurement call and output-shape checks.
- Removed tests that fixed schema `$ref` factoring and exact shipped archetype counts/order; consumer-facing schema constraints, valid cohort loading, nonempty catalogue data, and unique respondent archetype IDs remain covered.
- Excluded `src/providers/laya/vendor/` from lint because its files are pinned third-party source and not maintained by Sheg; the vendor files themselves remain unchanged.

## Exit criteria

- Remaining tests protect meaningful behavior or consumer contracts.
- No test is kept merely as a tautology, change detector, or redundant mirror of stronger coverage.
- Full repository verification passes.
