# ADR-0010: Preflight study context for configured providers

- Status: Proposed
- Date: 2026-09-27
- Supersedes: None

## Context

Study journeys can branch across stimuli and typed decisions. Each request
contains respondent context, task instructions, options, and journey history.
Laya's pinned setup has a 1,024-token input ceiling, while Jev 1.13 publishes a
32K context window. Measuring only one sample request or learning token usage
after inference cannot tell an author whether every possible journey will fit.
The current graph validator also permits loops and branches that do not reach a
terminal node, preventing exhaustive traversal from being guaranteed to finish.

## Options considered

- Keep the current per-request guard and discover later overflow during a run.
  This can waste calls and cannot give an author whole-study provider guidance.
- Sample representative branches. This is cheaper for large graphs but can
  miss a reachable overflowing request, which violates the fit promise.
- Deterministically walk every respondent and every reachable graph choice,
  compile each request, and measure it for each provider. This gives an
  exhaustive answer when traversal and measurement complete, with explicit
  unverified status when they do not.

## Decision

Build a provider-neutral deterministic context compiler and exhaustive
preflight over every respondent, arm, and possible choice path. Preserve the
full journey event log and derive a compact structured history that records
exposure progress and the meaning of prior choices without resending all prior
stimulus text. In graph mode, each request includes stimulus text exposed since
the previous decision; sequence mode retains all items in scope for each task.
Authors can expose an earlier item again when a later graph decision needs its
full text.

Require every graph to be acyclic and every branch to reach a terminal within
`maxDecisions`, so execution and preflight share a finite journey contract.
Require a whole-study fit claim to cover every request. Any overflow makes the
provider ineligible for the complete study; incomplete traversal or unmeasurable
input is unverified and cannot be treated as fit.

Keep provider-specific limits in provider configuration: 1,024 tokens for the
pinned Laya setup and 32K for Jev 1.13. The adapter measures and enforces its own
final request shape. Provider selection remains explicit and stable throughout
a run. Before a cohort is frozen, preflight uses the maximum valid profile
envelope and labels its result provisional; with a frozen cohort it measures
the actual respondents.

## Consequences

- Authors can redesign a study around Laya's limit or use Jev for a longer
  graph when Jev is configured and every request fits.
- The profile contract needs both per-field and aggregate prose bounds, with
  matching generated consumer schemas.
- A graph with loops, an unterminated branch, or a path beyond its decision
  bound becomes invalid instead of relying on runtime `decision-limit` behavior.
- Preflight may require significant work for a graph with many branches. A work
  ceiling may protect the host, but incomplete coverage must remain visibly
  unverified.
- The Jev context ceiling is tied to model identity; moving aliases require
  refreshed limit metadata.
- Provider tokenizer support and final request measurement are prerequisites
  for a green fit result; no approximate count may claim exact fit.
- Larger provider-specific respondent profiles and automatic provider routing
  remain future decisions.
