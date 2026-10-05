# Source quality

## Applicability

Use when implementing or reviewing changes to Sheg source, tests, generated runtime output, persisted contracts, providers, or entrypoints.

## Method

Trace each changed behavior from its public entrypoint to its semantic owner and behavior coverage. Keep domain rules in `src/domain/`, orchestration in `src/application/`, provider wire behavior in `src/providers/`, and persistence mechanics in `src/infrastructure/`. Inspect callers and existing tests before changing an interface or removing code. Validate external and persisted input at the boundary that owns its interpretation.

Read the relevant profiles before editing or reviewing: boundary drift applies to provider execution and entrypoint boundaries; single ownership and operation-local reuse applies to domain, storage, worker, and evidence changes. Apply their recognition cues and corrective behavior to the concrete change. Reuse a value or operation result when it already proves the needed state. Share behavior only where the contracts are identical.

## Constraints

Preserve transaction atomicity, physical-call accounting, respondent-local recovery, frozen evidence, and the release compatibility policy. Keep persistence mutations within their transaction owner and bounded reads within named read owners. Retain distinct wire decoders, error scopes, and public result shapes. Generate runtime output from canonical source. Do not add tests that only detect source edits or duplicate implementation assertions.

## Verification

Add or extend behavior tests only for a demonstrated coverage gap. Run focused tests, typecheck, and the full `npm run verify` gate before publication. Rebuild and check generated parity when source or shipped guidance changes. For package changes, exercise the copied runtime and required assets independently of the checkout. Review ownership and boundary semantics in the diff; passing tests prove only the covered behavior and do not prove profile discovery or effectiveness.

## References and routing

Use the [implementing runbook](../runbooks/implementing.md) for execution and the [PR runbook](../runbooks/pr.md) for review and publication. Follow [boundary drift](../unslop/boundary-drift.md) and [single ownership and operation-local reuse](../unslop/single-owner-and-reuse.md) for applicable corrective guards. The [decision records](../../docs/decisions/README.md) own consequential architecture and compatibility choices; the [operating standards certification](../contracts/standards-certification.md) owns the compliance obligations.

## Maintenance

Revisit this method and its references when responsibility boundaries, validation commands, package ownership, or compatibility policy change. When distinct evidence matches a profile, update that profile with a durable reference and assess whether the guard was reachable, followed, and useful; unknown effect stays unknown. Review the playbook's category, usefulness, routes, and certification whenever it changes.
