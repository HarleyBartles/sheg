# Skill behavior scenario baseline

This checkpoint records six controlled skill behavior scenarios. `sequence-versus-linear-graph` and `independent-dependent-questions` have v2 guided traces; `selected-material-isolation-no-fit` has a corrected v4 trace; `partial-run-selected-question` has a v3 trace; `typed-answer-failure` has a v4 trace; and `changed-rubric-comparison` remains v1 because neither its fixture nor supplied guidance changed. Fresh matched no-guidance controls have replayable prompt digests for the four scenarios where controls add evidence. These trials are observations, not estimates of general agent behavior.

The candidate plugin archive contains 27 files and excludes skill-local test trees. Its SHA-256 is `B03EC58273AF6B0C664D9B8A6043953133608B1045CDED515D143C54B4B69876`.

## Trial method and limits

- Guided actors received the generated owner skill and declared references, the user request, and synthetic controlled evidence. They received no evaluator criteria. Actor prompts prohibited calls to tools, connectors, inference providers, or external services.
- The available Codex subagent route does not expose tool disabling or an independent tool-call audit. Every trace records `toolUseAudit: "not-captured"`. Therefore, the evidence cannot establish that no actor made a tool call. `simulationOnly: true` describes the supplied evidence, not a sandbox guarantee.
- The human accepted this limitation for the dev.3 baseline: actors were instructed not to use tools, their recorded outputs do not report tool use, and no additional isolation work is required for this checkpoint. Preserve `not-captured` so this acceptance is not mistaken for an instrumented audit.
- If a later campaign needs stronger evidence, the human identified two possible expansions: an immutable hook that records tool use, or a Devin agent profile whose frontmatter disables tools in the runtime. Neither is part of this checkpoint.
- Fresh no-guidance controls used `gpt-6-sol` with medium reasoning. Each control trace stores the SHA-256 of the exact no-guidance prompt produced by `--control-prompt`; tests recompute that digest from the same versioned request and evidence. Evaluators ran in separate fresh contexts with the scenario, evidence, criteria, and actor trace only. Trace records preserve the observed output, including format and action-contract violations.
- The evaluator CLI replays the guided actor by default and accepts `--control <one-based-index>` for stored controls. It validates wrapper scenario ID and version before selecting an actor, and checks any embedded actor ID/version. Raw actor output can omit identity fields, but any supplied identity must match.
- The harness checks scenario/evaluator pairing, prompt boundaries, replay identity and version, schema-valid evidence fixtures, current guidance hashes, and control prompt digests. A baseline is limited to these cases and this model configuration.
- No Portfolio article, retained run, credential, paid provider call, or intentional live inference was part of the campaign.

## Results

| Scenario | Guided result | Matched control | Reading |
| --- | --- | --- | --- |
| `sequence-versus-linear-graph` v2 | 3/3 pass | Not needed | The actor recommends one ordered journey, makes earlier exposure and answer history explicit, and calls for preview and recorded-turn checks before relying on runtime behavior. |
| `independent-dependent-questions` v2 | 2/3 pass | 2/3 pass | Both actors describe a dependent follow-up that uses the respondent's selected paragraph by itself. Both omit a no-fit or unanswerable option, so the baseline does not isolate that miss to guidance. The refreshed control also recorded two abstract `ask_readers` actions without a no-fit option. |
| `selected-material-isolation-no-fit` v4 | 2/4 pass | 4/4 pass | The guided actor maps each selection correctly and preserves no-fit, but proposes one `run_inspect` with different nested contexts for p2 and p5; current requests share context/material, so separate requests are needed. The refreshed control describes an individual follow-up for each selected paragraph and excludes no-fit, without claiming automatic per-match expansion. The fixture uses one consistent p2/p5/no-fit Choice option set across all respondents. |
| `partial-run-selected-question` v3 | 3/3 pass | 3/3 pass | Both actors report r1's Q2 choice A and r2's Q2 choice B, scope complete coverage to those two Q2 answers, and keep the source run partial because r1's separate Q1 evaluation failed. This directly pressure-tests selected-question completeness against sibling failure. |
| `typed-answer-failure` v4 | 4/5 pass | 4/5 pass | Both actors report `invalid_answer`, accurately paraphrase the safe message, avoid guessing at the provider cause, and preserve one answered plus one failed evaluation. Both fail the recovery criterion: despite the recorded `usedCalls=maxCalls=2`, they recommend checking whether to resume or retry the same run. The guided trace also records a proposed `run_resume` action. This is a concrete guidance weakness for a later wording iteration; the original allowance is exhausted, so this run cannot resume. |
| `changed-rubric-comparison` v1 | 3/3 pass | Not needed | The actor separates the constructs, avoids a winner/causal claim, reports 9/10 under the new rubric only, and recommends a matched comparison. This is positive evidence for current interpretation guidance. |

The partial-run v2 trace is retained at `traces/archive/partial-run-selected-question-v2.json`; it tested an unreached Q2 respondent and did not cover complete selected-question evidence. The typed-answer v3 trace is retained at `traces/archive/typed-answer-failure-v3.json`; it only summarized the diagnostic and did not ask for recovery. The selected-material v3 trace is also archived because its Choice option sets were inconsistent; v4 is the schema-consistent fixture. The no-guidance controls in the current baseline were rerun from explicit versioned control prompts, and their recorded digests are checked by the harness.

## Follow-up evidence

- Matched no-guidance controls and separate fresh evaluations are captured for the four scenarios where a control adds evidence. Repeat these comparisons after guidance changes, since one observation per condition is a baseline only.
- If a later campaign expands to require enforced or independently recorded tool isolation, the human identified an immutable tool-use hook and a Devin profile with tools disabled as possible options. Neither is available in this checkpoint. Retain `toolUseAudit: "not-captured"`; the human accepted the current evidence level for this development checkpoint.
- The exhausted-budget recovery miss is a candidate for a later targeted guidance iteration. Any behavior-shaping guidance change requires at least five fresh-context trials for affected scenarios and manual inspection of every failed or disputed result.
- The sequence case tests recommendations and caution; it does not prove runtime equivalence between journey forms. The selected-material case does not test the future one-run-per-selection feature.
