# ADR-0008: Model stimulus, task, respondent, and matched arms

- Status: Accepted
- Date: 2026-09-27
- Supersedes: [ADR-0003](0003-use-domain-neutral-polling-primitives.md), [ADR-0007](0007-guide-archetypes-and-freeze-reader-cohorts.md)

## Context

The project began as a simulated reader journey harness. That is one useful study domain, but the more general product is a system for presenting bounded text to distinct simulated respondents and collecting typed responses to explicit tasks. Comprehension questions, including an `unanswerable` option, are a useful first task. Reader archetypes remain one reusable respondent family, not the scope of every poll.

The earlier graph contract also made graph authoring mandatory for simple passage-question-response studies. A/B testing can compare bounded variants against the same cohort, provided identity and denominators remain explicit and the report does not imply a causal or human-research result.

## Options considered

- Keep the reader-journey product model and treat other tasks as extensions. This retains trial vocabulary as the center of the API.
- Replace the graph with a flat form. This simplifies comprehension studies but cannot express conditional text exposure and early exit.
- Center the contract on stimulus, typed task, distinct respondent, response, and arm. Offer a simple sequence and retain a bounded graph as an optional presentation mode.

## Decision

A study has one or more arms. Each arm owns bounded text stimulus, tasks, and a presentation mode. A frozen cohort of explicitly authored respondent profiles is applied once to every arm in a run. The first response type is finite choice with stable option IDs; optional answer keys are private scoring metadata. `sequence` presents ordered items then tasks. `graph` supports conditional exposure and bounded branching.

An observation is a respondent-task-presentation-arm cell. Provider retries do not create new respondents or response cells. Repeated task presentations after changed context are separate occurrences. A/B comparisons are restricted to arms within one run and align by the same frozen respondent, explicit task comparison key, occurrence order, and shared stable option IDs. Reports show task reach/completion denominators, option distributions, arm changes, and optional descriptive answer-key scoring. They do not claim human accuracy, causal lift, significance, calibration, or readership.

Ship reusable reader archetypes as one family of authoring assets. The skill teaches archetype authoring, study-specific respondent expansion, direct respondent authoring, task design, arm definition, validation, execution, and cautious interpretation. Runtime code validates and executes frozen inputs; it does not generate respondent profiles.

## Consequences

- The manifest is version `2.0`, respondent cohort is `3.0`, checkpoint is `2`, and report is `2`; no compatibility shim is needed before the first PR merges.
- The graph is optional for simple studies. Existing conditional reader journeys remain expressible within an arm.
- All arms share provider configuration and cohort identity, enabling within-run matched comparisons without cross-run pooling.
- The skill and shipped contracts use stimulus-response vocabulary, while reader archetypes and reading journeys remain available.
- System One responses remain simulations, and reports preserve not-reached, incomplete, and completed task denominators separately.
