# Interpret run results

Use `run_get` with `view: "status"` and `view: "answers"` to inspect lifecycle
state and typed respondent outcomes. Report completed, failed, pending, and
total evaluations alongside the run status. A run is not complete merely
because some respondents answered.

Use the exact Choice, Score, or Noul semantics from the frozen request to
interpret answers. Describe what the supplied profiles, material, and question
produced. Failed and uncertain calls do not create answers; provider attempts
are not additional respondents. Do not convert modeled responses into claims
about human behavior or population prevalence.

`run_get` with `view: "request"` returns the accepted request and frozen
per-respondent packets. Answer rows carry evaluation, context, respondent, and
question IDs that can help an agent reason about a follow-on request. The
current MCP does not query prior answers to select a cohort or automatically
carry turn-choice history into another request. State that limitation when it
matters to the user's next question.

When reporting to the user, connect evidence to the decision they wanted to
make about the artifact. Explain uncertainty, failed coverage, provider
identity, and cost evidence only where they affect that interpretation. Offer a
next question only if the current request shape can preserve the user's intent.
