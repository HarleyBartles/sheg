# ADR-0021: Independent question groups share context and separate evidence

- Status: Accepted
- Date: 2026-10-02
- Supersedes: None

## Context

Users and their agents often want several measurements about the same respondent state. Requiring a separate run for every question duplicates request setup and makes it harder to compare answers from the same frozen perspective. At the same time, silently feeding one answer into a sibling question would change the respondent state and make the questions dependent. Provider capabilities also differ: Jev can measure batches, while the local Laya adapter currently issues one question per physical request.

## Options considered

- Keep one question per run. This preserves a simple execution contract but makes same-state comparison cumbersome and duplicates durable run records.
- Treat multiple questions as a conversational sequence. This permits dependencies but changes context between questions and risks unintended answer leakage.
- Group independent questions over one frozen context, preserving each question as separate answer evidence and allowing provider-specific batching. Explicit follow-on runs represent dependencies.

## Decision

Accept one or more independent typed questions in a poll or follow-on request. All questions in a group use the exact same frozen respondent context, and no sibling answer is visible to another sibling. Each question has its own evaluation identity, status, typed answer, and query handle. To ask a dependent question after a group, submit a follow-on which explicitly selects the completed evaluation and context handles.

The application may split a group into physical provider attempts while preserving question meaning and shared context. `maxCalls` counts those physical attempts, including retries and uncertain in-flight attempts. Jev may batch questions when its measured fit allows it. Local Laya currently executes one question per physical request. Journey turns remain sequential and are not converted into independent groups.

## Consequences

Agents can ask several focused questions about one exact respondent state, query a particular answer, and form a dependent follow-on without replaying the preceding journey. Run inspection reports the minimum physical call count after provider-specific batching or splitting; retries can increase actual use within the run-wide call ceiling. Reports must distinguish logical answers from physical attempts. The request author remains responsible for selecting question units and for deciding which evidence to use in a follow-on.
