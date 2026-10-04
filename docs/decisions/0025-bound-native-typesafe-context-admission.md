# ADR-0025: Bound native TypeSafe context admission with published evidence

Status: Accepted

Date: 2026-10-04

## Context

The native TypeSafe route was blocked because Sheg had no context-limit evidence for `jev-latest`. Reusing OpenRouter's context metadata would conflate distinct provider routes and could admit requests on an unsupported assumption. TypeSafe's official model reference reports that Jev 1.13 (`jev-1.13.0`) accepts 64k tokens per request and limits state plus the longest question to 32k. Its OpenAPI schema returns the served model and usage but exposes no context-limit metadata. The documentation identifies `jev-latest` as a moving alias.

## Decision

For native `jev-latest`, Sheg uses 32,000 tokens as a conservative ceiling for the entire serialized request, including state and every question. It estimates tokens from serialized UTF-8 bytes divided by three, rounded up, and reserves 20%, yielding an effective estimated threshold of 25,600. This uses the published stricter 32k constraint across the full request and remains below the published 64k aggregate limit. The adapter checks fit before reading its authentication key or dispatching inference. MCP acceptance also checks credential readiness before persisting a new run. Unknown native models remain unavailable until supported by route-specific evidence. The adapter records the returned served model and physical usage; an actual provider rejection remains a safe provider failure.

The estimate is not an exact TypeSafe tokenizer measurement and is not a guarantee that TypeSafe accepts every admitted request. The official evidence and alias mapping were checked 2026-10-04. Changes to supported aliases or admission limits require fresh native provider evidence. Do not derive native limits from OpenRouter metadata.

## Consequences

Native TypeSafe requests can pass admission when the complete estimated packet is within the effective bound, without weakening admission checks. Oversized or unknown-model requests remain blocked before dispatch. Whole-study preflight may still report unverified when later request context depends on variable response history. Provider refusal remains observable and consumes physical attempt allowance when a request was dispatched.

## Alternatives considered

- Reuse OpenRouter's 32,768-token model limit for the native endpoint: rejected because the provider routes and evidence are distinct.
- Admit against the published 64k aggregate limit alone: rejected because it ignores TypeSafe's stricter 32k state-plus-question constraint.
- Apply the 32k limit only to state plus the single longest question: rejected because Sheg sends the typed question set in one request and must bound the serialized request it actually dispatches.
- Keep native admission unavailable until exact tokenizer metadata is published: rejected because official route-specific bounds support a conservative estimate while preserving the existing reserve and safe failure behavior.

## References

- [TypeSafe model reference](https://docs.typesafe.ai/models), checked 2026-10-04.
- [TypeSafe OpenAPI schema](https://api.typesafe.ai/openapi.json), checked 2026-10-04.
- [Jev provider routes](../providers/jev.md).
