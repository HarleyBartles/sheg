# Primitives and tool contracts

An MCP request supplies distinct respondent profiles, exact inline material, typed Choice/Score/Noul questions, a provider, and a physical-call bound. Polls and follow-ons may group independent questions over the same state. Finite journeys provide staged exposure and answer-dependent routing. The [run request schema](../../stimulus-response-polling/assets/run-request.schema.json) defines the accepted shapes.

| Tool | Purpose |
| --- | --- |
| `run_inspect` | Validate a request, measure initial journey inputs, explain reached-turn fit checks, and report call bounds without inference or run creation. |
| `run_start` | Persist an admitted request and launch its worker; reuse an identical submission ID/request without launching again. |
| `run_list` | Discover and paginate durable runs by status, label, time, or referenced material. |
| `run_get` | Read status, request, answers, journey, one exact context, or physical attempts using its `view`. |
| `run_query` | Filter evidence and return exact evaluation/context handles, coverage, and mapped selected-material references. |
| `run_cancel` | Prevent the next dispatch while allowing an in-flight call to settle. |
| `run_resume` | Explicitly resume eligible stopped work under its original request and call allowance. |
| `run_delete` | Preview or delete an explicit selection of inactive runs. |
| `run_storage` | Inspect compatibility/integrity, optimize healthy storage, or explicitly reset a datastore requiring recovery. |

Reads may reconcile expired worker ownership but never launch or resume work. A progressing source can gain new query matches. See [run and recovery](../../stimulus-response-polling/references/run-and-recovery.md) for inputs, pagination, lifecycle, and recovery behavior.

## Request design

The agent owns question meaning and material granularity. If the user asks which part loses interest, define an explicit unit such as sections or paragraphs. Preserve exact text; Sheg does not decide editorial boundaries.

Choice selects one stable option ID with an authored meaning. Score uses an ordered rubric; Noul returns a probability for a proposition. Match the response type to the information needed. For material-selection Choice, use `materialOptions` to link option IDs to exact candidate items. Linked labels must equal candidate text, and candidates require author-supplied source identity/digest. Keep no-fit unlinked. These metadata support traceability; Sheg does not authenticate the external source.

For a matched stimulus comparison inside one journey, use an explicit graph `fork` at the boundary the user cares about. Every respondent who reaches the settled fork is copied into every authored condition, so the same prefix is paid once and each condition gets isolated exposure and response history. Give semantically equivalent questions in the conditions the same `comparisonKey`; keep task IDs distinct and hold instructions, response type, choices or rubric, and answer-history policy constant. Use separate runs only when the user wants separate execution populations or a different study design. Automatic provider selection resolves a common provider/model for each same-key branch comparison before dispatch; when only one condition includes pixels, the common capability need can make Clef the appropriate route for both. An explicit provider remains a user-controlled fixed choice. Fork fan-out is included in the same run-wide `maxCalls` allowance.

Each logical evaluation has a frozen packet and stable identity. Independent questions share the respondent-visible state and never see sibling answers. Jev can batch fitting questions while Laya sends singleton requests. Physical attempts, including retries and uncertain dispatches, count against `maxCalls`; answer rows do not measure call use or input diversity.

A fresh UUID submission ID identifies one exact request. Reuse it only when retrying the unchanged submission; a changed request needs a new ID.

## Follow-on evidence

Query recorded answers or route outcomes, select exact evaluation/context references or supported criteria, then author the next question. The context mode determines which material and answer history the new request receives. A mapped Choice exposes exact selected material for reuse. Read the selection and context rules before composing a follow-on; Sheg does not infer relevance or write the question.

Completed, failed, pending, and unreached evaluations describe coverage. A malformed answer does not hide independent sibling results. Shared provider failures stop later dispatches, and uncertain calls consume allowance without inventing answers. Interpret outputs as modeled responses to the supplied inputs, not observed human behavior or population prevalence.

Read `run_get` with `view: "journey"` for `forks`, `forkMembers`, and `comparisons`. A comparison is keyed by its fork, respondent, `comparisonKey`, and matching occurrence. It reports total, complete, and incomplete pair counts plus each member's condition, status, branch, evaluation, packet fingerprint, provider/model evidence, and failure or result. A repeated question occurrence can make `totalPairs` exceed the number of cohort respondents. Do not describe incomplete or unreached members as negative answers, merge provider confidence as if it were a common scale, or call the modeled pair a human-reader result.

## Article image placement and reading flow

Use a whole-article poll when comparing hypothetical image positions with all five sections supplied in every question. Freeze the exact text materials in order as `section-1` through `section-5`; keep `article-image` separately bound with factual authored `altText`, exact caption, and saved asset metadata. Pixel mode sends the caption as structured visual-material metadata but does not render it into the article layout; state the intended image and caption position in each task. Do not duplicate the caption as article text unless it is intentionally part of the authored article stimulus. Name candidate boundaries such as A after Section 1, B after Section 3, and C after Section 4.

Author 15 independent Noul tasks: five dimensions at each point, relevance, continuity, distraction, comprehension, and expressed interest in continuing. For example, `{ "type": "noul", "id": "interest-at-b", "instructions": "Given the complete article and illustration hypothetically placed after Section 3, would this reader want to continue into Section 4?", "criteria": { "true": "The reader would choose to continue into Section 4.", "false": "The reader would choose not to continue into Section 4." }, "visual": { "mode": "pixels", "materialIds": ["article-image"] } }`. Give every position-dimension combination a distinct task ID. Keep article, image, profile, and pre-question history fixed; vary only the stated location and corresponding adjacent section. Independent questions share one frozen state and never see sibling answers. Query each `questionId` with `run_query` or read typed outcomes with `run_get` using `view: "answers"`.

The model sees all five sections even at Point A. This is a modeled response to a fully supplied article with a hypothetical image location, not first-encounter continuation, measured comprehension, or observed reading behavior. A comparison across positions also changes which section follows the image, so it does not isolate image presence from adjacent content.

For an image-present/image-absent question at one boundary, stage the journey instead: expose Section 1 then ask continue/stop; only continuers see Section 2 and its gate, then Section 3 and its gate. Fork only those who choose continue after Section 3. The image branch binds the saved image in pixel mode before the exact Section 4 text; the text-only branch presents the same Section 4 without the image. Give the matched Section 4 tasks identical instructions, true/false meanings or Choice options, `responseHistory`, and one `comparisonKey`, such as `section-four-interest`. Use a Choice question with `continue` and `stop` when the answer routes the branch to Section 5; route each branch from its own answer. If the caption is part of the image treatment, attach it to that image material and state that the comparison tests image plus caption; do not repeat it as Section 4 copy.

The compact carried meaning after a visual branch is a fact such as: “After Section 3, this respondent chose to continue. At the boundary they saw the supplied image described by the agent as ‘a yellow flower in an orange pot.’” This is illustrative semantic history, not a literal packet format. Pixel bytes are resent only when a later task binds the image again. Use `providerSelection: {}` when Sheg should select among configured providers; a matched image/no-image key keeps provider and model aligned across both branches, so a pixel capability can route both to Clef. Inspect with the real cohort and asset before setting `maxCalls`: if each prefix gate is one call per respondent, estimate three times cohort size plus two calls per reached fork member, add reached Section 5 calls, then use the measured fit and minimum-call plan plus retry allowance. Read `run_get` with `view: "journey"` for reached membership, complete/incomplete pair coverage, branch results, packet fingerprints, and provider/model evidence. Failed, pending, and unreached members are not stop choices.

For rendered-page and character-design recipes, including direct four-way selection versus isolated pairwise evidence, read the [visual study recipes](../../stimulus-response-polling/references/visual-study-recipes.md).
