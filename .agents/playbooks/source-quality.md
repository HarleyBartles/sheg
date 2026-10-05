# Source quality

## Applicability

Use for changes to Sheg source, tests, generated runtime output, persisted contracts, or provider and entrypoint behavior.

## Method

Trace each changed behavior from its public entrypoint to the semantic owner and back to its tests. Keep domain rules in `src/domain/`, orchestration in `src/application/`, provider wire behavior in `src/providers/`, and persistence mechanics in `src/infrastructure/`. Validate external and persisted input at the boundary that owns its interpretation. Preserve transaction atomicity, physical-call accounting, respondent-local recovery, frozen evidence, and compatibility guarantees.

Reuse an existing value or operation result when it already proves the needed state. Keep related persistence mutations in their transaction owner and bounded reads in named read owners. Share behavior across entrypoints or provider modes only where the contract is identical; retain distinct wire decoders, error scopes, and report shapes.

## Profile routing and maintenance

Before editing or reviewing a relevant surface, read [boundary drift](../unslop/boundary-drift.md) for execution and entrypoint boundaries and [single ownership and operation-local reuse](../unslop/single-owner-and-reuse.md) for domain, storage, worker, and report changes. Apply only the relevant guard. When evidence shows a distinct occurrence, update the matching profile with a durable reference and state whether reachability or effectiveness was observed, unknown, or unsuccessful.

## Verification

Add or extend behavior tests for a demonstrated gap, then run the focused tests, `npm run typecheck`, and `npm run verify` as appropriate. Rebuild generated runtime output from canonical source. Passing tests establish the covered behavior; they do not establish that a profile was discovered or followed.
