---
name: study-design
description: Use when helping a person turn material and a question into the simplest useful supported Sheg respondent request.
---

# Design a study with Sheg

Start from the person's material and the answer they need. The person does not
need to know Sheg's storage, request schema, or model adapter. Your job is to
translate their goal into the smallest useful respondent request, then explain
what its results can and cannot tell them.

Read the [current primitives and tool contracts](references/primitives-and-tools.md)
before suggesting a design. The current direct-run tool accepts one typed
question over inline material and distinct respondent profiles. Do not promise
multi-stage journeys, saved-cohort queries, replay of prior history, or study
cloning as available MCP capabilities.

## Design conversation

1. Establish the artifact or exact material, what the person wants to learn,
   and what decision the answer should inform. When the person already knows
   the question, preserve it and move on. Ask focused questions only for
   missing information that would change the design.
2. Choose the smallest material unit that represents the user's words. If they
   ask which “bit” loses interest, recommend a useful unit such as sections or
   paragraphs; do not imply Sheg infers editorial boundaries. Preserve exact
   source wording in each included item.
3. Choose a typed question that returns useful evidence: Choice for a
   selection among authored meanings, Score for an ordered rubric, or Noul for
   a probability. The agent chooses options and meanings from the user's goal.
   Include `unanswerable` when respondents may lack enough information.
4. Propose distinct respondent perspectives that could answer the user's
   question. Explain why each perspective matters. Profiles are modeled
   perspectives, not real participants or independent human samples. Keep the
   cohort no larger than needed to explore the decision.
5. Present the proposed question, exact material unit, respondent profiles,
   typed response semantics, provider, and maximum calls in ordinary language.
   Revise with the person until they agree this is the simplest design that
   meets their expectation.
6. Build the strict direct request and call `run_inspect`. Resolve invalid
   input or fit issues without silently changing the text or question. For a
   hosted Jev run, obtain the person's authorization for inference and its call
   bound before calling `run_start`.
7. Start with a fresh UUID submission ID and keep the returned run ID. Explain
   the machine-readable answers, status, and counts using the user's original
   question as the frame. Report pending and failed evaluations alongside
   completed answers.

## Follow-on questions

After any run, the agent can use `run_get` to retrieve frozen inputs and
answer rows with respondent, evaluation, context, and question IDs. Use those
details to decide what respondents or results are relevant to a possible
follow-up. The current request shape is flat: it cannot select a prior cohort
by result criteria or automatically reconstruct a previous respondent's
turn-choice history. If a follow-up requires either, say that directly and
offer a supported single-question request only when it preserves the user's
intent. Do not claim that omitting earlier material is equivalent to replaying
the same earlier journey while hiding history.

An interrupted run is discoverable but cannot yet be resumed. A read never
starts work. If the user asks to stop an active run, call `run_cancel`; a
provider call already in flight may settle and its answer will be retained.

The agent should interpret Sheg's results for the person. Report modeled
responses as descriptive evidence, not human behavior or causal proof. Never
invent demographic categories or claim representativeness beyond the profiles
that were supplied.
