# ADR-0003: Use domain-neutral polling primitives and an explicit graph

- Status: Superseded by [ADR-0008](0008-model-stimulus-task-respondent-and-matched-arms.md)
- Date: 2026-09-27
- Supersedes: None

## Context

The first use case is polling readers about Portfolio articles, but this
standalone project is intended to support other content, including novel
chapters and future polling domains. The trial's article-specific concepts
(beats, asides, offers, and scan cards) are useful examples, but hard-coding
them into the harness would make every new domain depend on editorial
terminology.

Journey behavior includes sequential exposure, conditional exposure, early
exit, branching questions, deferred offers, and re-offers. A fixed sequence or
article-specific collection of flags would not express these cases as one
general contract.

## Options considered

- Preserve the trial's article-specific schema and translate other content
  into it. This eases migration of the first use case but makes unrelated
  domains awkward and couples the engine to Portfolio semantics.
- Add a separate schema and runner for every content domain. This keeps each
  domain locally expressive but duplicates execution and evidence behavior.
- Use generic stimulus items, typed decisions, and explicit choice transitions
  between graph nodes. This has a small shared vocabulary while leaving
  domain-specific meaning in the authored content and questions.

## Decision

Represent a study with domain-neutral stimulus `items`, typed `decisions`, and
explicit `transitions` in a directed graph. Graph nodes expose one item, ask
one decision, or end with an authored outcome. Use one provider-independent
walker for all content domains. Do not encode article-specific beats, asides,
offers, or scan cards as engine primitives.

## Consequences

Articles, chapters, and similar material can share the same validated manifest
and execution engine. Authors express optional content, defer/re-offer paths,
and terminal outcomes in their graph. The engine must validate references and
choice edges, record only content actually exposed, and enforce a decision
ceiling so cycles cannot run forever. Authoring a graph requires more explicit
structure than filling in a flat article questionnaire, and the skill must
help authors inspect the actual rendered stimulus for fidelity.
