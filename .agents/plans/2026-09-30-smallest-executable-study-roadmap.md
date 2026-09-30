# Smallest Executable Study Roadmap

This roadmap implements `.agents/specs/2026-09-30-smallest-executable-study-iteration.md` over the existing Sheg study model. Each plan is written just in time against the then-current `main`; only the first plan is detailed now.

| # | Title | Status | Plan File | Commit | PR | Rating | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Typed response primitives and deterministic routing | executing | `.agents/plans/2026-09-30-typed-responses-and-routing.md` | | | | Foundational execution contract: Choice, Score, and Noul from manifest through provider, journey, checkpoint, report, and route validation. |
| 2 | Compatible cross-run comparison | pending | Write just in time | | | | Compare independent runs over the same frozen cohort and only align explicitly equivalent typed outcomes. |
| 3 | Agent-guided iterative study workflow | pending | Write just in time | | | | Make question-first, cohort recommendation, smallest journey, provider fit, interpretation, and follow-up the default workflow. Teach when to continue respondents within one graph journey with their own history and when to rerun the same frozen cohort with fresh histories. |

## Sequencing and boundaries

Plan 1 is a prerequisite for typed report comparison and makes respondent-specific continuation paths explicit within one run. It adds no separate panel runner. Plan 2 adds cross-run comparison without requiring A/B arms. Plan 3 uses those capabilities to complete the human-agent feedback loop, distinguishes in-run continuation (own prior journey context, only respondents routed onward) from a fresh rerun (same frozen cohort, no prior response context), and does not authorize Sheg to choose editorial beats or rewrite the user's artefact.

Write each later plan just in time after the preceding plan's implementation is complete in this worktree. Refresh the live files before writing it; do not pre-design later implementation details from the current tree.

## Handoff notes

- The implementation plan must resolve provider support from current primary wire contracts and behavioral fixtures before enabling a type for Jev or Laya. Current repository adapters are Choice-only.
- The SHEG-1 design plan and spec on the base tree are marked `completed-awaiting-retirement`. Retire them in the first commit of the next substantive implementation slice, after confirming their enduring decisions are represented in current skills and ADRs. Do not make a cleanup-only PR.
- The current workspace is the dedicated SHEG-2 worktree. Before implementation mutation, refresh/rebase on current `main` if it has advanced and report the worktree path, branch, base SHA, and initial status.
