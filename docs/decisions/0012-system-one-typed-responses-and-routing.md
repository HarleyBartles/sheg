# 0012: Preserve typed System One responses and route explicitly

## Status

Accepted

## Context

Sheg originally treated every task result as a finite Choice. System One also
supports Score and Noul, and follow-up tasks need to preserve a respondent's
own earlier answers when the design calls for it. Flattening these primitives
to Choice loses their meaning. Making history inclusion implicit in routing
also prevents asking either only continuing respondents or the full cohort
without prior response context.

## Decision

Tasks, requests, journey events, checkpoints, reports, and provider adapters
preserve Choice, Score, and Noul as distinct typed values. Score retains its
expected value, rubric legend, and per-level probability distribution. Noul
retains P(true). Choice manifests without a discriminator remain valid as
legacy Choice input.

Graph routes for Score and Noul use explicit intervals. The intervals must
cover the type's complete domain exactly once, including an explicit owner for
threshold equality. Choice continues to route by stable option ID.

Each task independently controls whether earlier response events appear in
its prompt. The default includes history for compatibility; `omit` removes
prior responses but retains exposure context. Routing independently determines
which respondents reach a task. Respondents only see their own history.

Durable checkpoints use format 3 and continue to read format 2 Choice
checkpoints. Reports compare typed answers only when their authored meanings
align. Independent runs may be compared when they use the exact same frozen
respondent cohort, identified by its canonical ordered profile fingerprint;
this does not require A/B arms in one run. Comparisons preserve declared
archetype and variation group denominators and report source, stimulus, task,
provider, run-status, and completion differences. Unsupported provider/type
combinations fail closed rather than coercing values.

## Consequences

- Every runtime and public contract must retain the discriminator and
  primitive evidence.
- Consumers can use the smallest useful journey, from one bounded cohort
  question to staged continuation or a finite branching graph.
- History passthrough and respondent eligibility remain separate design
  decisions.
- Score and Noul routing requires explicit authoring and validation; there is
  no implicit threshold or default route.
- Simulated reports remain descriptions of model responses, not evidence of
  human readership or causal effects.
