# ADR-0014: Select Jev routes explicitly and include route identity

- Status: Accepted
- Date: 2026-09-30
- Supersedes: None

## Context

Sheg can send Jev decisions through OpenRouter or the TypeSafe native API. A
saved key must not choose the provider route, and route-specific model or
endpoint behavior must remain stable for a resumable run.

## Options considered

- Infer route from whichever key is available, which makes configuration
  ambiguous and can silently change run behavior.
- Require an explicit route for every config, which breaks existing configs.
- Add an explicit route with an OpenRouter default for older configs.

## Decision

Use one Jev provider with `route: openrouter | typesafe`. Default a missing
route to OpenRouter. Include route, model, and effective endpoint in execution
identity. Use fetch for both routes and resolve only the selected route's key.

## Consequences

Existing configs preserve OpenRouter behavior. Credentials never select or
fallback between routes. Route changes make a run non-resumable under the new
settings.
