---
name: study-design
description: Use when helping a person turn text and a question into a supported Sheg respondent study, including task design, respondent perspectives, and journey planning.
---

# Design a study with Sheg

Start from the person's material and what they want to learn. Sheg's tools and
contracts are the means to run a study; the person should not need to know the
graph format or provider internals to describe the study they want.

Before recommending a design, read [Sheg's primitives and tool contracts](references/primitives-and-tools.md)
and [packet budgeting](references/packet-budgeting.md). These references are
the static capability guide. Do not call a tool just to discover what Sheg
supports.

## Design conversation

1. Establish the text or other bounded stimulus, the question the person wants
   to answer, and whose perspective would make the answer useful. If the goal
   is vague, ask focused questions before drafting tasks.
2. Propose a study in ordinary language. Describe what a generic respondent
   sees and is asked, what choices can change their route, what material is
   revealed on each route, and where each route ends. Questions can measure
   any supported typed response; reading mode or interest is an ordinary
   Choice task when that is the desired measure, not a Sheg-specific study
   type.
3. Recommend useful respondent archetypes, a cohort size, and a weighting.
   Explain the perspectives each archetype contributes. The human can accept,
   adjust, or propose archetypes and weights. Expand accepted archetypes into
   distinct stimulus-specific profiles, or let the human steer those profiles.
   Keep the cohort separate from the study: the same frozen cohort encounters
   each matched arm.
4. Revise the human-language design with the person until they approve it.
   This is the design approval point. Do not require them to approve a graph,
   validation, or journey-preview tool call afterward.
5. Translate that design into Sheg's contracts. Preserve the person's stimulus
   and question wording. If the design requires a feature Sheg does not support,
   say exactly what cannot be represented and offer a supported alternative;
   get agreement before changing the question being studied.
6. Validate the authored manifest and call `poll_preview` before cohort
   construction. Show the preview as one generic respondent's full journey,
   including every branch, current stimulus scope, route-specific prior typed
   responses and their meanings, question, offered choices or threshold
   intervals, destination, and shared
   continuation. A shared question appears once, with a separate route context
   for each way of reaching it. Each route context identifies the Choice option
   or typed interval path, prior response meanings and their exposed stimulus IDs, and the stimulus IDs
   currently in scope at the question; stimulus node IDs resolve to their full
   authored text in the same preview. The preview needs no cohort and makes no
   inference call. It rejects a study above 10,000 route contexts instead of
   returning partial results. This is an inspection step, not another approval
   gate.
7. Build and discuss the cohort with the human. Use `poll_check` to validate
   the exact manifest, cohort, and run settings. Use `poll_measure_packets`
   while iterating on selected respondents, stimuli, tasks, or histories. When
   the design and frozen cohort are ready, use `poll_preflight` to measure
   every reachable packet on every possible route for the configured provider
   or providers. Explain fit and limitations in terms of provider assumptions,
   then report the reachable call range and configured maximum calls.
8. Before `poll_start`, present the provider, distinct respondent and arm
   counts, reachable call range, and configured call limit. The human approves
   the run. Start it only after that approval. Use
   status and report tools to inspect outcomes, then interpret the evidence
   against the person's original question and material with your own judgement.

## Choose the smallest useful journey

Use the user's question to decide how much study structure is needed:

- A short CV paragraph and a question about professional versus casual tone
  usually needs one typed task and a cohort of hiring-manager perspectives.
- To learn where readers stop in a five-section article, propose a staged
  journey that exposes one editorially chosen section at a time and asks
  whether each respondent continues, leaves, or is satisfied. Only respondents
  routed onward receive the next section. Report each stage against the full
  frozen cohort denominator.
- To compare whether readers open an inline aside or return to it later, use a
  designed conditional journey because later questions depend on earlier
  choices.

The agent and human own editorial cuts and semantic beats. Sheg can recommend
chunk sizes for provider/token constraints and preflight the exact packets; it
does not infer article structure or silently rewrite the artefact.

## Continue the next question

After a run, state what the report records, give the editorial interpretation
for this artefact, and propose the next most useful question. Discuss the
follow-up's respondent scope and history separately:

- Continue only respondents who qualify or chose to continue inside the same
  journey, optionally including each respondent's own prior responses.
- Ask the full frozen cohort another task in that journey while setting that
  task's `responseHistory` to `omit`.
- Start a separate run with the same frozen cohort and fresh respondent
  histories when changing a stimulus or question. Compare the runs with
  `poll_compare_runs` when task keys and meanings align.

These are choices in one Sheg study system. Propose two-arm control only when
it helps answer the person's question. Keep design changes and result
differences visible; do not label a simulation as a causal result.

There are two human approval points in this workflow: approval of the
human-language study design and approval to start the respondent run. Cohort
proposals and results are collaborative conversation, not additional formal
gates. Do not lecture the person about simulation; explain a limitation when it
changes what Sheg can represent or what the result means.

## Keep the design and cohort distinct

The study fixes the stimulus, tasks, response choices, and route rules. The
cohort varies who takes that same study. A study can therefore measure reading
mode, perceived interest, comprehension, or another supported dimension by
asking a task with the appropriate typed choices at the desired point. Do not
silently treat one measured choice as a proxy for a different concept.

An archetype is a useful proposed lens, not a mandatory catalogue choice. An
agent can recommend archetypes and a weighted expansion, accept a human's own
archetypes, or work out the lenses together. Keep every concrete profile
distinct, relevant to the study question, concise, and within the shared
profile limits in the cohort guide.

## Tool sequence at a glance

- Static capabilities: read this skill and its references; no tool call.
- Draft task fit: `poll_measure_packets`; no inference call.
- Show all branches and route context before cohort construction: `poll_preview`;
  no cohort or inference call.
- Validate the exact study, frozen cohort, and run settings: `poll_check`; no
  provider call.
- Check the complete frozen-cohort journey: `poll_preflight`; measurement only,
  no inference call.
- Run after approval: `poll_start`; this starts inference.
- Follow and interpret: `poll_status`, `poll_report`, and where appropriate
  `poll_compare` or `poll_compare_runs`.

For exact inputs, outputs, route behavior, and provider semantics, use
[primitives and tools](references/primitives-and-tools.md). For packet contents
and fit limits, use [packet budgeting](references/packet-budgeting.md).
