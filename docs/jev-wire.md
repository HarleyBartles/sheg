# Jev wire contract

## Evidence checked

Checked 2026-09-27 against OpenRouter's current Decisions API reference and
TypeScript examples. The Decisions endpoint is an alpha API, so verify this
contract again when upgrading the adapter.

- Endpoint: `POST https://openrouter.ai/api/alpha/decisions`
- Authentication: `Authorization: Bearer <OpenRouter API key>`
- Request: `{ model, state, questions }`
- Choice question: `{ type: "choice", instructions, criteria }`, where
  `criteria` maps every offered label to its description.
- Response: `answers[questionId]` contains `type: "choice"`, `choice`,
  `probabilities`, and `confidence`. The envelope reports the actual `model`,
  provider, and `usage` with `input_tokens`, `output_tokens`, and `cost`.
- `usage.cost` is the provider-reported monetary amount. Missing cost evidence
  must not be replaced with zero.
- The API response has no request-latency field. The adapter records elapsed
  wall time locally.

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
before a later resume. Never include the API key or response body in an error.

## References

- [OpenRouter Decisions API reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request)
- [OpenRouter's TypeScript Jev example](https://openrouter.ai/blog/tutorials/how-to-use-jev/)
- [OpenRouter TypeScript SDK overview](https://openrouter.ai/docs/client-sdks/typescript/overview)
