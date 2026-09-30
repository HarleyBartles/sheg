# Study context compilation and provider preflight

- Status: completed-awaiting-retirement
- Date: 2026-09-27
- Related decision: Proposed ADR-0010

This accepted design was implemented by merged [PR #3](https://github.com/HarleyBartles/sheg/pull/3). Keep it tracked through the current completing PR so it remains in canonical Git history; retire it in a successor substantive slice.

## Purpose

Give a study author a practical estimate of which configured decision providers
can run the study before inference begins. The report finds context overflow on
every reachable respondent journey under declared provider settings. It is
planning guidance, with field testing as the next step for a promising design.

The first supported provider ceilings are the pinned Laya configuration's
1,024-token input limit and Jev 1.13's published 32K context window. These are
provider/model limits, not study-wide limits. Preflight measures each rendered
decision request against the selected provider's effective limit.

## Observable problem and repository baseline

The study contract already supports `sequence` and bounded `graph` presentation
modes, respondent profiles, typed choice tasks, and a frozen cohort. The graph
runner follows the respondent's selected option at each ask node and records
exposure and choice events. The current prompt renderer sends every encountered
stimulus text and the complete prior choice list with each request, so requests
grow over a journey.

The provider adapters each send one choice decision per request. Laya has a
fit-measurer hook but no production measurer in the adapter. Jev records
provider-reported input usage after inference, which cannot prevent an oversized
call. The graph validator verifies references and option transitions, but does
not reject cycles or ensure every branch reaches a terminal node. The runner's
`maxDecisions` escape can return `decision-limit`, and does not stop an
exposure-only loop.

Relevant ownership remains in the existing domain boundaries: graph and
respondent contracts in `src/domain/study/` and
`src/domain/respondents/`, path execution in `src/domain/journey/`, shared
request construction and compact state in `src/domain/decision/` or a narrowly
owned application service, and provider-specific measurement/enforcement in
`src/providers/`. Consumer schemas under
`skills/stimulus-response-polling/assets/` are generated from runtime schemas.

## Product behavior

Preflight is read-only and makes no inference calls. The current typed-choice
study contract accepts Jev and Laya provider configurations. It reports
configuration and context fit separately: required settings and hosted
credentials may be present while a study overflows. Availability is unverified
because preflight does not contact a provider. Fit covers every request scenario
in scope under the configured context and request-shape limits.

The result reports an input fingerprint covering the study, frozen cohort or
synthetic profile, and prompt compiler hash. Each provider result reports an
execution fingerprint covering those inputs plus its model or checkpoint and
context settings, including Laya's tokenizer digest. A fit result is not
carried to a changed study, respondent basis, compiler, or provider setting.

With a frozen cohort, preflight evaluates every respondent in that cohort. Before
a cohort is frozen, it evaluates one synthetic profile filling the 1,500-character
aggregate prose allowance. A provisional `fit` describes only this sample's
packets; different valid wording can consume more tokens.

The author may choose a provider with complete configuration and a fitting
study under its declared limits.
Provider selection is fixed for a run and shared across all arms. The run does
not switch providers partway through a journey or silently fall back after a
fit/runtime failure. Jev's configured run and per-call monetary budgets remain
required. Preflight itself does not consume those budgets.

## Deterministic context compilation

The journey event stream is the source of truth. Compaction is a deterministic,
versioned projection of that history; it does not rewrite or discard recorded
events.

Each decision request contains:

- the respondent's bounded five-field perspective;
- the stimulus text explicitly in scope for the current decision;
- the current task instructions and all offered option IDs and descriptions;
- a compact ordered trajectory summary derived from prior exposure and choice
  events.

Stimulus inclusion follows the presentation mode so an author can predict what
the model sees. In `sequence` mode, every stimulus item remains in scope for
each task, preserving the current comprehension-study behavior. In `graph`
mode, a decision receives the full text of items exposed since the previous
decision (or since journey start for its first decision). Older exposure text
is omitted from later packets and represented by the trajectory summary. If a
later task needs an earlier item's full wording again, the graph must expose
that item again before the task. The event log records the repeated exposure.
Preflight and runtime use this same rule. This lets graph authors pace text in
segments and deliberately control the current stimulus window; sequence mode
may correctly be reported as too large for Laya when all items cannot fit.

The trajectory summary states reading progress and preserves each earlier
choice's task identity, selected option identity, and selected option meaning.
It records which stimulus items had been exposed before that choice, without
repeating the full text of every earlier stimulus. Summary metadata records the
number of exposure and decision events represented, the covered event range,
and the compact summary's serialized size. Provider measurement metadata is
retained in preflight/run records: exact tokenizer counts for Laya and estimates
with reserve for Jev. The model-facing progress fields describe what the
respondent has seen and chosen.

The compiler must not use a generative model to summarize history. This keeps
preflight reproducible and avoids adding an unmeasured summarization call. The
graph exposure rule is structural and does not infer relevance from prose or
silently omit text that the author chose to expose for the current decision.

Profile prose retains a 500-character per-field ceiling and gains a
provider-neutral aggregate ceiling of 1,500 characters across the five prose
fields. Runtime validation enforces both. Standard JSON Schema enforces the
per-field ceiling; its `x-validation-rules` records the aggregate rule for
consumers that also run Sheg validation. This bounds pathological profiles while
provider-specific preflight estimates context fit. Provider-specific larger
profile modes and charge-based profile expansion are deferred; they must not
make one frozen cohort differ across matched arms or provider comparisons in
this first slice.

## Exhaustive graph preflight

Graph studies must be loop-free, and every option branch must reach a terminal
node without exceeding `maxDecisions`. Validation rejects a cycle, an
unterminated branch, or a branch that would be cut off by the decision limit.
The journey runner treats reaching a decision limit without a terminal as an
invalid study/runtime error, not a successful journey outcome.

For each arm and each respondent, the walker starts at the entry node with an
empty event history. Exposure nodes add their item to that path's event state.
At each ask node, the walker compiles and measures the exact request that
execution would send. It then follows every offered option's transition,
appending that option's choice event, until each branch reaches a terminal.
Sequence presentations have one deterministic path and are measured at every
task request. The walk preserves distinct path histories even when branches
reconverge at the same node, since their compact summaries may differ.

For every scenario the preflight records the respondent, arm, path, decision
node, provider identity, measured or estimated tokens, effective limit, and fit
result. A provider receives a whole-study `fits` result only after every
required scenario has been evaluated and every request fits. If any scenario
exceeds the limit, the result identifies the earliest failing node on each
affected path and its measured or estimated amount over limit. Reports may show
how many respondent/path scenarios
remain within limits at each decision depth. These are exhaustive counts, not
predictions of respondent likelihood.

If traversal or measurement cannot complete, the result is `unverified`, never
`fits`. The walker defaults to ceilings of 100,000 packets and 16 MiB of
serialized packet data. Reaching either ceiling identifies incomplete coverage
and blocks a fit claim.
For `maximum-profile`, a green result applies only to its named synthetic sample.

## Provider measurement and runtime enforcement

Each adapter owns measurement of its final provider request and applies the
configured provider constraints:

- **Laya:** use the operator-supplied tokenizer asset and digest for the
  configured checkpoint, question/options rendering, declared instruction/head
  limits, option caps, and declared 1,024-token input budget. Missing local
  measurement, a tokenizer digest mismatch, locally detected clipping, or an
  over-limit request rejects inference before the model is called. The local
  sequence builder follows the pinned upstream implementation. The service's
  actual checkpoint and limits remain deployment assumptions to field test.
- **Jev:** estimate the final serialized Decisions API request against the
  configured Jev model's 32K context. Use a conservative one token per three
  UTF-8 bytes estimate, rounded up, and reserve 20% of the published context
  window. Include state, instructions, criteria, serialization, and fixed
  provider framing represented by the adapter's request contract. Report the
  estimate and reserve; this is an estimate, not provider-reported usage or an
  exact tokenizer count. The 32K limit is attached to the pinned model identity;
  a moving alias must refresh model metadata before it can claim fit.

The request compiler and graph walker are provider-neutral. Provider adapters
must not truncate or drop state to fit. Runtime admission repeats the same local
measurement immediately before each inference request. A preflight result is a
planning snapshot under declared settings. The run records a context failure
with the task, measured amount, limit, and reason for field notes and iteration.
It does not silently reroute.

## User-facing report

For each provider, show configuration/availability, fit status, the
model/checkpoint and limit used, and the cohort or provisional-profile scope.
For an overflow, show the request node, respondent/path coverage, measured
tokens, effective limit, and how far through the graph the provider remains
usable. For incomplete measurement or traversal, explain what prevented a
verified result. The user can then reduce or restructure the study for Laya,
or choose Jev for the full study when it is configured and all requests fit.

## Invariants

- The event log remains canonical; compact state is derived and reproducible.
- Every reachable decision request is measured before a provider can be called
  as fitting the complete study.
- A single overflowing request makes whole-study fit false for that provider.
- No inference request silently truncates, drops, or rewrites authored context.
- Preflight and execution use the same request compiler and provider rendering.
- Every graph branch terminates at a terminal node within the declared decision
  bound.
- Provider choice is explicit and stable across a run and its arms.
- Provider-specific token counts and limits never become a universal schema
  limit for stimulus text.
- An incomplete walk or unknown measurement can never be reported as fit.

## Non-goals

- Raising Laya's 1,024-token limit or making GPU hardware change that limit.
- Automatically choosing a provider or changing providers mid-run.
- Automatically rewriting, summarizing, or trimming study content.
- Supporting free-form generated responses; the initial task remains finite
  choice.
- Raising profile limits specifically for Jev in this first slice.
- Claiming that simulated choices are human-reader evidence.

## Validation and implementation handoff

Implementation must prove that the exhaustive walker covers every option path
and respondent, rejects cycles and nonterminal branches, preserves path-specific
history through reconvergent nodes, and stops a provider run before any
over-limit request. Tests must verify that preflight and execution compile the
same packet and use provider-specific limits, including Laya's question-head
and option caps. Consumer schema generation must reflect both profile length
constraints. A deterministic fixture should demonstrate a graph where Laya
overflows on reachable later nodes while Jev's requests remain within 32K,
without making a live paid Jev call.

Live Laya verification uses the pinned local checkpoint and GPU runtime when
available. Jev wire tests use a fake transport; live Jev calls are not required
to validate schema or deterministic fit behavior.

The implementation plan must account for graph validation and runtime changes,
shared compact-state construction, provider measurement contracts, both
preflight modes, generated schemas, report output, and provider documentation.
