# ADR-0017: Limit Jev credential destinations to the selected provider

- Status: Accepted
- Date: 2026-09-30
- Supersedes: None; constrains endpoint overrides under ADR-0014

## Context

Jev endpoints are supplied through CLI and model-callable MCP configuration.
Windows Credential Manager protects a key at rest, but an arbitrary endpoint
could receive that key when Sheg authenticates a request. Redirects can also
send extra requests outside the reserved physical-attempt count.

## Options considered

- Accept arbitrary URLs, allowing custom proxies at the cost of exposing vault
  keys to destinations chosen by model-callable input.
- Remove endpoint overrides, losing saved provider paths.
- Permit paths only on the selected provider's HTTPS origin and reject redirects.

## Decision

Allow `https://openrouter.ai` for OpenRouter and `https://api.typesafe.ai` for
TypeSafe. Reject URL credentials and other origins, including HTTP and alternate
ports. Preserve explicit model and path settings on the provider origin.
Use fetch's `redirect: error` policy so each reserved attempt is one request to
the validated origin. Custom credential-bearing proxies are outside this slice.

## Consequences

Existing provider paths remain representable. Invalid destinations fail config
validation before a vault read. Redirects fail safely and consume their observed
attempt allowance. A future custom-proxy feature needs a human-controlled trust
boundary separate from model-callable run input.
