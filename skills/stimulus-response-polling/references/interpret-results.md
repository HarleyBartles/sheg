# Interpret run results

Use `run_get` with `view: "status"` and `view: "answers"` to inspect lifecycle
state and typed respondent outcomes. For a journey, use `view: "journey"` to
inspect each respondent's exact reached turns, exposures, typed response
history, route, and terminal or failure state. Report completed, failed,
pending, unreached, and total evaluations alongside the run status. A run is
not complete merely because some respondents answered.

Use the exact Choice, Score, or Noul semantics from the frozen request to
interpret answers. Describe what the supplied profiles, material, and question
produced. Failed and uncertain calls do not create answers; provider attempts
are not additional respondents. Do not convert modeled responses into claims
about human behavior or population prevalence.

`run_get` with `view: "request"` returns the accepted request and frozen
per-respondent packets. Answer rows carry evaluation, context, respondent, and
question IDs. `run_query` filters prior typed answers and route outcomes and
returns exact evaluation/context handles. For explicitly mapped Choice options,
it also returns `selectedMaterial` with material ID, exact text, author-supplied
source identity/digest, and Sheg-computed text digest. The agent decides which
evidence matters and authors the next request, passing selected references and
any `selectedMaterial.materialId` through the follow-on request's context.

A terminal outcome such as `left` records how the authored journey ended. It
does not establish that the respondent lost interest. Treat lost interest as
evidence only when an explicit typed question asked for and recorded it. Failed
means an attempted evaluation did not produce a valid answer; pending means it
has not settled; unreached means the run stopped before that authored turn was
asked. None of these states is a negative answer.

When reporting to the user, connect evidence to the decision they wanted to
make about the artifact. Explain uncertainty, failed coverage, provider
identity, and cost evidence only where they affect that interpretation. Offer a
next question only if the current request shape can preserve the user's intent.
