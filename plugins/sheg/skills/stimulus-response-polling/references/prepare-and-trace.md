# Trace and preflight historical manifests

Current CLI and MCP runs use the same durable direct-request service. The versioned study manifest remains available for deterministic route tracing, provider preflight, and read-only access to pre-release file-backed reports.

Use `trace` to inspect a particular path without inference. Provide a manifest, frozen cohort, arm, respondent, and either stable Choice IDs or typed responses:

```sh
node dist/cli.js trace --manifest study.json --cohort cohort.json --arm <id> --respondent <id> --choices <a,b,...>
node dist/cli.js trace --manifest study.json --cohort cohort.json --arm <id> --respondent <id> --responses <json-array>
```

Use `preflight` to measure the exact frozen cohort over reachable paths, or choose `maximum-profile` for a synthetic profile-size sample:

```sh
node dist/cli.js preflight --manifest study.json --cohort cohort.json --providers providers.json
node dist/cli.js preflight --manifest study.json --mode maximum-profile --providers providers.json
```

Preflight does not create a run or contact an inference endpoint. It reports credential availability separately from endpoint reachability; availability is unverified because no network probe occurs. An incomplete walk or unavailable measurement is reported as unverified, never as fit. See [packet budgeting](../../study-design/references/packet-budgeting.md) for packet contents and provider-specific measurement. Every current durable request is checked again at admission and before inference.
