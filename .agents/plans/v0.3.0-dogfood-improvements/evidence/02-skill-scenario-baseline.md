# Skill behavior scenario baseline

This baseline records six controlled skill behavior scenarios. Five scenarios have a fresh v2 guided trace; `changed-rubric-comparison` remains v1 because its fixture and guidance did not change. Matched no-guidance controls were run for scenarios with a missed or disputed criterion. These are simulated scenarios, not evidence of universal agent behavior.

The candidate plugin archive for this checkpoint contains 27 files and excludes all skill-local test trees. Its SHA-256 is `B03EC58273AF6B0C664D9B8A6043953133608B1045CDED515D143C54B4B69876`.

## Trial method

- Guided actors received the generated owner skill and declared references, user request, and controlled mock evidence. They received no evaluator criteria and made no Sheg calls.
- Matched controls received the same request and evidence without the Sheg skill. The v2 no-guidance controls were run in fresh contexts with `gpt-6-sol` at medium reasoning.
- Each v2 actor output was evaluated in a separate fresh context using only the case rubric, controlled evidence, and actor output. Evaluators judged claims and proposed actions from evidence rather than phrase matching.
- All traces are marked `simulationOnly: true`. The guided traces include the exact supplied guidance hashes and model settings. Control traces preserve raw output, including two outputs that did not follow the requested JSON schema.
- Review disputed judgments against the trace and fixture before using them to change guidance. This baseline does not establish universal behavior.

## Results

| Scenario | Guided result | Matched control | Reading |
| --- | --- | --- | --- |
| `sequence-versus-linear-graph` v2 | 3/3 pass | Not needed | The actor recommends one ordered journey, makes earlier exposure and answer history explicit, and asks to inspect compiled and recorded turns before relying on semantics. |
| `independent-dependent-questions` v2 | 2/3 pass | Also omitted no-fit | The actor separates the dependent follow-up and uses each recorded selection as isolated material, but does not preserve a no-fit/unanswerable path. The control also omitted no-fit, while asking for exact paragraph text before proceeding. Its output missed the requested actor JSON wrapper. |
| `selected-material-isolation-no-fit` v2 | 2/3 pass | 3/3 pass | Both preserve respondent-specific material and the no-fit respondent. The guided actor does not state the current one-follow-on-per-selection workaround and proposes an unverified `run_inspect` input shape. The matched control proposes one follow-on per eligible respondent and checks for additional source matches. |
| `partial-run-selected-question` v2 | Evaluator: 2/3 pass; disputed criterion | Same-settings control: 3/3 pass | The guided actor scopes `B` to one completed Q2 answer and reports one unreached respondent. It also says “0 are pending.” The evaluator called that unsupported, while manual inspection found it inferable because both returned Q2 rows are present (`totalMatches: 2`) and have explicit `answered` and `unreached` statuses. Keep the disagreement visible; do not generalize this selected-query count to overall run status. |
| `typed-answer-failure` v2 | 2/3 pass; exact-diagnostic criterion failed | 2/3 pass; also omitted the exact safe message | Both actors separate failure from a substantive answer. The guided actor omits `invalid_answer` and the exact safe message; the matched control reports the code but paraphrases the message. This supports testing precise diagnostic reporting and its guidance after the product contract ships. |
| `changed-rubric-comparison` v1 | 3/3 pass | Not needed | The actor separated the constructs, avoided a winner/causal claim, reported 9/10 under the new rubric only, and recommended a matched comparison. This preserves the positive interpretation case. |

The v2 fixtures remove answer-leading runtime facts from actor context. Partial-run evidence now uses a valid current `runEvidencePageSchema` page; typed-failure evidence now uses current `run_get` status and answers views. The harness verifies each stored scenario version and the actual SHA-256 of every supplied guidance file. Evaluator prompt rendering strips any prior evaluator output from a stored trace before presenting the actor response to a fresh evaluator.

## Limitations

- One guided trial per scenario is a baseline only. After a behavior-shaping skill edit, run at least five fresh-context trials for affected scenarios and manually inspect every failed or disputed result.
- The sequence case tests the actor's caution and design recommendation; it does not prove runtime equivalence between journey forms.
- The selected-material case captures the current runtime gap and a proposed workaround; it does not test the future one-run per-selection feature.
- All four v2 no-guidance control outputs are preserved as returned. They used message/answer wrappers or a domain-specific JSON shape instead of the requested actor trace schema. Their content remains judgeable, and the format failures should stay visible in later harness comparisons.
- No Portfolio article, retained run, credential, paid provider call, or live inference was used.
