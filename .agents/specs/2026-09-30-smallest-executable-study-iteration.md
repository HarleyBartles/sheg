# Smallest Executable Study Iteration

- Status: Approved; implementation complete, including review repairs
- Date: 2026-09-30
- Linear issue: SHEG-2
- Related decision: ADR-0008

## Purpose

Define how Sheg helps an agent and its human partner turn the user's next
question about an artefact into the smallest useful executable study, then use
the results to shape the next question. This is an authoring and iteration
workflow over Sheg's study system, not a separate panel engine or a required
two-arm experiment.

The design must preserve typed respondent outputs, respondent-level evidence,
and repeatable studies while keeping study graphs and provider internals out of
the ordinary user's way.

## Product intent

The user brings an artefact and a question they want answered. The agent helps
clarify the question, proposes a cohort that fits the artefact and its intended
audience, and authors the least complex study that can answer it. The user
steers the cohort and the human-language study design. The agent interprets
the resulting evidence editorially and proposes the next useful question.

The agent and human can choose how each follow-up relates to earlier turns.
Journey progression and context carryover are separate design choices. A later
task may use the respondent's own prior responses as context, or may ask the
same respondents a fresh question without showing those responses. Routing can
also restrict a later task to respondents who continued, or send it to the full
cohort. Results preserve both the original cohort denominator and the actual
respondents reached at each task. For example, a staged reading journey can
ask only the 79 respondents who continued after stage one, then only the 67
still interested after stage two, with each seeing their own history. Another
task can ask all 100 respondents a new question with no prior-response
passthrough.

If the next question changes the design or stimulus and should begin without
prior response context, clone the earlier design and reuse its frozen cohort in
a separate run. Each respondent starts that run with a fresh journey. Cross-run
context carryover is never implicit; any such carryover must be explicitly
represented in the new study design. These are two ways to continue one Sheg
workflow, not separate study systems.

## Core design rule

Run the simplest study journey that answers the current question. A one-task
study, a staged linear journey, and a designed branching journey are all
expressions of the same study model. More elaborate study design remains
available when the question needs it; it is not a prerequisite for routine
feedback.

| User question | Smallest fitting design |
| --- | --- |
| Does this CV paragraph sound more professional or casual to hiring-manager respondents? | One stimulus and one typed task over a frozen cohort. |
| At which section do readers stop, and who reaches the end? | A bounded linear graph journey with an editorially chosen chunk and typed continue, exit, or satisfied decision at each stage. Only respondents routed to continue see the next chunk; later tasks receive that respondent's own earlier choices. |
| Do readers prefer an aside inline or offered again at the end? | A designed journey that controls the initial presentation and later offer. |

The agent may propose a more controlled comparison when it would answer the
question better. Two-arm study design is optional. A user can also compare
separate one-design runs without having authored arms in either run.

## Authoring and run flow

1. **Understand the question.** The agent starts from the artefact, what the
   human wants to learn, and the perspective needed to answer it. It asks a
   focused follow-up when those are too vague to author a useful task.
2. **Recommend the cohort.** The agent proposes respondent profiles and a
   cohort size based on the artefact, intended audience, and question. It
   explains the recommendation in human terms and lets the human steer it.
   The final cohort is frozen for the run.
3. **Author the smallest journey.** The agent chooses the simplest suitable
   task and presentation structure. For staged reading, the agent owns the
   editorial cuts in collaboration with the human. Sheg does not infer beats,
   section boundaries, or semantic chunk points.
4. **Check provider fit.** Sheg advises on provider token limits and preflights
   the exact authored packets. It reports fit or overflow and does not
   silently split, truncate, summarize, or rewrite the stimulus.
5. **Run and report.** Respondents execute independently. Each respondent's
   earlier choices inside that run are available to that respondent's later
   decisions; other respondents' answers remain private. A continuing journey
   can ask later tasks only of respondents routed there. The report preserves
   task reach, completion, typed results, and respondent-level evidence against
   the full intended cohort denominator.
6. **Interpret and continue.** The agent tells the user what the run produced,
   separates that evidence from its editorial interpretation, and proposes the
   next useful question. For that follow-up, the agent and human choose whether
   it uses each respondent's prior answers as context, who should reach it, and
   whether it is another task in the current journey or a separate run. A new
   task can target the full cohort with clean context, or be routed only to
   respondents whose earlier answers qualify them. A separate run also starts
   with clean respondent histories unless its design explicitly supplies
   context. The agent may propose a deeper controlled design.

## Typed response contract

Choice, Score, and Noul are first-class task and result types. Sheg does not
ask respondents to generate free text.

- **Choice** selects one stable option and retains the provider's option
  probabilities and any confidence value the provider returns.
- **Score** returns a value on a declared ordered rubric and retains the
  rubric-level probability distribution.
- **Noul** returns the probability that a defined yes/no proposition is true.

Reports preserve the returned type and its evidence. They do not convert a
Score or Noul to a route unless the study declares an explicit deterministic
threshold. A graph may branch on a Choice option or on an explicit Score/Noul
threshold. Score thresholds apply to the numeric score and Noul thresholds to
the probability in `[0, 1]`; threshold equality has one declared route. Graph
validation rejects missing, overlapping, or ambiguous coverage across the
declared output domain.

System One's official SDK types document Choice, Score, and Noul request and
response shapes. Sheg's current contracts, providers, journey events,
checkpoints, reports, and deterministic routes preserve all three types.
Adapters validate each response against its authored task. Jev uses the
OpenRouter Decisions API and Laya uses its local HTTP contract; deployment
compatibility remains provider-specific. See the [TypeSafe SDK type
definitions](https://github.com/typesafe-ai/typesafe-sdk-js/blob/main/src/types.ts)
and `docs/providers/` for wire evidence and configured-service limitations.

## Study, run, and comparison model

- A run records one immutable study design, one frozen cohort, one provider
  configuration, and the resulting independent respondent journeys. A single
  arm is the normal shape for the smallest study. Within that run, a graph may
  route each respondent to later tasks based on that respondent's typed
  responses; respondents who take terminal paths do not receive later tasks.
  Each task explicitly defines whether prior respondent responses are included
  in its prompt history. The default policy must be clear in the authored
  contract, and a task can suppress response-history passthrough while retaining
  the same respondents and journey. Arms remain available when the user
  explicitly wants a controlled within-run comparison.
- A follow-up run can reuse the exact frozen cohort and clone the prior
  manifest, then change its stimulus slicing, task, or other selected variable.
  It starts each respondent with a fresh journey. No respondent-specific
  response history crosses the run boundary unless explicitly authored into
  the follow-up design.
- Reports from separate runs may be compared when they use the same frozen
  cohort snapshot and expose semantically comparable outcomes. Matching
  requires the same respondent IDs and unchanged respondent profiles,
  verified by the cohort fingerprint. The comparison matches respondent-level
  evidence and retains run, task, stimulus, provider, and completion
  differences. It does not claim that unmatched or changed outcomes are
  directly equivalent.
- Run comparison is not gated on an A/B label or two-arm topology. Users may
  ask an A/B question about two comparable one-design runs. The comparison
  operation must not require the runs to contain arms. A two-arm design remains
  an optional execution choice for a deeper study. Comparisons remain
  descriptive simulations; the agent should explain material differences in
  the designs it compares.
- When discussing subgroup patterns, the agent uses declared archetype and
  variation information from the frozen cohort. Sheg must not invent
  demographic categories that the cohort does not define. Report the subgroup
  denominator and response coverage with each result.

Cross-run outcome matching uses an explicit stable task `comparisonKey` to
state that the intended outcome is equivalent across designs. The comparison
also checks typed response meaning: Choice option IDs and descriptions must
align, Score rubrics must have the same ordered meanings, and Noul must ask the
same proposition with the same true/false meanings. If these conditions do not
hold, preserve and show the respondent journeys but do not pool the outcomes
as a matched metric. A changed stimulus exposure may still be intentional and
comparable; report that stimulus difference beside the result.

## Provider-aware stimulus slicing

The agent and human own the artefact and its editorial structure. The agent
chooses ordered stimulus chunks to answer the question. Sheg provides
provider-specific context and token-size guidance, plus exact preflight for
the resulting requests. Provider limits may constrain chunk size, but do not
authorize Sheg to choose editorial boundaries or alter authored text.

For a staged reading journey, each chunk is exposed before the typed decision
that determines whether that respondent continues. If the question concerns a
preview heading, the agent can place the next heading at the end of the prior
chunk while keeping the rest of the authored content unchanged. The report
then records the exposure and choice sequence needed to interpret where
respondents continued or exited.

## Repository seams at approval

The design builds on these live contracts:

- `src/domain/study/arm.ts` groups sources, ordered items, typed tasks, and a
  presentation in one arm.
- `src/domain/study/presentation.ts` supports a `sequence` and an acyclic,
  bounded `graph`. Staged expose/decide behavior uses graph nodes.
- `src/domain/journey/run.ts` records typed response events and compiles each
  decision with that respondent's own earlier history according to the
  per-task `responseHistory` policy. Graphs remain finite and acyclic.
- `src/domain/respondents/cohort.ts` defines a frozen ordered set of distinct
  profiles. The same cohort can be reused by a follow-up run.
- `src/application/reports.ts` reports typed distributions, task
  reach/completion, respondent journeys, within-run comparisons, and
  cross-run comparisons over identical frozen cohorts, including declared
  archetype/variation groups and subgroup denominators.
- `src/entrypoints/mcp.ts` exposes deterministic capabilities, preview,
  preflight, measurement, tracing, reporting, and within-run and cross-run
  comparison operations.
- At approval, the user-facing skill led with manifest, cohort, sequence, and
  graph mechanics, and Sheg lacked a semantic capability catalogue. Plan 3
  updates those surfaces to the question-first workflow.

## Required design changes

1. **Agent-facing study workflow.** Reframe the skill around the user's next
   question and the smallest fitting study. Teach cohort recommendation,
   editorial chunk ownership, typed task selection, provider preflight,
   result interpretation, and user-steered follow-up. Keep graph syntax out of
   routine user interaction.
2. **Typed domain and execution contracts.** Extend task, request, result,
   journey-event, checkpoint, fingerprint, trace, preflight, and report
   contracts to preserve Choice, Score, and Noul semantics. Define explicit
   deterministic threshold routing for Score/Noul while preserving the existing
   Choice path. Regenerate packaged schemas from runtime contracts.
3. **Provider support and evidence.** Verify each supported primitive against
   each provider wire contract, including probability/rubric output and
   thresholds. Fail closed when a provider does not support a requested type.
   Update `docs/providers/` with the verified behavior and limitations.
4. **Cross-run comparison.** Add a comparison operation, exposed through MCP
   and the CLI alongside the existing within-run comparison, for two stored
   runs.
   It must verify the cohort fingerprint and respondent IDs, align outcomes
   only through an explicit stable comparison key and equivalent typed
   meanings, preserve denominators and not-reached/incomplete states, and
   expose per-respondent changes plus cohort-profile groupings with subgroup
   denominators. It must report design/provider differences rather than
   implying they are controlled away. It must work for two one-arm runs and
   must not require an A/B study.
5. **Semantic capability discovery.** Provide the agent with a deterministic,
   human-readable description of supported task types, routing, journey shapes,
   cohort inputs, and provider constraints. MCP JSON schemas remain the
   validation boundary but are not a substitute for this semantic guidance.

## Scope and non-goals

- Do not create a separate panel runner or require a panel/session object for
  ordinary iteration.
- Do not pass respondent choices across separate runs by default.
- Do not require A/B arms to compare compatible one-design runs.
- Do not make Sheg author or semantically segment the artefact.
- Do not add open-text respondent output.
- Do not treat simulated respondent results as measured human readership,
  statistical significance, causal lift, or publication outcomes.
- Do not add cycles to the current graph as part of this design. If a later
  study requires unbounded loopbacks, bound and validate that separately.

## Recommended implementation slice

Deliver the basic iterative workflow over the existing one-study model:

1. Update the agent skill and semantic capability surface to start from the
   user's question, recommend/freeze the cohort, and author the simplest
   suitable one-arm journey.
2. Implement and verify all three typed task/result primitives through the
   domain, each enabled provider, journey state, routing, preflight, and
   reports. Preserve Choice behavior; add deterministic threshold handling
   for Score and Noul.
3. Add cross-run comparison for compatible one-design runs over the same
   frozen cohort, including respondent-level transitions and declared cohort
   profile groups.
4. Demonstrate a fresh rerun by cloning a single-arm design and cohort,
   changing one stimulus or question variable, and comparing the resulting
   reports. Keep previous run responses out of the new respondent packets.

Keep multi-arm A/B authoring as an available deeper design using the existing
arm model. It is not a dependency of this slice. The planning agent may divide
the work if provider verification shows materially different supported
primitives or if the runtime/report changes cannot be reviewed as one coherent
vertical slice.

## Acceptance criteria

- An agent can translate the three example user requests into, respectively,
  one task, a staged sequence of decisions, and a designed conditional journey
  without asking the user to author graph structure.
- The agent recommends respondent profiles and count from the artefact,
  intended audience, and question, then lets the human steer the frozen cohort.
- The agent chooses semantic stimulus cuts; Sheg reports provider-fit guidance
  and validates the exact packets without silently editing or truncating text.
- Choice, Score, and Noul request and result values survive execution,
  checkpoint recovery, reports, and comparison without conversion to free text
  or loss of their probability/rubric evidence.
- Graph routing from Score/Noul is deterministic and only follows declared
  thresholds; invalid or ambiguous routing is rejected before a run.
- Within a journey, each respondent's own earlier typed responses are available
  to that respondent's later tasks. A route can direct only respondents who
  chose to continue to later content and questions; respondents never receive
  another respondent's answers. Reports show stage reach and exits against the
  full intended cohort.
- The agent can recommend either an in-run respondent-specific continuation
  with prior journey context or an independent rerun over the same frozen
  cohort with fresh journeys, and explains why the choice fits the next
  question.
- A follow-up run can reuse the same frozen cohort and an earlier design,
  change a stimulus/task variable, and start with fresh respondent history.
- Two comparable single-arm runs can be compared by respondent and declared
  profile group without requiring a two-arm design. Incomplete and
  not-reached responses remain visible in the denominator.
- A/B design remains available but is proposed only when it serves the user's
  question; it is not imposed by the iteration workflow.
- The report keeps returned typed evidence separate from the agent's
  editorial interpretation and proposed follow-up.

## Implementation notes

Provider-specific wire support and deterministic routing were implemented in
Plans 1 and 2, with exact constraints recorded in `docs/providers/` and
behavior covered by fake-transport tests. A deployment must still use a
matching provider/service revision; inspect those notes before changing an
adapter.

The comparison contract should align outcomes only when their stable task key
and response meanings are equivalent. A changed stimulus segmentation may
alter which exposure a response follows even when the task remains
"continue reading"; preserve the full event paths and let the agent explain
that difference. Do not pool unmatched results or hide a denominator change.
