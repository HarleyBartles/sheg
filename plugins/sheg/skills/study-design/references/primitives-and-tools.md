# Primitives and tool contracts

An MCP request supplies distinct respondent profiles, exact inline material, typed Choice/Score/Noul questions, a provider, and a physical-call bound. Polls and follow-ons may group independent questions over the same state. Finite journeys provide staged exposure and answer-dependent routing. The [run request schema](../../stimulus-response-polling/assets/run-request.schema.json) defines the accepted shapes.

| Tool | Purpose |
| --- | --- |
| `run_inspect` | Validate and measure a proposed request; preview reachable journey paths without inference or run creation. |
| `run_start` | Persist an admitted request and launch its worker; reuse an identical submission ID/request without launching again. |
| `run_list` | Discover and paginate durable runs by status, label, time, or referenced material. |
| `run_get` | Read status, request, answers, journey, one exact context, or physical attempts using its `view`. |
| `run_query` | Filter evidence and return exact evaluation/context handles, coverage, and mapped selected-material references. |
| `run_cancel` | Prevent the next dispatch while allowing an in-flight call to settle. |
| `run_resume` | Explicitly resume eligible stopped work under its original request and call allowance. |
| `run_delete` | Preview or delete an explicit selection of inactive runs. |
| `run_storage` | Inspect compatibility/integrity, optimize healthy storage, or explicitly reset a datastore requiring recovery. |

Reads may reconcile expired worker ownership but never launch or resume work. A progressing source can gain new query matches. See [run and recovery](../../stimulus-response-polling/references/run-and-recovery.md) for inputs, pagination, lifecycle, and recovery behavior.

## Request design

The agent owns question meaning and material granularity. If the user asks which part loses interest, define an explicit unit such as sections or paragraphs. Preserve exact text; Sheg does not decide editorial boundaries.

Choice selects one stable option ID with an authored meaning. Score uses an ordered rubric; Noul returns a probability for a proposition. Match the response type to the information needed. For material-selection Choice, use `materialOptions` to link option IDs to exact candidate items. Linked labels must equal candidate text, and candidates require author-supplied source identity/digest. Keep no-fit unlinked. These metadata support traceability; Sheg does not authenticate the external source.

Each logical evaluation has a frozen packet and stable identity. Independent questions share the respondent-visible state and never see sibling answers. Jev can batch fitting questions while Laya sends singleton requests. Physical attempts, including retries and uncertain dispatches, count against `maxCalls`; answer rows do not measure call use or input diversity.

A fresh UUID submission ID identifies one exact request. Reuse it only when retrying the unchanged submission; a changed request needs a new ID.

## Follow-on evidence

Query recorded answers or route outcomes, select exact evaluation/context references or supported criteria, then author the next question. The context mode determines which material and answer history the new request receives. A mapped Choice exposes exact selected material for reuse. Read the selection and context rules before composing a follow-on; Sheg does not infer relevance or write the question.

Completed, failed, pending, and unreached evaluations describe coverage. A malformed answer does not hide independent sibling results. Shared provider failures stop later dispatches, and uncertain calls consume allowance without inventing answers. Interpret outputs as modeled responses to the supplied inputs, not observed human behavior or population prevalence.
