# Skill behavior scenario baseline

This baseline records six single-trial guided cases from the current shipped guidance. Two failed cases received a matched no-guidance control. These are controlled simulated scenarios, not evidence of universal agent behavior.

The candidate plugin archive for this checkpoint contains 27 files and excludes all skill-local test trees. Its SHA-256 is `B03EC58273AF6B0C664D9B8A6043953133608B1045CDED515D143C54B4B69876`.

## Trial method

- Each guided actor and evaluator ran in a distinct fresh context using `gpt-6-sol` at medium reasoning.
- Actors received the generated skill and declared references, user request, and controlled mock evidence. They received no evaluator criteria and made no Sheg tool calls.
- Evaluators received one case rubric, controlled mock evidence, and the actor trace. Every failed judgment was checked against the cited response and controlled evidence.
- The no-guidance controls received only the same user request and evidence, with no Sheg skill text. Their evaluators were separate fresh contexts.
- The trace files contain the exact actor/evaluator JSON, supplied guidance SHA-256 values, model settings, and `simulationOnly: true`.

## Results

| Scenario | Guided result | Matched no-guidance result | Reading |
| --- | --- | --- | --- |
| `sequence-versus-linear-graph` | 3/3 pass | Not needed | The actor distinguishes journey form from answer-history semantics and defers equivalence claims pending packet inspection. |
| `independent-dependent-questions` | 3/3 pass | Not needed | The actor proposes a dependent follow-up using each respondent's selected paragraph and preserves no-fit. |
| `selected-material-isolation-no-fit` | 3/3 pass | Not needed | The actor correctly maps each respondent to their exact selected paragraph, states the current per-row expansion limit, and retains no-fit. |
| `partial-run-selected-question` | 2/3 pass; denominator criterion failed | Same criterion failed | Both actors omitted coverage detail, including `pending: 0`. The guided actor did report the overall completed/failed/unreached counts and scoped the returned Q2 evidence. |
| `typed-answer-failure` | 2/3 pass; diagnostic criterion failed | Same criterion failed | Both actors paraphrased the message and omitted `invalid_answer` and the exact safe message. Neither inferred a substantive answer from the failed evaluation. |
| `changed-rubric-comparison` | 3/3 pass | Not needed | The actor separated the constructs, avoided a winner/causal claim, described 9/10 under the new rubric only, and recommended a matched comparison. |

The two controls show that these misses are not isolated to the current Sheg skills in this single run. The diagnostic miss remains a high-value target for the planned precise-failure reporting change. The coverage case remains useful in future skill pressure tests. Re-run both after their corresponding product or guidance changes.

## Limitations

- One guided actor per scenario is a baseline only. A behavior-shaping guidance change requires at least five fresh-context trials for affected scenarios and manual inspection of every flagged result.
- The controls emitted `scenarioVersion` as the JSON string `"1"`, while the guided actor traces emitted a number. The observed control outputs are preserved as returned. Evaluators judged behavior against the scenario facts; the shape mismatch does not change the cited content outcomes.
- The sequence case tests whether the agent avoids conflating linear exposure with prior answer history; it does not prove the runtime's exact history contract.
- The selected-material case intentionally records current runtime limits. It does not exercise the future per-respondent selected-material reuse feature.
- No Portfolio article, retained run, provider, credential, or live inference was used.
