# Data contracts

The JSON Schemas shipped in `skills/stimulus-response-polling/assets/` are the consumer-facing contracts and travel with the installed plugin skill:

- [Respondent archetype](../../skills/stimulus-response-polling/assets/respondent-archetype.schema.json)
- [Respondent archetype library](../../skills/stimulus-response-polling/assets/respondent-archetype-library.schema.json)
- [Respondent profile](../../skills/stimulus-response-polling/assets/respondent-profile.schema.json)
- [Respondent cohort](../../skills/stimulus-response-polling/assets/respondent-cohort.schema.json)
- [Study manifest](../../skills/stimulus-response-polling/assets/study-manifest.schema.json)

The library schema references the standalone archetype schema by its `$id`. The cohort schema references the archetype-library and respondent-profile schemas. Consumers validating these contracts should load the referenced schema files into their validator; the URIs are identifiers and do not imply HTTP fetches.

Runtime validators in `src/domain/respondents/archetype.ts`, `src/domain/respondents/profile.ts`, `src/domain/respondents/cohort.ts`, and the study modules under `src/domain/study/` are authoritative for executable validation. Schemas are generated from those definitions with `npm run contracts:build`. Cross-record constraints appear in each schema's `x-validation-rules` and are enforced by runtime validators. File-backed JSON parsing, source resolution, and hashing live in `src/infrastructure/study-loader.ts`.

Standard JSON Schema validation alone does not enforce `x-validation-rules`. In particular, a profile can satisfy each field's 500-character limit while exceeding the combined 1,500-character prose limit. `run_start` applies runtime validation to direct MCP requests. Optionally use `run_inspect` on the exact request when a fit preview would help; it creates no run and makes no inference call. The file-backed CLI journey flow uses `sheg check`.

Jev run configuration chooses a route with `provider.route`; configuration never contains key material or an environment-variable name. The selected credential is read from Windows Credential Manager. Durable run checkpoints use format 4 and retain the maximum physical-call allowance, used calls, and remaining calls. Decision results may contain per-decision `cost` evidence with a `provider-reported` or `published-rate-estimate` basis. Cost is optional and is not aggregated into a run bill.

Reports retain the selected Jev route and endpoint beside the model, and expose `providerEvidence.maxCalls`, `attempts`, `reservedCalls`, and `remainingCalls`. Each journey also exposes `failedAttempts`; failures do not require billing reconciliation. Published-rate estimates require metadata for the served model, not just the requested alias.

Preflight identifies Jev `route` and `endpoint` and returns exact `credentialAvailability` independently of inference reachability. `availability` remains unverified because preflight performs no network probe. Checkpoints and reports preserve interruption records with consumed attempts, recovery time, and `candidateCellIds`. Those cells span ongoing journeys, so they are candidates, not evidence of which cell owned a request when the process stopped.
