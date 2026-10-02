---
name: study-design
description: Use when helping a person turn material and a question into the simplest useful supported Sheg respondent request.
---

# Design a study with Sheg

Start from the person's material and the answer they need. The person does not need to know Sheg's storage, request schema, or model adapter. Your job is to translate their goal into the smallest useful respondent request, then explain what its results can and cannot tell them.

Read the [current primitives and tool contracts](references/primitives-and-tools.md) before suggesting a design. The MCP accepts typed questions, a finite authored sequence/graph over inline material and distinct respondent profiles, and follow-on requests built from queried evidence or exact evaluation/context references. It records only the turns each respondent actually reaches. Journey recall provides evidence; the agent authors and submits the next request explicitly.

## Design conversation

1. Establish the artifact or exact material, what the person wants to learn, and what decision the answer should inform. When the person already knows the question, preserve it and move on. Ask focused questions only for missing information that would change the design.
2. Choose the smallest material unit that represents the user's words. If they ask which “bit” loses interest, recommend a useful unit such as sections or paragraphs; do not imply Sheg infers editorial boundaries. Preserve exact source wording in each included item.
3. Choose a typed question that returns useful evidence: Choice selects among authored candidates, Score records a position on an authored ordered rubric, or Noul records a probability. For a material-selection Choice, author each candidate as an exact bounded material item, make its option label the exact candidate text, and link that option ID to the material ID with `materialOptions`. Keep a no-fit option unlinked. The agent chooses the candidate boundaries and meanings; Sheg does not extract them. Include `unanswerable` when respondents may lack enough information. Use a direct poll when one question answers the need; use a finite sequence or response-routed graph when the user needs several stages or conditional follow-up questions.
4. Propose distinct respondent perspectives that could answer the user's question. Explain why each perspective matters. Profiles are modeled perspectives, not real participants or independent human samples. Keep the cohort no larger than needed to explore the decision.
5. Present the proposed question, exact material unit, respondent profiles, typed response semantics, provider, and maximum calls in ordinary language. Revise with the person until they agree this is the simplest design that meets their expectation.
6. Build the strict direct request or finite journey. Use `run_inspect` when a fit preview would help; `run_start` performs admission validation itself. Resolve invalid input or fit issues without silently changing the text or question. For a hosted Jev run, obtain the person's authorization for inference and its call bound before calling `run_start`.
7. Start with a fresh UUID submission ID and keep the returned run ID. Explain the machine-readable answers, status, and counts using the user's original question as the frame. Report pending and failed evaluations alongside completed answers.

## Follow-on questions

After any run, use `run_query` and `run_get` to retrieve typed answers, exact evaluation/context handles, and journey details. A mapped Choice result includes `selectedMaterial` with its exact `materialId`, text, source metadata, and text digest. The agent can query a subset, author a new question, then select the original respondent context with the query's evaluation/context handles and pass `selectedMaterial.materialId` in `context.materialIds`. Choose `continue` when the selected completed answer should enter the trajectory, or `omit-history` when the new question should use exact material without earlier exposure history. Sheg retrieves and preserves those choices; the agent decides which evidence is relevant and what the follow-up should ask.

An interrupted run can be resumed explicitly with `run_resume`; the original run ID, request, and physical-call ceiling remain in effect. A read never starts or resumes work. If the user asks to stop an active run, call `run_cancel`; a provider call already in flight may settle and its answer will be retained.

The agent should interpret Sheg's results for the person. Report modeled responses as descriptive evidence, not human behavior or causal proof. Never invent demographic categories or claim representativeness beyond the profiles that were supplied.
