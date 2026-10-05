---
name: study-design
description: Use when helping a person turn material and a question into the simplest useful supported Sheg respondent request.
---

# Design a study with Sheg

Start from the person's material and the answer they need. The person does not need to know Sheg's storage, request schema, or model adapter. Your job is to translate their goal into a focused respondent request that covers the meaningful input differences they want to understand, then explain what its results can and cannot tell them.

Substantive result variation comes from four inputs: respondent profile, stimulus, question or response, and state such as prior-turn visibility. A cohort supplies respondent-profile variation. Describe its size in terms of which meaningful reader perspectives it covers; the objective is profile coverage, not cohort minimization. When all four inputs match, another run is a duplicate for study coverage; it may show ordinary model variability, but repeating it does not add substantive coverage. Reserve exact repeats for a named stability or recovery check. Change only dimensions that matter to the user's decision, and do not alter the intended construct just to make runs look different.

Read the [current primitives and tool contracts](references/primitives-and-tools.md) before suggesting a design. The MCP accepts typed questions, a finite authored sequence/graph over inline material and distinct respondent profiles, and follow-on requests built from queried evidence or exact evaluation/context references. It records only the turns each respondent actually reaches. Journey recall provides evidence; the agent authors and submits the next request explicitly.

## Design conversation

1. Establish the artifact or exact material, what the person wants to learn, and what decision the answer should inform. When the person already knows the question, preserve it and move on. Ask focused questions only for missing information that would change the design.
2. Choose material units that answer the user's question. If they ask which “bit” loses interest, recommend an explicit unit such as sections or paragraphs; Sheg does not infer editorial boundaries. Preserve exact source wording in each included item.
3. Choose a typed question that returns useful evidence: Choice selects among authored candidates, Score records a position on an authored ordered rubric, or Noul records a probability. For a material-selection Choice, author exact candidate items, make each linked option label equal its candidate text, and map the option ID to the material ID with `materialOptions`. Keep no-fit unlinked and include `unanswerable` when information may be insufficient. Use a direct poll when one question answers the need; use a journey when the user needs staged exposure or dependent questions, following the order rules below.
4. Propose the distinct respondent perspectives needed to cover the meaningful differences in the user's decision. Explain why each perspective matters. Profiles are modeled perspectives, not real participants or independent human samples; they are the source of respondent-profile variation in the study.
5. Present the proposed question, exact material unit, respondent profiles, typed response semantics, provider, and maximum calls in ordinary language. Revise with the person until they agree this focused design covers the perspectives and input differences they need to understand. Treat `maxCalls` as a cap on physical provider attempts, not as a respondent count; batching, splits, and retries affect call use. Do not promise a call total per respondent until the provider execution shape is known.
6. Build the strict direct request or finite journey. Use `run_inspect` when a fit preview would help; `run_start` performs admission validation itself. Resolve invalid input or fit issues without silently changing the text or question. For a hosted Jev run, obtain the person's authorization for inference and its call bound before calling `run_start`.
7. Start with a fresh UUID submission ID and keep the returned run ID. Explain the machine-readable answers, status, and counts using the user's original question as the frame. Report pending and failed evaluations alongside completed answers.

## Journey order and history

Choose the journey shape from the order the user wants. A sequence exposes all of its items in order before asking its tasks: `A, B, C, then Q_A, Q_B, Q_C`. It does not pair each item with its own question. For `A, Q_A, B, Q_B, C, Q_C`, use a graph with interleaved expose and ask turns, even when every respondent follows the same straight route. Use a graph too when an answer chooses the next turn. A branch sees only the material exposed along that respondent's reached path, not material from an unvisited sibling branch.

Name material and answer history separately. Each question receives the exact text of every distinct item exposed so far on that respondent's path, in first-exposure order. If A is exposed, then B, then A again, a later packet includes A then B once each; the journey still records both exposures to A. On each task, `responseHistory: include` includes earlier typed answers and `responseHistory: omit` leaves them out. Omitting answers never removes previously exposed material.

## Follow-on questions

Use `run_query` and `run_get` to select evidence and author the next question. A mapped Choice includes exact `selectedMaterial` evidence. Follow-ons can reuse a saved context, append its answer, or isolate selected material with no prior trajectory. For “give each respondent the paragraph they selected,” use `context.includeSelectedMaterial` in one follow-on. Read [run and recovery](../stimulus-response-polling/references/run-and-recovery.md) for the context modes, selection shapes, and coverage rules.

An interrupted run can be resumed explicitly with `run_resume`; the original run ID, request, and physical-call ceiling remain in effect. A read never starts or resumes work. If the user asks to stop an active run, call `run_cancel`; a provider call already in flight may settle and its answer will be retained.

The agent should interpret Sheg's results for the person. Report modeled responses as descriptive evidence, not human behavior or causal proof. Never invent demographic categories or claim representativeness beyond the profiles that were supplied.
