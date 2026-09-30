# ADR-0011: Share packet assembly and expose deterministic study preview and sizing

- Status: Proposed
- Date: 2026-09-30
- Supersedes: None

## Context

Agents need fast, deterministic feedback while turning a human-language study
design into executable Sheg contracts. The existing whole-study preflight is
valuable after a design and cohort exist, but it is too coarse for comparing
draft tasks, respondent profiles, stimulus scopes, and trajectory histories.
Agents also need a human-readable view of every journey branch without
requiring a frozen cohort or an inference provider. Finally, a pre-run check
should report how many respondent decisions the configured call cap permits
and the maximum configured Jev spend, without calling that maximum an expected
bill.

Measurement must match execution: if its packet compiler differs from the
runner's, token-fit results can drift from the actual request. Tool descriptions
must also make variant-pairing behavior explicit so agents can select the
intended cases without probing the tool.

## Options considered

- Keep only exhaustive whole-study preflight. This preserves one fit operation
  but makes early task and profile iteration require a complete design and
  cohort.
- Add a separate packet-size approximation. This is easy to shape but risks
  diverging from the executed request and trajectory semantics.
- Share the canonical decision-packet compiler, add a bounded measurement
  operation over caller-supplied variants, and add a separate deterministic
  preview from validated arms. Keep exhaustive preflight as the final all-path
  check.

## Decision

Use the same `compileDecisionRequest` path for execution packets and for
`poll_measure_packets`. The sizing operation accepts respondent perspective,
stimulus-in-scope, Choice-task, and trajectory variants. `paired` combines
same-index values, broadcasts singleton dimensions, and rejects unequal
multi-valued dimensions. `cartesian` returns every combination. Enforce the
case and serialized-input byte limits before measurement; return either a
complete result or an error. Provider measurement may estimate or measure
context, but it never calls inference.

Add `poll_preview` to show every validated sequence or graph route independently
of cohort construction and provider configuration. Represent shared
continuations once while retaining their incoming route references and authored
stimulus, task, choice, and destination details.

Extend `poll_check` with deterministic minimum and maximum decision-call
bounds over the validated study and frozen cohort. Compare the maximum to the
configured `maxCalls`. For Jev, report a configured ceiling bounded by both
`maxUsd` and `maxPerCallUsd` across the capped calls; actual charges remain the
provider-reported usage after inference.

The study-design skill and references document product capabilities and tool
contracts. Do not add a capability-list MCP tool. Choice is the only executable
task response today. Score, Noul, threshold routing, and model-driven study
optimization remain future work.

## Consequences

- Draft packet checks can be performed before a full study and cohort exist,
  and can identify provider-specific fit and largest cases.
- All-path preflight remains necessary for the complete frozen cohort; draft
  measurements do not imply that every journey fits.
- The same packet semantics drive inference and fit measurement, and the
  prompt-contract hash remains unchanged by routing the current compiler
  through the shared assembler.
- Packet sizing is bounded to 1,000 expanded cases and 16 MiB of serialized
  packet inputs per call. A request over either bound fails before provider
  measurement.
- Jev fit remains an estimate with a 20% reserve; Laya fit depends on the
  configured pinned tokenizer, limits, and checkpoint compatibility.
- Journey preview needs no cohort or provider. It shows the complete generic
  route structure, not a predicted respondent's choices.
- Run-call bounds are deterministic ranges. The Jev amount is a cap, not a
  probabilistic or expected charge.
- The skill teaches supported study design; it does not make graph authoring a
  prerequisite for the human's conversation with the agent.
