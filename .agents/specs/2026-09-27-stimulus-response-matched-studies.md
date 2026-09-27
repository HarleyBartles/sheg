# Stimulus-response studies with matched A/B conditions

## Purpose

System One Polling supports users who have bounded text and want to learn how a deliberately constructed set of simulated respondents answers a defined task about it. The product model is stimulus, task, respondent, and typed response. Simulated readers are respondents whose task includes reading and reacting to text. A reading journey is one way to present a study, not the product's defining scope.

The first release after this redesign must make a multiple-choice comprehension study practical, including an explicit `unanswerable` response option, and compare A/B study conditions against the same frozen cohort.

## User workflow

1. The user supplies bounded text stimulus and records its source and exact content.
2. The user authors or selects a frozen cohort of distinct respondent profiles. Bundled reader archetypes remain available as inputs for authoring study-specific profiles. The runtime does not generate profiles.
3. The user defines one or more tasks with structured response contracts. The first supported contract is a finite choice, whose options have stable IDs and user-facing descriptions. Comprehension questions may include an `unanswerable` option and may declare exactly one correct option as a hidden answer key when the user wants correctness to be scored.
4. The user defines one or more study arms. A single-arm study is supported; a matched A/B study has at least two arms and evaluates the same frozen profile cohort in each arm. An arm owns its stimulus and its presentation/task flow.
5. The user validates and previews the exact respondent-visible state, then runs under explicit provider, call, and spend limits.
6. The user inspects each arm's response distribution and the matched profile-level changes between arms.

## Normative concepts

- **Stimulus:** bounded text visible to respondents. It may comprise one passage or multiple items. Source references and hashes bind the study to the exact supplied material.
- **Task:** a question or instruction about the stimulus, paired with a declared response contract. First release supports typed choice only.
- **Respondent profile:** one explicitly authored perspective. Cohorts are frozen, ordered, and unique by profile ID. Reader archetypes are a reusable family of respondent archetypes; user-defined archetypes and directly authored profiles remain valid.
- **Arm/condition:** one study variant with its own stimulus and task presentation. A single-arm study has one arm. A/B conditions reuse the same cohort; profiles are matched across arms by stable ID.
- **Response cell:** one respondent profile answering one task presentation in one arm, with the exact exposed stimulus and response history as context. A valid cell contributes at most one recorded response. Provider retries are attempts to complete that same cell, not additional observations. Re-running an identical completed cell is outside the first release and cannot inflate respondent or response denominators. Revisiting a task in a graph after new exposure or response history is a distinct task presentation.

The prompt must receive only the respondent profile, stimulus actually exposed in that arm, prior task responses in that arm, and the current task plus its options. Study purpose, answer key, unexposed content, and other arms are not respondent-visible. Answer keys are scoring metadata and are never sent to the provider.

If a task declares one correct option, its report includes correct, incorrect, and unscored completed-cell counts for that task. If no answer key is supplied, the report omits correctness claims and reports only returned options. An `unanswerable` option is an ordinary selectable option and may itself be the declared correct answer.

## Comparison and interpretation

- A matched A/B run executes each frozen profile once per arm. It reports intended, completed, and excluded profile counts per arm, plus completed response-cell counts per task. These denominators are not interchangeable.
- Reports show per-arm option counts and proportions, and a matched profile-level transition table for stable option IDs shared by the compared tasks.
- The study declares comparison keys for tasks intended to measure the same response across arms. Reusing an option ID across tasks asserts that it has the same response meaning in both arms. Paired option transitions are emitted only for a shared comparison key and shared option IDs. Arm-specific options remain visible in arm distributions and are counted as unpaired; they are never silently treated as equivalent.
- Changing stimulus, question wording, or option descriptions is permitted. The report records arm fingerprints and makes changed fields inspectable. Users must not infer a causal effect for one changed field when multiple fields changed together.
- The provider and model configuration must match for the primary matched comparison. Comparison validation rejects mismatched provider/model configurations; users can still inspect separate reports. It is never presented as an isolated stimulus effect when multiple treatment fields changed together.
- Reports are descriptive outputs for this cohort and provider. They do not claim a representative human sample, human accuracy, statistical significance, real-world lift, or calibration. Repeating identical profile-task calls is not a way to increase sample size. No confidence interval or significance test is introduced.

## Presentation flow

The existing bounded graph remains available inside an arm to express sequential exposure, conditional content, question order, and early exit. A simple passage followed by one question must also be easy to author as a minimal arm flow. Graph traversal and termination bounds remain deterministic. Each question event records one response cell; an early exit means later cells are unobserved, not negative responses.

## Runtime and evidence

- Preserve provider adapters, explicit provider selection, no silent fallback, input-fit checks, spend/call caps, durable checkpoints, resume/cancel, CLI and MCP surfaces, and the portable Codex plugin.
- Provider adapters implement the first typed choice response consistently. A provider's retry is recorded as attempts on one response cell. Malformed choices and distributions are rejected before persistence.
- Stable option IDs, arm IDs, task comparison keys, stimulus/source fingerprints, cohort fingerprint, provider/model identity, and prompt contract version are retained in checkpoints and reports.
- A run can have several arms, each with journeys for the same profiles. A response-cell identity includes respondent ID, arm ID, task presentation occurrence, and rendered request fingerprint. Checkpoint recovery resumes unfinished cells without repeating completed cells. Cancellation preserves completed responses and records in-flight uncertainty.
- The skill teaches the general stimulus-task-response workflow, cohort construction, comprehension tasks including unanswerable choices, matched A/B authoring, preview, execution, and cautious interpretation. It retains reader-journey guidance as one presentation mode.
- The plugin ships normative schemas beside the skill and the build recreates `dist/` from a clean directory.

## Migration and scope

This project has not merged its first implementation. Replace the unreleased `1.0` study manifest, `2.0` reader cohort contract, and report shape in PR #1 with the new contracts. Do not add compatibility shims for these unreleased formats. Update fixtures, tests, documentation, generated schema assets, and distribution together.

Out of scope for this slice: free-text or span responses, ranking/pairwise response types, image/audio/video stimuli, external human-panel recruitment, real-world task execution, statistical inference, provider/model sampling studies, and duplicate-call replication analysis. The contracts should be extensible, but the first release must not advertise unsupported response types.

## Acceptance criteria

1. A user can prepare a one-arm passage comprehension study with choice options including `unanswerable`, an optional answer key, and a frozen cohort.
2. A user can prepare two arms with distinct stimulus/question content and run both against exactly the same frozen profile IDs.
3. Every completed respondent-task-arm cell has one persisted typed response. Retries count only as attempts; they do not add respondents or response cells.
4. The provider prompt excludes answer keys, hidden content, study purpose, and other arms while preserving the profile, exposed material, history, and current options.
5. A/B reports show arm-specific fingerprints, cohort and task denominators, option distributions, matched profile changes only where comparison keys and option IDs align, and explicit unmatched/incomplete counts.
6. Comparisons cannot imply an isolated treatment effect when provider/model differs or when multiple stimulus/task fields changed; reports expose these facts.
7. Durable run behavior, budgets, provider evidence, CLI/MCP parity, plugin packaging, generated contracts, and clean `dist/` behavior continue to pass the repository gate.
8. The installed skill and docs define the unit of observation as a distinct profile-task-arm cell and explicitly prohibit counting deterministic repeats or retries as additional respondents.
