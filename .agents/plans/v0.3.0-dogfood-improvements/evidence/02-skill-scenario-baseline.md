# Skill behavior scenario baseline

This checkpoint records six controlled skill behavior scenarios. Three have v2 guided traces, `selected-material-isolation-no-fit` has a corrected v4 trace, `typed-answer-failure` has a corrected v3 trace, and `changed-rubric-comparison` remains v1 because neither its fixture nor supplied guidance changed. Matched no-guidance controls were run where a miss or disputed judgment could test whether behavior was guidance-specific. These trials are observations, not estimates of general agent behavior.

The candidate plugin archive contains 27 files and excludes skill-local test trees. Its SHA-256 is `B03EC58273AF6B0C664D9B8A6043953133608B1045CDED515D143C54B4B69876`.

## Trial method and limits

- Guided actors received the generated owner skill and declared references, the user request, and synthetic controlled evidence. They received no evaluator criteria. Actor prompts prohibited calls to tools, connectors, inference providers, or external services.
- The available Codex subagent route does not expose tool disabling or an independent tool-call audit. Every trace records `toolUseAudit: "not-captured"`. Therefore, the evidence cannot establish that no actor made a tool call. `simulationOnly: true` describes the supplied evidence, not a sandbox guarantee.
- The human accepted this limitation for the dev.3 baseline: actors were instructed not to use tools, their recorded outputs do not report tool use, and no additional isolation work is required for this checkpoint. Preserve `not-captured` so this acceptance is not mistaken for an instrumented audit.
- If a later campaign needs stronger evidence, the human identified two possible expansions: an immutable hook that records tool use, or a Devin agent profile whose frontmatter disables tools in the runtime. Neither is part of this checkpoint.
- Fresh no-guidance controls used `gpt-6-sol` with medium reasoning. Evaluators ran in separate fresh contexts with the scenario, evidence, criteria, and actor trace only. Trace records preserve the observed output, including format and action-contract violations.
- The evaluator CLI replays the guided actor by default and accepts `--control <one-based-index>` for stored controls. It accepts raw actor output without an embedded scenario ID and rejects a conflicting ID. The selected-material v4 control has a wrong self-reported ID, so its fresh independent evaluation was recorded directly and CLI replay correctly rejects that trace.
- The harness checks scenario/evaluator pairing, prompt boundaries, schema-valid evidence fixtures, and current guidance hashes. A baseline is limited to these cases and this model configuration.
- No Portfolio article, retained run, credential, paid provider call, or intentional live inference was part of the campaign.

## Results

| Scenario | Guided result | Matched control | Reading |
| --- | --- | --- | --- |
| `sequence-versus-linear-graph` v2 | 3/3 pass | Not needed | The actor recommends one ordered journey, makes earlier exposure and answer history explicit, and calls for preview and recorded-turn checks before relying on runtime behavior. |
| `independent-dependent-questions` v2 | 2/3 pass | Also omitted no-fit | The actor stages the dependent follow-up around each selection but does not preserve a no-fit/unanswerable path. The control also omitted no-fit while asking for exact paragraph text before proceeding. Its output missed the requested JSON wrapper. |
| `selected-material-isolation-no-fit` v4 | 2/4 pass | 3/4 pass, 1 uncertain | Both actors map each selecting respondent to their own paragraph and preserve no-fit. The guided actor proposes one `run_inspect` with different nested contexts for p2 and p5; current requests share context/material, so separate requests are needed. The control describes two follow-on requests, but its abstract tool inputs are unverified; its output also mislabels the scenario ID. The fixture now uses one consistent p2/p5/no-fit Choice option set across all respondents. |
| `partial-run-selected-question` v2 | Evaluator 2/3; one disputed criterion | 3/3 pass | The guided actor scopes B to one completed Q2 answer and reports one unreached respondent. It says “0 are pending.” The evaluator called that unsupported; manual inspection finds it inferable because both returned Q2 rows are present (`totalMatches: 2`) and have explicit `answered` and `unreached` statuses. Do not generalize this selected-query count to overall run status. |
| `typed-answer-failure` v3 | 2/3 pass | Prior control reports code and paraphrases message | The actor separates failure from a substantive answer and reports the 1/2 answered, 1/2 failed counts, but omits `invalid_answer`. The revised criterion requires the code and accurate safe-message meaning; exact wording is optional. The prior control's paraphrase plus code satisfies that criterion, so this is not yet evidence of a guidance-specific regression. |
| `changed-rubric-comparison` v1 | 3/3 pass | Not needed | The actor separates the constructs, avoids a winner/causal claim, reports 9/10 under the new rubric only, and recommends a matched comparison. This is positive evidence for current interpretation guidance. |

The typed-failure criterion changed from exact safe-message wording to code plus faithful meaning, with exact wording optional. The guided actor still misses because it omits the code; the control reports the code and paraphrases meaning, passing all criteria. The selected-material v3 trial is retained at `traces/archive/selected-material-isolation-no-fit-v3.json`; its fixture had respondent-specific Choice option sets and was superseded by the schema-consistent v4 fixture. In v4, the guided actor fails the current-limit and proposed-action criteria. The no-guidance actor describes separate follow-on requests and passes the current-limit criterion, while its abstract unverified tool proposals make action validity uncertain. Its wrong self-reported scenario ID is preserved as an output-contract miss.

## Follow-up evidence

- The selected-material v4 matched no-guidance control and its separate fresh evaluation are captured in the trace. Repeat this comparison after guidance changes, since one observation per condition is a baseline only.
- If the campaign later expands to require enforced or independently recorded isolation, use a runtime-level tool-disabled profile or immutable tool-use recording. Until then, retain `toolUseAudit: "not-captured"` and do not describe prompt instructions as enforced isolation.
- For guidance changes prompted by these results, run at least five fresh-context trials for affected scenarios and manually inspect every failed or disputed result.
- The sequence case tests recommendations and caution; it does not prove runtime equivalence between journey forms. The selected-material case does not test the future one-run-per-selection feature.
