# ADR-0020: Snapshot follow-on contexts with separate lineage

- Status: Accepted
- Date: 2026-10-01
- Supersedes: None

## Context

Agents need to query a run, select exact respondent evaluations and contexts,
and ask a new question against the selected state. A follow-on must preserve
the exact model-visible input it used, even if the source run is later deleted.
Source evidence may also change while provider context fit is being measured.

## Options considered

- Store only source-run references and resolve inputs on every read. This keeps
  one copy of the packets, but later results can change with source progress and
  deleting the source breaks the follow-on.
- Prevent source deletion while any follow-on refers to it. This preserves
  lookup but turns related runs into a coupled deletion unit and retains data
  the user explicitly chose to remove.
- Copy each selected model-visible packet into the new run and retain source
  identifiers and selection lineage separately. This uses additional local
  storage but makes each run independently inspectable.

## Decision

Resolve the source selection in one SQLite read transaction. Freeze each
selected packet into the follow-on's own evaluation record, and store source
run, evaluation, context, selection, status, and source-version details as
lineage outside the respondent-visible packet. After provider fit checks,
accept only if the source version still matches. Reject stale acceptance with
`source_changed_during_acceptance`; the agent can inspect again. Once accepted,
the follow-on remains self-contained and does not depend on the source record.
Reads report the source as `live` or `historical` when it has been deleted.

## Consequences

Deleting a source does not remove a follow-on's frozen inputs or answers, and
the agent can continue querying the child run. Delete previews identify
dependent follow-ons that will be retained. Duplicate model-visible packet
data consumes local storage; Sheg manages its integrity and optimization.
Selection rationale stays with the agent, not in the respondent prompt.
