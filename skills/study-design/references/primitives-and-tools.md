# Current primitives and tool contracts

The current MCP run shape is deliberately small. An agent supplies one or more distinct respondent profiles, exact inline text and typed Choice, Score, or Noul questions, one provider configuration, and a bounded physical-call limit. A direct poll or follow-on can contain one or more independent questions over the same frozen respondent context; use a finite authored sequence or graph when questions depend on earlier answers.

| Tool | Purpose | Side effect |
| --- | --- | --- |
| `run_inspect` | Validate the strict request, measure context fit for each compiled evaluation packet, and preview reachable journey paths. | Creates no new run and makes no inference call. Resolving a follow-on may reconcile an expired source-run lease; it never launches a worker. |
| `run_start` | Persist a validated request, return a durable run ID, and launch its worker. An identical submission ID plus request returns the same run. | Starts inference after credential and fit admission. |
| `run_list` | Find durable runs by status or label and paginate. | Reconcile expired ownership; never launch work. |
| `run_get` with `view: status` | Read lifecycle state and counts. | Reconcile expired ownership; never launch work. |
| `run_get` with `view: request` | Recall the frozen request, compiled packets, and their stable evaluation/context IDs. | Reconcile expired ownership; never launch work. |
| `run_get` with `view: journey` | Recall reached turns, exact respondent packets, exposures, typed response history, route and terminal/failure state. | Reconcile expired ownership; never launch work. |
| `run_get` with `view: answers` | Recall typed answers, failures, and pending evaluations with stable identifiers. | Reconcile expired ownership; never launch work. |
| `run_query` | Reconcile expired ownership, then filter typed answers and journey outcomes; return evaluation/context handles and, for mapped Choice answers, selected material references. | Never launch work; a progressing source can gain more matches. |
| `run_cancel` | Request that the worker stop before dispatching another respondent. | An in-flight call is allowed to settle. |

## Request design

The agent owns the meaning and granularity of the user's question. If the user asks which part of a page loses their interest, the agent can define the choices as sections, paragraphs, or another explicit unit. Sheg receives that choice structure; it does not decide what constitutes a meaningful “part.” Exact material text is preserved as supplied.

Choice option IDs are stable machine identifiers paired with user-meaningful labels. Score uses a typed ordered rubric. Noul represents probability. These types must match the information the user wants back; do not turn a probability or ranking request into a nominal Choice just because it is easy to encode. For Choice over authored material candidates, map option IDs to exact material IDs with `materialOptions`; linked labels must equal exact text and candidates must carry author-supplied source metadata. Keep no-fit options unlinked. Query returns the selected `materialId`, exact text, author source identity/digest, and Sheg-computed text digest. Pass the ID through follow-on `context.materialIds`.

Sheg compiles one frozen decision packet per respondent and question evaluation. Independent questions share the respondent-visible state but remain separate evaluations; Jev may batch a question group into one provider request when it fits, while local Laya sends one question per physical request. Input order, exact material, typed questions, provider configuration, and the prompt contract determine the accepted request fingerprint. The submission ID is an idempotency key for one exact request, not a study name. A changed request uses a new submission ID.

## Current follow-on boundary

`run_query` filters recorded typed answers and route outcomes in one run. The agent inspects those results, decides which respondents and answers matter, then submits a follow-on with explicit criteria or exact evaluation/context references. A follow-on's context mode determines whether the selected answer enters its trajectory and which saved or selected material is presented. Sheg does not decide relevance or compose the next question for the agent.

Likewise, run recall is not recovery. Reads discover expired workers as interrupted and do not resume them. Use `run_resume` explicitly to continue an eligible run under its original attempt allowance. Cancellation prevents the next dispatch, but does not discard an answer for a provider call that was already in flight.

## Interpreting evidence

Use status and answer rows together. Completed, failed, pending, and total evaluation counts describe coverage. A respondent-local invalid or failed answer does not hide sibling results. A run-wide provider failure stops later dispatches. An uncertain in-flight call consumes the physical attempt allowance without inventing an answer.

These are modeled respondent outputs for the supplied profiles, material, and question. They can help the user examine an artifact or compare possibilities; they are not claims about observed human behavior or population prevalence.
