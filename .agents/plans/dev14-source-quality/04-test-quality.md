# Test quality pass

**Goal:** Keep the repository's behavior tests useful as implementation and skill scenarios evolve, without adding skill runs to CI or retaining run results in source.

**Scope:** Read every `test/**/*.test.ts` file and inspect its exercised boundary. Keep real SQLite, copied-package, provider-wire and MCP integration coverage where it proves behavior; improve only tests with a concrete weakness.

## Review rules

- Remove exact catalog inventories when the contract is uniqueness, pairing or filtering; assert those semantics against the loaded catalog instead.
- Reject tests that compare a value with itself, construct data solely to round-trip it through the same schema, or assert source layout without a user-visible contract.
- Treat file size as a prompt to inspect responsibility, not as a reason to split a focused suite. Consolidate repeated cases only when independence does not improve failure diagnosis.
- Keep skill behavior campaigns manually invoked and campaign data outside the repository. Ship scenario and harness code, not campaign receipts or result snapshots.
- Preserve process-level isolation and cleanup; subprocess tests must synchronize on observable readiness and always terminate children on failure paths.

## Tasks

- [x] Review every test file and classify findings by behavior, integration boundary, duplication, isolation, determinism and maintenance value.
- [x] Replace brittle full scenario-selection and calibration-label inventories with semantic inclusion/exclusion checks; retain meaningful scenario-specific behavior assertions.
- [x] Remove the self-comparison calibration assertion and unused baseline trace schema/test. Fix any other test that cannot fail when the promised behavior regresses.
- [x] Harden lock child-process startup, exit synchronization and cleanup; do not weaken lock race or crash coverage.
- [x] Run focused tests, then the full repository gate after all source and generated package changes are complete.
