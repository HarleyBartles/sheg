# ADR-0022: Link offered Choice options to exact source material

- Status: Accepted
- Date: 2026-10-02
- Supersedes: None

## Context

An agent may need to identify which exact candidate made a respondent choose a
particular answer, then ask a follow-on question about that candidate at the
same respondent state. A normal Choice answer preserves the option ID, but
without an explicit link Sheg cannot distinguish a material selection from any
other answer or provide the agent a reusable material identity. Inferring the
link from matching text would be ambiguous and would blur the boundary between
agent-authored units and Sheg's responsibilities.

## Options considered

- Return only the Choice option ID. This keeps answers simple but forces the
  agent to reconstruct the candidate catalog and can select the wrong unit.
- Infer material identity from answer text or labels. This is ambiguous and
  makes material boundaries an implicit Sheg behavior.
- Require an explicit option-to-material mapping in the request and project
  the selected exact candidate into query evidence. This preserves authorship
  and provides a stable follow-on handle.

## Decision

Accept optional `materialOptions` mappings on Choice questions and journey
Choice tasks. Each mapping explicitly links an option ID to one bounded
material ID in the frozen request catalog. The option label must equal the
candidate's exact text, and a linked candidate must include author-supplied
source identity and SHA-256 metadata. Unlinked options, including a no-fit
option, remain ordinary Choice answers.

Query evidence for a linked selection includes `selectedMaterial` with its
material ID, exact text, author-supplied `sourceId` and `sourceSha256`, and a
Sheg-computed SHA-256 digest of the exact UTF-8 text. An agent may pass that
material ID in follow-on `context.materialIds`, together with the selected
evaluation/context handles. The accepted follow-on snapshots selected
materials and provenance in its lineage so later reuse remains available after
source deletion.

The catalog and provenance stay outside respondent prompt state. Provider
requests receive the author's Choice instructions and options, not Sheg's
material IDs or source metadata. Sheg validates and preserves author-supplied
source metadata but does not retrieve the source or verify that its digest
matches external content. The agent owns candidate boundaries and decides
which query evidence should guide the next request.

## Consequences

Agents can trace a selected Choice to a stable exact material and ask new
questions about that material while selecting the original respondent
context. Explicit mappings avoid guessing and preserve ordinary Choice
semantics for all unmapped options. Authors must supply exact matching labels,
stable IDs, and provenance metadata for linked candidates. Provenance is a
traceability handle, not a claim that Sheg authenticated the external source.
