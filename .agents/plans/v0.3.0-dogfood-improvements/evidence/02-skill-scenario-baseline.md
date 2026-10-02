# Skill behavior scenario baseline

This checkpoint records six controlled skill behavior scenarios. Four have v2 guided traces, `selected-material-isolation-no-fit` and `typed-answer-failure` have corrected v3 traces, and `changed-rubric-comparison` remains v1 because neither its fixture nor supplied guidance changed. Matched no-guidance controls were run where a miss or disputed judgment could test whether behavior was guidance-specific. These trials are observations, not estimates of general agent behavior.

The candidate plugin archive contains 27 files and excludes skill-local test trees. Its SHA-256 is `B03EC58273AF6B0C664D9B8A6043953133608B1045CDED515D143C54B4B69876`.

## Trial method and limits

- Guided actors received the generated owner skill and declared references, the user request, and synthetic controlled evidence. They received no evaluator criteria. Actor prompts prohibited calls to tools, connectors, inference providers, or external services.
- The available Codex subagent route does not expose tool disabling or an independent tool-call audit. Every trace records `toolUseAudit: "not-captured"`. Therefore, the evidence cannot establish that no actor made a tool call. `simulationOnly: true` describes the supplied evidence, not a sandbox guarantee.
- Fresh no-guidance controls used `gpt-6-sol` with medium reasoning. Evaluators ran in separate fresh contexts with the scenario, evidence, criteria, and actor trace only. Trace records preserve the observed output, including format and action-contract violations.
- The harness checks scenario/evaluator pairing, prompt boundaries, schema-valid evidence fixtures, and current guidance hashes. A baseline is limited to these cases and this model configuration.
- No Portfolio article, retained run, credential, paid provider call, or intentional live inference was part of the campaign.

## Results

| Scenario | Guided result | Matched control | Reading |
| --- | --- | --- | --- |
| `sequence-versus-linear-graph` v2 | 3/3 pass | Not needed | The actor recommends one ordered journey, makes earlier exposure and answer history explicit, and calls for preview and recorded-turn checks before relying on runtime behavior. |
| `independent-dependent-questions` v2 | 2/3 pass | Also omitted no-fit | The actor stages the dependent follow-up around each selection but does not preserve a no-fit/unanswerable path. The control also omitted no-fit while asking for exact paragraph text before proceeding. Its output missed the requested JSON wrapper. |
| `selected-material-isolation-no-fit` v3 | 2/4 pass | 3/4 pass | Both actors map each selecting respondent to their own paragraph and preserve no-fit. The guided actor proposes unsupported batch-shaped `run_inspect` and `run_start` inputs; the control claims it can set up per-respondent follow-ons without labeling the feature gap. The current contract accepts one request at a time. The schema-valid fixture represents the current query result, including omission of `selectedMaterial` for no-fit. |
| `partial-run-selected-question` v2 | Evaluator 2/3; one disputed criterion | 3/3 pass | The guided actor scopes B to one completed Q2 answer and reports one unreached respondent. It says “0 are pending.” The evaluator called that unsupported; manual inspection finds it inferable because both returned Q2 rows are present (`totalMatches: 2`) and have explicit `answered` and `unreached` statuses. Do not generalize this selected-query count to overall run status. |
| `typed-answer-failure` v3 | 2/3 pass | Prior control reports code and paraphrases message | The actor separates failure from a substantive answer and reports the 1/2 answered, 1/2 failed counts, but omits `invalid_answer`. The revised criterion requires the code and accurate safe-message meaning; exact wording is optional. The prior control's paraphrase plus code satisfies that criterion, so this is not yet evidence of a guidance-specific regression. |
| `changed-rubric-comparison` v1 | 3/3 pass | Not needed | The actor separates the constructs, avoids a winner/causal claim, reports 9/10 under the new rubric only, and recommends a matched comparison. This is positive evidence for current interpretation guidance. |

The typed-failure criterion changed from exact safe-message wording to code plus faithful meaning, with exact wording optional. The guided actor still misses because it omits the code; the control reports the code and paraphrases meaning, passing all criteria. Two fresh selected-material evaluators initially disagreed about the current-limit criterion. Manual adjudication follows the criterion's full text: the actor must offer a valid current workaround or label the feature gap. The guided actor and no-guidance control both fail that criterion; only the guided actor also fails the executable action-shape criterion.

## Follow-up evidence

- The selected-material v3 matched no-guidance control and its separate fresh evaluation are captured in the trace. Repeat this comparison after guidance changes, since one observation per condition is a baseline only.
- Improve the campaign runner so it can prevent or independently record tool use. Until such a capability exists, keep `toolUseAudit: "not-captured"` and do not describe prompt instructions as enforced isolation.
- For guidance changes prompted by these results, run at least five fresh-context trials for affected scenarios and manually inspect every failed or disputed result.
- The sequence case tests recommendations and caution; it does not prove runtime equivalence between journey forms. The selected-material case does not test the future one-run-per-selection feature.
