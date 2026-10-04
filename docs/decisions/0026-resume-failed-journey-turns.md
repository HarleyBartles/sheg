# ADR-0026: Resume respondent-local failures in partial journeys

- Status: Accepted
- Date: 2026-10-04
- Supersedes: None

## Context

A durable journey can preserve successful respondent answers and paths while a respondent-local failure stops that respondent at a reached turn. The original lifecycle contract refused all partial journeys, and the respondent state clears current-turn pointers when marked failed. The failed evaluation still stores its turn, node, context and frozen packet, while respondent events and route preserve earlier progress. The v7 datastore constraint requires non-active respondents to have null current-turn pointers.

## Options considered

- Continue refusing partial journeys. This is simple but forces authors to start another run and cannot reuse the exact remaining respondent work.
- Restart every respondent in the partial run. This repeats successful calls, risks changing prior answers and paths, and spends the original allowance on completed work.
- Resume each failed respondent from its exact failed evaluation. This keeps prior evidence and the frozen request while making retry behavior explicit and bounded by the original call allowance.

## Decision

Allow explicit resume when every failed journey evaluation maps to a failed respondent and each such respondent has exactly one failed evaluation, no cancellation is pending, no provider attempt is unresolved, and the original call allowance has room. In the atomic resume transaction, reopen only those evaluation rows and restore each failed respondent's active turn pointers from its saved evaluation. Keep the v7 failed-state pointer constraint, completed evaluations, respondent events and route, evaluation identity, packet/compiler identity, physical-attempt history, run ID, and original call limit unchanged. Reads never launch retries; `run_resume` is the only recovery action. A retry failure remains visible and can be resumed again only while the same safety conditions hold.

## Consequences

- Lifecycle eligibility and the resume transaction must derive from the same saved failed-evaluation and respondent state, and refuse missing or ambiguous checkpoints.
- Successful respondents and earlier successful turns are never replayed by recovery.
- The retried turn uses its original frozen packet; a new branch is created only after a valid retry answer.
- Failed physical attempts remain inspectable after the evaluation is reopened and after a later successful answer.
- Development does not require a schema change; post-0.3.0 schema migration obligations remain governed by the datastore compatibility policy.
