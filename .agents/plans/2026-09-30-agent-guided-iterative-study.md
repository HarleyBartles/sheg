# Agent-Guided Iterative Study Plan

**Status:** completed-awaiting-retirement

## Goal

Make Sheg guidance start from the person's artefact and question, recommend a
cohort that fits the intended audience, and build the smallest useful journey.
After a run, guide the agent to report what happened, interpret the result
editorially, and propose the next useful question with an explicit choice
between in-journey history and a clean-history rerun.

## Live code inspection

- `skills/study-design/SKILL.md` begins from question and cohort but still
  treats design approval, preview, and provider fit as a relatively fixed
  study-building sequence. It does not clearly distinguish tasks routed only
  to continuing respondents from tasks asked of the full cohort without prior
  answers, or explain when the next question belongs in a fresh run.
- `skills/stimulus-response-polling/SKILL.md` and
  `references/primitives-and-tools.md` describe typed tasks, response history,
  and cross-run comparison, but the high-level user workflow remains
  manifest-centric and the report row omits cross-run comparison.
- `src/entrypoints/mcp.ts` exposes deterministic preview/check/preflight,
  typed trace, run/report, within-run compare, and `poll_compare_runs`. It has
  no semantic capability operation for an agent to consult before designing.
- Typed task contracts support Choice, Score, and Noul. Per-task response
  history is independent of graph eligibility. Staged continuation is an
  acyclic graph; provider token limits do not determine editorial cut points.
- Cross-run comparison requires the exact frozen cohort and equivalent task
  meanings, reports subgroup denominators from explicit archetypes and
  variations, and does not require matched arms.

## Plan

- [x] Rewrite the study-design skill around artefact, question, intended
  audience, cohort discussion, and the smallest fitting typed task/journey.
- [x] Add the concrete one-task, staged reading, and designed conditional
  journey examples. Keep editorial segmentation with the agent and human;
  describe Sheg's provider/token chunk guidance separately.
- [x] Teach follow-up options explicitly: continue eligible respondents in
  the same graph with their own prior answers, ask the full cohort while
  omitting prior response history, or start an independent run with the same
  frozen cohort and fresh histories. Suggest a controlled two-arm study only
  when it improves the answer to the user's next question.
- [x] Teach result reporting as three parts: what the run produced, the
  editorial interpretation for the artefact, and the proposed next panel
  question. Keep model responses distinct from human-readership claims.
- [x] Add deterministic `poll_capabilities` MCP output that describes typed
  tasks, route shapes, history policy, cohort inputs, cross-run comparison,
  and provider-specific constraints in agent-usable prose/data.
- [x] Update polling and result-interpretation guidance to include semantic
  capabilities, typed result evidence, staged denominators, and
  `poll_compare_runs`.
- [x] Reconcile the approved spec's live-code map and completion status with
  the now-implemented contracts without rewriting approved product intent.
- [x] Make typed Score/Noul route contexts in `poll_preview` visibly typed
  response intervals rather than representing them as Choice option IDs;
  preserve the existing Choice preview fields for compatibility.
- [x] Add MCP capability output tests and run focused skill/MCP tests, then
  `npm run verify`.

## Exit criteria

- Agent guidance starts from the human's artefact, question, and audience, not
  the graph schema or a default full-study recipe.
- It distinguishes response-history context from respondent eligibility and
  presents same-journey continuation and clean-history reruns as independent
  follow-up choices.
- It preserves the agent/human's ownership of artefact meaning and editorial
  chunk boundaries while using Sheg for provider fit.
- MCP capability output agrees with executable task, route, provider, and
  comparison contracts.
- Preview paths distinguish typed threshold outcomes from Choice option IDs.
- The agent can present run outputs, editorial interpretation, and the next
  useful question without treating simulated respondents as human evidence.
