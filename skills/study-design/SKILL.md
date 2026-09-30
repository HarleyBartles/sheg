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
6. Validate the authored manifest and cohort with `poll_check`, then call
   `poll_preview` on the manifest. Show the preview as one generic respondent's
   full journey, including every branch, stimulus reveal, question, offered
   choice, destination, and shared continuation. The preview needs no cohort
   and makes no inference call. It is an inspection step, not another approval
   gate.
7. Use `poll_measure_packets` while iterating on selected respondents,
   stimuli, tasks, or histories. When the design and frozen cohort are ready,
   use `poll_preflight` to measure every reachable packet on every possible
   route for the configured provider or providers. Explain fit and limitations
   in terms of the provider assumptions, then report the reachable call range
   and configured spend ceiling where applicable.
8. Before `poll_start`, present the provider, distinct respondent and arm
   counts, reachable call range, configured limits, and Jev spend ceiling when
   used. The human approves the run. Start it only after that approval. Use
   status and report tools to inspect outcomes, then interpret the evidence
   against the person's original question and material with your own judgement.

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
- Validate exact study and run settings: `poll_check`; no provider call.
- Show all branches: `poll_preview`; no cohort or inference call.
- Check the complete frozen-cohort journey: `poll_preflight`; measurement only,
  no inference call.
- Run after approval: `poll_start`; this starts inference.
- Follow and interpret: `poll_status`, `poll_report`, and where appropriate
  `poll_compare`.

For exact inputs, outputs, route behavior, and provider semantics, use
[primitives and tools](references/primitives-and-tools.md). For packet contents
and fit limits, use [packet budgeting](references/packet-budgeting.md).
