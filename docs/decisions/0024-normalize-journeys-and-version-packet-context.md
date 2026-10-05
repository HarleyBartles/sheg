# ADR-0024: Normalize journeys and version packet context

- Status: Accepted
- Date: 2026-10-03
- Supersedes: None

## Context

Sheg supports an author-friendly sequence presentation and a graph presentation. When their default exposure windows differ, equivalent linear journeys produce different prompts, previews, and respondent histories. This makes behavior depend on which presentation an author selected rather than on what the journey actually exposed. Durable runs also need a stable way to resume after packet semantics change.

## Options considered

- Keep separate sequence and graph execution policies. This preserves their existing prompt windows but makes equivalent journeys behave differently and duplicates traversal logic.
- Add a per-run flag for cumulative material. This makes authors select a default packet rule even when all material was already exposed, and permits equivalent journeys to diverge again.
- Normalize sequence shorthand to a deterministic linear graph and use one cumulative exposure rule. This makes topology and packet context independent while keeping sequence requests concise and readable.

## Decision

Keep `sequence` as author-facing shorthand for exposing every arm item in order and then asking every task in order. Compile it to the same internal graph projection used by graph journeys; preserve the authored presentation in accepted requests and stored records.

Every journey packet includes the exact text of all items exposed through that turn, deduplicated by item ID in first-exposure order. Exposure events and trajectory counts remain occurrence-based. Graph paths include only material they actually exposed, so sibling-only and unreached material is never added. `responseHistory: include | omit` independently controls prior typed answers; omitting answers does not remove exposure evidence or material.

The v7 packet compiler owns these semantics. A durable journey with a recognized v6 compiler identity keeps its frozen packets and uses its original sequence-all-items or graph-since-decision window whenever a later turn must be compiled. Unknown compiler identities fail closed when continuation requires packet compilation.

## Consequences

Preview, preflight, admission, local execution, durable execution, and resume must use the same normalized topology and compiler-selected packet policy. New v7 runs have consistent cumulative material semantics; v6 runs retain their accepted meaning until completion. Future packet-contract changes must preserve the prior compiler identity and add an explicit continuation policy before changing durable behavior.
