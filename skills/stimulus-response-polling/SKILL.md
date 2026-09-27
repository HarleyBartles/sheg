---
name: stimulus-response-polling
description: Use when designing a bounded text stimulus and typed-question study, building distinct respondent profiles, validating or tracing an arm, running matched A/B arms with Jev or a configured local System One model, or interpreting per-task response evidence.
---

The study unit is a bounded text stimulus, a task with typed response options, and a frozen set of distinct respondents. A study has one or more arms. Each arm couples its stimulus sources, ordered items, tasks, and presentation mode. A run applies every respondent to every arm once. Repeating the same respondent, stimulus, and task is not a larger or more independent sample.

| User goal | Read before acting | Tools |
| --- | --- | --- |
| Write or review archetypes, expand them into stimulus-specific respondents, or author respondents directly | [Archetypes and cohorts](references/archetypes-and-cohorts.md), plus its linked archetype, respondent, and cohort schemas | `poll_check` after cohort authoring |
| Design tasks, validate provider context fit, or inspect a route | [Prepare and trace](references/prepare-and-trace.md), the [study manifest](assets/study-manifest.schema.json), and the [respondent cohort](assets/respondent-cohort.schema.json) | `poll_check`, `poll_preflight`, `poll_trace` |
| Start, manage, or recover a run | [Run and recovery](references/run-and-recovery.md), plus [prepare and trace](references/prepare-and-trace.md) for a new run | `poll_start`, `poll_status`, `poll_cancel`, `poll_reconcile`, `poll_resume` |
| Report results or compare arms | [Interpret results](references/interpret-results.md); check `poll_status` if completion is unknown | `poll_status`, `poll_report`, `poll_compare` |

Before using a tool, establish the study question and requested stage. A task defines its response type, instructions, stable option IDs, and optional answer key. Include `unanswerable` when the task can lack sufficient evidence. Never expose answer keys or other arms to the model. Keep arm changes explicit and use shared comparison keys and semantically stable option IDs only when responses should align. Prefer `sequence` for bounded item-then-task studies; use `graph` when conditional exposure or routing is part of the study.

`poll_check` validates and fingerprints inputs; `poll_preflight` measures every reachable packet for each supplied provider; `poll_trace` follows a scripted arm route. None calls the inference provider. Run preflight before choosing a provider for a complete branching study. A trace needs explicit choices for a defined scenario. If choices are missing, ask for them or explain what cannot be established; never invent respondent behavior.

For every new run, validate the exact manifest, cohort, provider, and budgets with `poll_check` before `poll_start`. Before starting, report the provider, arm count, number of distinct respondents, total respondent-arm cells, call limit, output location, and hosted spend caps. For paid Jev runs, require explicit authorization for this study and these caps. Read the run guidance before recommending or starting inference.

The meaningful simulated unit is a distinct respondent-profile, stimulus, and task cell. Provider attempts are retries, not new respondents. A/B comparison is within one run over the same frozen cohort. Reports describe simulated typed responses and optional answer-key scoring, not human readership, statistical significance, causal lift, or real-world accuracy. This skill can guide generic archetype authoring and stimulus-specific respondent creation; it does not rewrite the stimulus text.
