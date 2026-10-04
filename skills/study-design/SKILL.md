---
name: study-design
description: Use when helping a person turn material and a question into the simplest useful supported Sheg respondent request.
---

# Design a study with Sheg

Start from the person's material and the answer they need. The person does not need to know Sheg's storage, request schema, or model adapter. Your job is to translate their goal into a focused respondent request that covers the meaningful input differences they want to understand, then explain what its results can and cannot tell them.

Substantive result variation comes from four inputs: respondent profile, stimulus, question or response, and state such as prior-turn visibility. A cohort supplies respondent-profile variation, so include the distinct perspectives that matter to the decision rather than minimizing cohort size by default. When all four inputs match, another run is a duplicate for study coverage; it may show ordinary model variability, but repeating it does not add substantive coverage. Reserve exact repeats for a named stability or recovery check. Change only dimensions that matter to the user's decision, and do not alter the intended construct just to make runs look different.

Read the [current primitives and tool contracts](references/primitives-and-tools.md) before suggesting a design. The MCP accepts typed questions, a finite authored sequence/graph over inline material and distinct respondent profiles, and follow-on requests built from queried evidence or exact evaluation/context references. It records only the turns each respondent actually reaches. Journey recall provides evidence; the agent authors and submits the next request explicitly.

## Design conversation

1. Establish the artifact or exact material, what the person wants to learn, and what decision the answer should inform. When the person already knows the question, preserve it and move on. Ask focused questions only for missing information that would change the design.
2. Choose the smallest material unit that represents the user's words. If they ask which “bit” loses interest, recommend a useful unit such as sections or paragraphs; do not imply Sheg infers editorial boundaries. Preserve exact source wording in each included item.
3. Choose a typed question that returns useful evidence: Choice selects among authored candidates, Score records a position on an authored ordered rubric, or Noul records a probability. For a material-selection Choice, author each candidate as an exact bounded material item, make its option label the exact candidate text, and link that option ID to the material ID with `materialOptions`. Keep a no-fit option unlinked. The agent chooses the candidate boundaries and meanings; Sheg does not extract them. Include `unanswerable` when respondents may lack enough information. Use a direct poll when one question answers the need. A sequence exposes all items first, then asks all tasks: `A, B, C, then Q_A, Q_B, Q_C`. When the user wants `A, Q_A, B, Q_B, C, Q_C`, recommend a graph with interleaved expose and ask turns, even if the route is straight and has no branches. Use a graph too when an answer routes to a different next turn.
4. Propose the distinct respondent perspectives needed to cover the meaningful differences in the user's decision. Explain why each perspective matters. Profiles are modeled perspectives, not real participants or independent human samples; they are the source of respondent-profile variation in the study.
5. Present the proposed question, exact material unit, respondent profiles, typed response semantics, provider, and maximum calls in ordinary language. Revise with the person until they agree this focused design covers the perspectives and input differences they need to understand.
6. Build the strict direct request or finite journey. Use `run_inspect` when a fit preview would help; `run_start` performs admission validation itself. Resolve invalid input or fit issues without silently changing the text or question. For a hosted Jev run, obtain the person's authorization for inference and its call bound before calling `run_start`.
7. Start with a fresh UUID submission ID and keep the returned run ID. Explain the machine-readable answers, status, and counts using the user's original question as the frame. Report pending and failed evaluations alongside completed answers.

## Follow-on questions

### Journey order and history

Choose the journey shape from the order the user wants. A sequence exposes all of its items in order before asking its tasks: `A, B, C, then Q_A, Q_B, Q_C`. It does not pair each item with its own question. For `A, Q_A, B, Q_B, C, Q_C`, use a graph with interleaved expose and ask turns, even when every respondent follows the same straight route. Use a graph too when an answer chooses the next turn. A branch sees only the material exposed along that respondent's reached path, not material from an unvisited sibling branch.

Name material and answer history separately; do not use “history” alone. Each question receives the exact text of every distinct item exposed so far on that respondent's path, in first-exposure order. If A is exposed, then B, then A again, a later packet includes A then B once each; the journey still records both exposures to A. On each graph task, `responseHistory: include` includes earlier typed answers and `responseHistory: omit` leaves earlier answers out. This setting changes answers only: omitting answers never removes previously exposed material. For example, after A and B have been exposed, a task with `responseHistory: omit` receives A then B and no earlier typed answers.

After any run, use `run_query` and `run_get` to retrieve typed answers, exact evaluation/context handles, and journey details. A mapped Choice result includes `selectedMaterial` with its exact `materialId`, text, source metadata, and text digest. The agent can query a subset, author a new question, then select the original respondent context with the query's evaluation/context handles and pass `selectedMaterial.materialId` in `context.materialIds`. Choose `continue` when the selected completed answer should enter the trajectory, or `omit-history` when the new question should use exact material without earlier exposure history. Sheg retrieves and preserves those choices; the agent decides which evidence is relevant and what the follow-up should ask.

An interrupted run can be resumed explicitly with `run_resume`; the original run ID, request, and physical-call ceiling remain in effect. A read never starts or resumes work. If the user asks to stop an active run, call `run_cancel`; a provider call already in flight may settle and its answer will be retained.

The agent should interpret Sheg's results for the person. Report modeled responses as descriptive evidence, not human behavior or causal proof. Never invent demographic categories or claim representativeness beyond the profiles that were supplied.
