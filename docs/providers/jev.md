# Jev provider routes

Sheg supports two explicit Jev routes. A missing route in an existing config continues to mean OpenRouter. New configs should select a route deliberately; the presence of a saved key never selects or switches routes.

| Route | Default model | Default endpoint | Windows Credential Manager target |
| --- | --- | --- | --- |
| `openrouter` | `typesafe/jev-1.13` | `https://openrouter.ai/api/alpha/decisions` | `Sheg/Jev/OpenRouter` |
| `typesafe` | `jev-latest` | `https://api.typesafe.ai/v1/systemone` | `Sheg/Jev/TypeSafe` |

Every Jev key is read from the selected target in the current user's Windows Credential Manager. Sheg does not read environment variables or accept a key source in configuration. To connect a key, use the bundled local helper:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\dist\credentials\windows-credential.ps1 -Operation Setup -TargetName Sheg/Jev/TypeSafe
```

Use `Sheg/Jev/OpenRouter` to connect OpenRouter. The helper prompts without echoing the key and writes directly to Credential Manager. Run `Status` to check an entry, `Setup` again to replace it, or `Remove` to delete it. The setup prompt is local and interactive; never paste a key into chat or an MCP tool argument. An agent setting up Sheg can give the user this command or open a user-visible terminal and ask them to paste the key into the helper's hidden prompt. Connecting a key is optional until a Jev run starts; users can defer setup and use local Laya. Windows Credential Manager is the only secure-store backend in this implementation. macOS Keychain and Linux Secret Service support are future work.

Sheg reads UTF-8 tokens and the UTF-16LE values written by its setup helper. If a stored value is unreadable, `run_start` returns `provider_credential_malformed` with a safe instruction to re-enter it through the helper. Errors never include token bytes. `run_inspect` remains keyless.

## Provider evidence

The adapter uses Node `fetch` for both routes. It sends the configured model, state, and typed question set to the selected endpoint with bearer authentication. Endpoint overrides must stay on the selected provider's HTTPS origin: `https://openrouter.ai` or `https://api.typesafe.ai`. Saved paths on that origin remain supported. URL credentials, other origins, and redirects are rejected before any key can be forwarded to a different destination.

Choice, Score, and Noul answers are validated at the adapter boundary and normalized into the same domain result. Missing cost evidence does not make a valid answer invalid.

The Jev wire request is `{ model, state, questions }`; `questions` maps each stable question ID to its typed instructions and criteria. Each answer is validated against its matching question. Invalid, missing, or duplicate answers are scoped to that question; malformed shared response data and authorization failures apply to the whole provider request. Provider model, usage, latency, and cost are stored once for the physical request, not copied onto each answer.

TypeSafe documents parallel independent questions in one System One request. Sheg uses that published request shape through the configured Jev route. Its JavaScript SDK has its own retries, so Sheg does not add the SDK and keeps physical request counting in the fetch adapter. The local Laya route remains singleton: Sheg measures and sends one question at a time against the same frozen respondent state.

OpenRouter's Decisions endpoint is an alpha API. Its response may include `usage.cost`; when present, Sheg records that as provider-reported evidence. TypeSafe's published rate is $0.042 per million input tokens, with output tokens listed as free. Sheg may estimate per-decision cost from complete response token counts using a rate recorded for the served model and label it as a published-rate estimate. Account-specific billing remains visible in the selected provider's dashboard. Sheg does not present a cumulative bill or spend ceiling.

Context fit uses route-specific model metadata in `src/providers/jev/model-metadata.ts`. Sheg estimates the complete serialized request as `ceil(UTF-8 bytes / 3)` and reserves 20% of the supported bound:

| Route and model | Bound | Estimated input threshold |
| --- | --- | --- |
| OpenRouter `typesafe/jev-1.13` | 32,768 tokens | 26,214 tokens |
| Native TypeSafe `jev-latest` | 32,000 tokens | 25,600 tokens |

The native policy conservatively applies TypeSafe's stricter state-plus-question limit to the entire request. [ADR-0025](../decisions/0025-bound-native-typesafe-context-admission.md) records its evidence and rationale. Estimates are not tokenizer-exact and do not guarantee provider acceptance. Unknown models remain unavailable until supported evidence is added. Updating limits or moving-alias support requires fresh provider evidence; retain the actual served model in run records.

## Attempts and recovery

`maxCalls` bounds physical provider attempts, including retries, independently of the per-respondent `maxDecisions` journey limit. Dispatched or uncertain requests consume allowance even if they fail; confirmed pre-dispatch failures consume none. Status and reports expose maximum, used, reserved, and remaining calls. Unknown billing does not block resume or require reconciliation.

Route, model, and effective endpoint are part of execution identity. Changing any of these prevents resuming a run with different provider behavior. Credential rotation does not change execution identity.

## References

- [TypeSafe API introduction](https://docs.typesafe.ai/introduction)
- [TypeSafe parallel questions cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions)
- [TypeSafe JavaScript SDK guide](https://docs.typesafe.ai/sdk/javascript)
- [TypeSafe JavaScript SDK v0.6.0 client](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/client.ts)
- [TypeSafe OpenAPI](https://api.typesafe.ai/openapi.json)
- [TypeSafe model reference](https://docs.typesafe.ai/models)
- [TypeSafe pricing announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [OpenRouter Decisions API reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request)
- [Microsoft CredWrite](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritea)
