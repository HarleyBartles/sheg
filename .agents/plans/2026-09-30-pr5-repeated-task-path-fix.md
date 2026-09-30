# PR 5 Follow-on Review Fixes

**Status:** completed-awaiting-retirement
**Scope:** Fix two findings from the fresh full-PR review: repeated-task decision selection during partial graph reconstruction, and Choice probability history omitted from preflight packet sizing assurance.

## Requirements

- Keep reconstruction tied to the exact checkpoint decision consumed for each presented task occurrence.
- Do not infer a route from another occurrence with the same task ID.
- Preserve the pending-response boundary and only reconstruct exposures supported by durable presentation evidence.
- Never claim fit when prior Choice response probability/confidence evidence can make a future packet larger than the synthetic packet measured by preflight.

## Tasks

- [x] Add behavior tests for Choice probability history preflight and a graph with two ask nodes using one task ID, distinct stored choices, and a partial journey reaching a later task; observe the expected failures.
- [x] Mark future packets with Choice response history unverified unless the walker supplies a conservative full Choice result.
- [x] Change reconstruction to retain and route from the specific decision consumed at each task occurrence.
- [x] Run focused report, preflight, CLI, and MCP tests; regenerate affected runtime bundles and verify through the staged repository gate. All 163 tests and generated-file verification passed.
- [x] Commit and push the correction as `3e79bb548467229a690b3820842fd88e5bd821d7`; remote branch and PR #5 head match.

## Exit criteria

- Reconstructed response order and exposures follow the distinct stored choices at repeated task nodes.
- Focused tests and the complete repository gate pass.
