# Current primitives and tool contracts

The current MCP run shape is deliberately small. An agent supplies one or more
distinct respondent profiles, one or more exact inline text items, one typed
Choice, Score, or Noul question, one provider configuration, and a physical
call limit at least as large as the respondent count.

| Tool | Purpose | Side effect |
| --- | --- | --- |
| `run_inspect` | Validate the strict request and measure context fit for each respondent. | No persistence, inference, or worker launch. |
| `run_start` | Persist a validated request, return a durable run ID, and launch its worker. An identical submission ID plus request returns the same run. | Starts inference after credential and fit admission. |
| `run_list` | Find durable runs by status or label and paginate. | Reconcile expired ownership; never launch work. |
| `run_get` with `view: status` | Read lifecycle state and counts. | Reconcile expired ownership; never launch work. |
| `run_get` with `view: request` | Recall the frozen request, compiled packets, and their stable evaluation/context IDs. | Read only. |
| `run_get` with `view: answers` | Recall typed answers, failures, and pending evaluations with stable identifiers. | Reconcile expired ownership; never launch work. |
| `run_cancel` | Request that the worker stop before dispatching another respondent. | An in-flight call is allowed to settle. |

## Request design

The agent owns the meaning and granularity of the user's question. If the user
asks which part of a page loses their interest, the agent can define the choices
as sections, paragraphs, or another explicit unit. Sheg receives that choice
structure; it does not decide what constitutes a meaningful “part.” Exact
material text is preserved as supplied.

Choice option IDs are stable machine identifiers paired with user-meaningful
labels. Score uses a typed ordered rubric. Noul represents probability. These
types must match the information the user wants back; do not turn a probability
or ranking request into a nominal Choice just because it is easy to encode.

The same request is compiled into one frozen decision packet per respondent.
Input order, exact material, typed question, provider configuration, and the
prompt contract determine the accepted request fingerprint. The submission ID
is an idempotency key for one exact request, not a study name. A changed request
uses a new submission ID.

## Current follow-on boundary

Run recall exposes the frozen input, per-respondent packet context, answers,
and identifiers that an agent can inspect to design a later request. The direct
request can be submitted again with selected respondent profiles and chosen
material, but Sheg does not yet offer query predicates over prior answers,
automatic respondent selection from a previous run, or explicit carry-forward
of prior turn-choice history. Those are later capabilities, not implicit
behavior of `run_get`.

Likewise, run recall is not recovery. Reads discover expired workers as
interrupted and do not resume them. Cancellation prevents the next dispatch,
but does not discard an answer for a provider call that was already in flight.

## Interpreting evidence

Use status and answer rows together. Completed, failed, pending, and total
evaluation counts describe coverage. A respondent-local invalid or failed
answer does not hide sibling results. A run-wide provider failure stops later
dispatches. An uncertain in-flight call consumes the physical attempt allowance
without inventing an answer.

These are modeled respondent outputs for the supplied profiles, material, and
question. They can help the user examine an artifact or compare possibilities;
they are not claims about observed human behavior or population prevalence.
