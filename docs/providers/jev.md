# Jev wire contract

## Configuration

Set the environment variable named by `keyEnv` in the environment launching Codex. Never put the secret in a manifest, plugin file, or chat. Every hosted run requires `maxUsd` and `maxPerCallUsd`. Routine checks use fake transports and make no paid provider calls.

## Evidence checked

Checked 2026-09-27 against OpenRouter's current Decisions API reference and
TypeScript examples. The Decisions endpoint is an alpha API, so verify this
contract again when upgrading the adapter.

## Context preflight

For the pinned `typesafe/jev-1.13` model, preflight estimates tokens as the
UTF-8 byte length of the exact serialized request divided by three, rounded up.
It reserves 20% of the configured 32,768-token context (6,554 tokens), so the
estimate must be at most 26,214. This is an estimate, not provider-reported
usage. Other Jev model identifiers are unavailable to preflight until their
context limit is explicitly supported. Runtime applies this check before any
network request.

- Endpoint: `POST https://openrouter.ai/api/alpha/decisions`
- Authentication: `Authorization: Bearer <OpenRouter API key>`
- Request: `{ model, state, questions }`
- Choice question: `{ type: "choice", instructions, criteria }`, where
  `criteria` maps every offered stable option ID to its description.
- Score question: `{ type: "score", instructions, criteria }`, where
  `criteria` is the ordered rubric. The answer retains `score`, a numeric-keyed
  `legend`, and numeric-keyed `probabilities`.
- Noul question: `{ type: "noul", instructions, criteria }`, where `criteria`
  may describe `true` and `false`. The answer retains `noul`, the probability
  that the proposition is true.
- Response: `answers[questionId]` contains `type: "choice"`, `choice`,
  `probabilities`, and `confidence`. The envelope reports the actual `model`,
  provider, and `usage` with `input_tokens`, `output_tokens`, and `cost`.
- `usage.cost` is the provider-reported monetary amount. Missing cost evidence
  must not be replaced with zero.
- The API response has no request-latency field. The adapter records elapsed
  wall time locally.
- Choice, Score, and Noul are encoded as distinct question types. The adapter
  validates each answer against the authored task before recording it; typed
  values are never coerced into Choice.
- Starting or resuming inference rejects a missing key before creating or relaunching a run. Keyless `poll_check` remains available.

## Transport and retry policy

The OpenRouter TypeScript SDK has a typed Decisions operation and exposes
request retry configuration on its request methods. This adapter uses Node's
`fetch` directly so its small retry loop owns and counts every physical request
against the run's hard call allowance; no SDK retry layer is involved.

Count every request that reaches the transport as one attempt. Retry network
errors and HTTP 429, 500, 502, 503, 524, and 529 responses, bounded by the
provider call's `maxAttempts`. Do not retry other HTTP statuses. A failed or
timed-out attempt may have reached billing even if no response was received;
report its charge as unknown and let the run controller require reconciliation
before a later resume. Reconcile only against the provider's verified total for all unresolved calls; `poll_reconcile` and the CLI `reconcile` command record that total without resetting call usage. Never include the API key or response body in an error.

## References

- [OpenRouter Decisions API reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request)
- [OpenRouter's TypeScript Jev example](https://openrouter.ai/blog/tutorials/how-to-use-jev/)
- [OpenRouter TypeScript SDK overview](https://openrouter.ai/docs/client-sdks/typescript/overview)
