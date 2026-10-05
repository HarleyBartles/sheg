# Data contracts

The JSON Schemas shipped in `skills/stimulus-response-polling/assets/` travel with the installed plugin:

- [Direct MCP run request](../../skills/stimulus-response-polling/assets/run-request.schema.json)
- [Respondent archetype](../../skills/stimulus-response-polling/assets/respondent-archetype.schema.json)
- [Respondent archetype library](../../skills/stimulus-response-polling/assets/respondent-archetype-library.schema.json)
- [Respondent profile](../../skills/stimulus-response-polling/assets/respondent-profile.schema.json)
- [Respondent cohort](../../skills/stimulus-response-polling/assets/respondent-cohort.schema.json)
- [CLI study manifest](../../skills/stimulus-response-polling/assets/study-manifest.schema.json)

Runtime validators under `src/domain/respondents/`, `src/domain/study/`, `src/domain/decision/`, and `src/domain/run/request.ts` are authoritative. `npm run contracts:build` generates schemas from them. Cross-record constraints appear as `x-validation-rules`, which standard JSON Schema validation does not enforce. Load referenced schema files into a validator; their `$id` URIs identify schemas rather than requiring HTTP fetches.

For example, a profile may satisfy each field's 500-character limit while exceeding the combined 1,500-character limit. CLI and MCP `inspect` validate a durable request and measure fit without creating a run or calling inference; both `start` operations apply admission validation again. The CLI `trace` and `preflight` commands retain the historical manifest format for diagnostics. Loading, source verification, and hashing belong to `src/infrastructure/study-loader.ts`.

## Durable MCP runs

CLI and MCP use one SQLite datastore. Schema 9 is the first supported release baseline; earlier development schemas require explicit recovery. Stored answers and failure evidence use versioned envelopes; provider execution evidence belongs to the physical attempt, and public results are composed during recall. Requests, packets, and journey checkpoints remain validated JSON snapshots identified by their request/compiler/packet fingerprints. See [datastore health checks](datastore-health.md), [ADR-0030](../decisions/0030-use-drizzle-behind-typed-run-repositories.md), and [ADR-0031](../decisions/0031-set-schema-nine-as-release-baseline.md).

Jev configuration selects `provider.route` and contains no key material or credential-source override. Authentication uses the selected Windows Credential Manager entry. Results may contain optional cost evidence with a `provider-reported` or `published-rate-estimate` basis. Cost is not aggregated into a run bill; published-rate estimates require metadata for the served model, not merely the requested alias.

CLI preflight reports credential availability independently of inference reachability. It performs no network probe, so endpoint `availability` remains unverified. Interruption records preserve consumed attempts, recovery time, and `candidateCellIds`; candidate cells do not prove which cell owned an in-flight request when the process stopped.
