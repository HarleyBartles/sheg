# Data contracts

The JSON Schemas shipped in `skills/stimulus-response-polling/assets/` travel with the installed plugin:

- [Direct MCP run request](../../skills/stimulus-response-polling/assets/run-request.schema.json)
- [Respondent archetype](../../skills/stimulus-response-polling/assets/respondent-archetype.schema.json)
- [Respondent archetype library](../../skills/stimulus-response-polling/assets/respondent-archetype-library.schema.json)
- [Respondent profile](../../skills/stimulus-response-polling/assets/respondent-profile.schema.json)
- [Respondent cohort](../../skills/stimulus-response-polling/assets/respondent-cohort.schema.json)
- [CLI study manifest](../../skills/stimulus-response-polling/assets/study-manifest.schema.json)

Runtime validators under `src/domain/respondents/`, `src/domain/study/`, `src/domain/decision/`, and `src/domain/run/request.ts` are authoritative. `npm run contracts:build` generates schemas from them. Cross-record constraints appear as `x-validation-rules`, which standard JSON Schema validation does not enforce. Load referenced schema files into a validator; their `$id` URIs identify schemas rather than requiring HTTP fetches.

For example, a profile may satisfy each field's 500-character limit while exceeding the combined 1,500-character limit. MCP `run_start` applies runtime validation. `run_inspect` can validate and preview fit without creating a run or calling inference. The file-backed CLI validates its manifest and cohort with `node dist/cli.js check --config <file>`; loading, source verification, and hashing belong to `src/infrastructure/study-loader.ts`.

## Durable MCP runs

MCP runs use SQLite with separate versioned persisted JSON payloads. Recall and query expose frozen requests, packets, typed answers, lineage, and physical attempts. Supported upgrade behavior is defined by [ADR-0027](../decisions/0027-migrate-supported-datastore-schemas.md), rather than the CLI checkpoint format.

Jev configuration selects `provider.route` and contains no key material or credential-source override. Authentication uses the selected Windows Credential Manager entry. Results may contain optional cost evidence with a `provider-reported` or `published-rate-estimate` basis. Cost is not aggregated into a run bill; published-rate estimates require metadata for the served model, not merely the requested alias.

## File-backed CLI runs

CLI checkpoints use format 4 and retain maximum, used, reserved, and remaining physical calls. Reports identify the Jev route, endpoint, and model, and expose `providerEvidence.maxCalls`, `attempts`, `reservedCalls`, and `remainingCalls`. Each journey reports its failed-attempt count.

CLI preflight reports credential availability independently of inference reachability. It performs no network probe, so endpoint `availability` remains unverified. Interruption records preserve consumed attempts, recovery time, and `candidateCellIds`; candidate cells do not prove which cell owned an in-flight request when the process stopped.
