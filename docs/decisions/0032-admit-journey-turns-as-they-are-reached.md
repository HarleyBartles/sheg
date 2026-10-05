# ADR-0032: Admit journey turns as they are reached

- Status: Accepted
- Date: 2026-10-05
- Supersedes: The exhaustive all-path admission requirement in [ADR-0010](0010-preflight-study-context-for-configured-providers.md) and the final all-path run check in [ADR-0011](0011-deterministic-study-preview-and-packet-sizing.md)

## Context

Durable journey admission enumerated every possible response history before creating a run. The path count grows exponentially even when the run itself asks only one question per turn. A finite 4-respondent, 12-turn Choice sequence can exceed the bounded preflight budget before inference, preventing realistic journeys from starting. Raising that budget would move the resource problem without changing the exponential work.

Provider adapters already measure each actual request before transport. A fit refusal is recorded with zero physical calls, and respondent-local journey failures preserve completed answers and reached paths. Those mechanisms allow the run to check future inputs when their actual path is known.

## Options considered

- Raise the exhaustive traversal or byte limit. Rejected because this permits larger resource use but retains exponential packet construction and measurement.
- Keep rejecting journeys whose possible histories exceed the traversal budget. Rejected because valid bounded work is refused before the actual path is known.
- Admit initial inputs and check every later reached input immediately before transport, retaining run-call bounds and explicit partial-failure evidence. Chosen because it scales with actual work without bypassing provider admission.

## Decision

For durable journey `inspect` and `start`, measure one initial packet for every respondent before accepting the run. Cache measurements by canonical provider-visible request fingerprint, while retaining a fit entry for every respondent. Calculate minimum and maximum physical-call bounds from the validated journey topology without expanding response histories. Return a warning that later reached turns are checked just before inference.

Each provider must measure its exact reached request inside `decide` before credential use or network dispatch. If a later respondent-local packet overflows or cannot be measured, record the zero-call failure against that reached turn, stop that respondent, and allow unrelated respondents to continue. The run then reports its partial state and preserves completed answers and route history. Provider-wide failures retain their existing run scope.

The hard traversal and byte bounds remain on historical manifest `preflight`, which continues to report incomplete coverage as unverified. This diagnostic does not gate durable direct-request runs.

## Consequences

- Durable journey start cost depends on distinct initial provider inputs and cohort size rather than every possible response history.
- Fit entries from `run_inspect` establish fit for initial packets only. The warning must make deferred reached-turn admission clear, and a valid inspection does not promise that every possible future path fits.
- A journey can become partial when a reached later packet is unfit. The failure remains tied to its respondent and turn, records zero calls when transport did not occur, and is available through durable evidence and explicit recovery.
- `maxCalls` admission still uses deterministic minimum path requirements; route bounds are not approximated by the admission change.
- Whole-manifest `preflight` remains exhaustive within its existing hard limits for authors who need a complete path report.
