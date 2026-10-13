# ADR-0040: Preserve distinct four-way and pairwise visual comparisons

- Status: Accepted
- Date: 2026-10-13
- Supersedes: None

## Context

The v0.4 visual-study specification left open whether one all-four Choice or six isolated pair questions should be supported for comparing four designs. A bounded native Clef probe reused the same four portraits, brief, profile, provider, and model. The all-four call selected Writ with 2,115 reported input tokens. The six pair calls selected Writ over each other design, with 7,482 reported input tokens across successful results. The best-choice outcome agreed, while the pair questions also returned explicit relations and confidence for each pair; ties and inconsistent relations remain possible outcomes that a single four-way selection does not report. A separate six-portrait exploration showed that fifteen pair questions directly observe fifteen relations; three overlapping quartet calls return only three local selections and cannot be combined into that graph. No supported USD charge estimate was available. The portrait set contained visible text, so the Writ selection is not proof of visual-trait matching independent of OCR.

## Options considered

- Support only all-four Choice. It answers a direct best-of-four question with fewer calls and lower observed input use, but does not answer separately authored head-to-head questions.
- Support only six pairwise questions. It yields each pair outcome and can expose ties or inconsistent relations, but costs more when a single best-of-four answer is enough.
- Preserve both as distinct authored study shapes. This keeps the economical direct answer and the richer pair relation evidence without automatically converting between them.

## Decision

For up to four visual candidates, support both one four-way Choice and six isolated pairwise questions. Recommend one four-way call when the author's decision needs a direct best-of-four selection. Use pairwise when the author needs the explicit head-to-head outcomes, including ties or potentially inconsistent relations. Each pair question must expose only its two bound images and no sibling answers. Do not infer missing edges, produce an automatic total ranking, or claim universal equivalence from this bounded sample. Comparisons involving five or more designs remain deferred; do not split a larger set across calls or merge local winners.

## Consequences

Agents must choose the study shape based on the human's evidence need and explain its call and token trade-off. Sheg preserves the authored shape and validates each packet; it does not rewrite one into the other. The small probe supports a four-way default when one best-of-four answer suffices, while pairwise remains available for its distinct evidence granularity. Larger candidate-set comparison needs a later investigation and design decision.
