---
name: simulated-reader-polling
description: Use when a user wants simulated reader feedback on an article, chapter, or other branching study, or asks to validate, trace, run, or interpret a frozen-cohort poll with Jev or a local System One model.
---

Choose the workflow by the evidence the user wants. Mentioning a poll does not by itself ask you to run one.

| User goal | Read before acting | Tools |
| --- | --- | --- |
| Validate study inputs or inspect a route | [Prepare and trace](references/prepare-and-trace.md); also [study inputs](references/manifest.md) when field definitions matter | `poll_check`, `poll_trace` |
| Start or manage a poll | [Run and recovery](references/run-and-recovery.md); for a new run, also [prepare and trace](references/prepare-and-trace.md) | `poll_start`, `poll_status`, `poll_cancel`, `poll_resume` |
| Report or compare runs | [Interpret results](references/interpret-results.md); check `poll_status` first if completion is unknown, using [run and recovery](references/run-and-recovery.md) | `poll_status`, `poll_report`, `poll_compare` |

Before using a tool, establish the study question and requested stage. Preserve the frozen cohort. `poll_check` validates and fingerprints inputs; `poll_trace` follows a scripted route; neither calls the inference provider. A trace needs explicit choices for a defined scenario. If those are missing, ask for them or explain what cannot be established; never invent reader behavior.

For every new run, validate the exact manifest, cohort, provider, and budgets with `poll_check` before `poll_start`; it makes no inference call. Read run guidance before recommending or starting inference. Before `poll_start`, report the provider, cohort size, call limit, output location, and hosted spend caps. For paid Jev runs, require explicit authorization for this study and these caps; a request to start without specified caps does not supply it. Read result guidance before reporting. Keep graph behavior, simulated judgments, and observed readership distinct.

This skill prepares and interprets polls; it does not rewrite authored study material. Handle writing requests as writing work.
