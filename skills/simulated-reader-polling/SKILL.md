---
name: simulated-reader-polling
description: Use when a user wants to author reader archetypes, expand them into poll-specific reader profiles, prepare or validate a frozen cohort, or trace, run, and interpret a simulated-reader poll for an article, chapter, web page, or other study with Jev or a local System One model.
---

Choose the workflow by the evidence the user wants. Mentioning a poll does not by itself ask you to run one.

| User goal | Read before acting | Tools |
| --- | --- | --- |
| Write or review archetypes; expand them into a poll-specific cohort; or author profiles directly | [Archetypes and cohorts](references/archetypes-and-cohorts.md); use its linked archetype, profile, and cohort schemas | `poll_check` after the cohort is authored |
| Validate study inputs or inspect a route | [Prepare and trace](references/prepare-and-trace.md); use the [study manifest](assets/study-manifest.schema.json) and [frozen cohort](assets/frozen-cohort.schema.json) schemas for file shape | `poll_check`, `poll_trace` |
| Start or manage a poll | [Run and recovery](references/run-and-recovery.md); for a new run, also [prepare and trace](references/prepare-and-trace.md) | `poll_start`, `poll_status`, `poll_cancel`, `poll_resume` |
| Report or compare runs | [Interpret results](references/interpret-results.md); check `poll_status` first if completion is unknown, using [run and recovery](references/run-and-recovery.md) | `poll_status`, `poll_report`, `poll_compare` |

Before using a tool, establish the study question and requested stage. Preserve the frozen cohort. `poll_check` validates and fingerprints inputs; `poll_trace` follows a scripted route; neither calls the inference provider. A trace needs explicit choices for a defined scenario. If those are missing, ask for them or explain what cannot be established; never invent reader behavior.

For every new run, validate the exact manifest, cohort, provider, and budgets with `poll_check` before `poll_start`; it makes no inference call. Read run guidance before recommending or starting inference. Before `poll_start`, report the provider, cohort size, call limit, output location, and hosted spend caps. For paid Jev runs, require explicit authorization for this study and these caps; a request to start without specified caps does not supply it. Read result guidance before reporting. Keep graph behavior, simulated judgments, and observed readership distinct.

This skill may author archetypes and poll-specific reader profiles as study inputs. It does not rewrite the user's poll stimulus, such as an article, chapter, or web page; handle those content-writing requests as writing work.
