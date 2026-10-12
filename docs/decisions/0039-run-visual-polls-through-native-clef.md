# ADR-0039: Run visual polls through native Cloudflare Clef

- Status: Accepted
- Date: 2026-10-12
- Supersedes: None

## Context

Sheg now stores immutable images and accepts typed visual questions. Pixel-dependent questions need a provider that can inspect those bytes while preserving Sheg's existing run, attempt, and recovery behavior. Visual evidence also needs to remain understandable in later journey turns without repeatedly transmitting the image.

## Options considered

- Route visual questions through an aggregator. This would add a proxy boundary and obscure the native Cloudflare execution identity and limits.
- Add native Cloudflare Workers AI Clef as an explicitly selected provider. This requires a distinct credential, response envelope, admission policy, and model identity while using Sheg's existing typed execution lifecycle.
- Infer provider choice or silently fall back across providers. This could change the model between study turns and weaken comparisons without the agent or user choosing that change.

## Decision

Support native Cloudflare Workers AI Clef and Clef Flash through a fixed account REST route. Require explicit provider configuration and keep the Cloudflare token in the isolated `Sheg/Clef/Cloudflare` Windows Credential Manager target. Do not add endpoint overrides, automatic provider selection, or fallback after failure.

Before reserving a call, validate image count, dimensions, decoded bytes, serialized body, question shape, and a conservative text/media context estimate. Refuse unverified fit rather than truncating study content. Use the shared physical-attempt ledger and existing answer-scoped validation behavior.

An image material requires an agent-authored factual description. Pixel questions send the saved image bytes; described-evidence questions send the supplied description and do not claim pixel inspection. A later journey turn carries the exact supplied description, caption, typed reaction, and provider/model identity as compact history. It resends pixels only when that later task explicitly binds them.

## Consequences

Agents can inspect image-backed study materials through the normal request, inspection, execution, and evidence tools. Clef results remain model evidence, not human cohort evidence or a guarantee of visual accuracy. The four-image provider cap applies per call. Provider choice, matched arms, and cross-provider comparisons remain authored study decisions outside this slice.
