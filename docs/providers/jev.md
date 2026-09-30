# Jev provider routes

Sheg supports two explicit Jev routes. A missing route in an existing config
continues to mean OpenRouter. New configs should select a route deliberately;
the presence of a saved key never selects or switches routes.

| Route | Default model | Default endpoint | Windows Credential Manager target |
| --- | --- | --- | --- |
| `openrouter` | `typesafe/jev-1.13` | `https://openrouter.ai/api/alpha/decisions` | `Sheg/Jev/OpenRouter` |
| `typesafe` | `jev-latest` | `https://api.typesafe.ai/v1/systemone` | `Sheg/Jev/TypeSafe` |

Every Jev key is read from the selected target in the current user's Windows
Credential Manager. Sheg does not read environment variables or accept a key
source in configuration. To connect a key, use the bundled local helper:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\dist\credentials\windows-credential.ps1 -Operation Setup -TargetName Sheg/Jev/TypeSafe
```

Use `Sheg/Jev/OpenRouter` to connect OpenRouter. The helper prompts without
echoing the key and writes directly to Credential Manager. Run `Status` to
check an entry, `Setup` again to replace it, or `Remove` to delete it. The
setup prompt is local and interactive; never paste a key into chat or an MCP
tool argument. Windows Credential Manager is the only secure-store backend in
this implementation. macOS Keychain and Linux Secret Service support are
future work.

## Provider evidence

The adapter uses Node `fetch` for both routes. It sends the configured model,
state, and typed question to the selected endpoint with bearer authentication.
Choice, Score, and Noul answers are validated at the adapter boundary and
normalized into the same domain result. Missing cost evidence does not make a
valid answer invalid.

The TypeSafe System One request is `POST /v1/systemone` with bearer
authentication. Its response reports `model`, `answers`, and token usage. The
JavaScript SDK has its own retries, so Sheg does not add the SDK and keeps
physical request counting in the fetch adapter.

OpenRouter's Decisions endpoint is an alpha API. Its response may include
`usage.cost`; when present, Sheg records that as provider-reported evidence.
TypeSafe's published rate is $0.042 per million input tokens, with output
tokens listed as free. Sheg may estimate per-decision cost from complete
response token counts using that rate and label it as a published-rate
estimate. Account-specific billing remains visible in the selected provider's
dashboard. Sheg does not present a cumulative bill or spend ceiling.

Context fit is model-specific. OpenRouter's pinned `typesafe/jev-1.13` path
retains the existing 32,768-token context assumption and estimates request
tokens as serialized UTF-8 bytes divided by three, rounded up, with a 20%
reserve. TypeSafe's native docs and model metadata do not publish a context
limit, so native preflight reports fit as unverified and a paid request is
blocked until that evidence exists. The OpenRouter limit is not transferred to
the native route by analogy.

## Attempts and recovery

`maxCalls` bounds physical provider attempts, including retries. It is
independent of the study's per-respondent `maxDecisions` journey limit. A
failed or interrupted request consumes its attempt allowance because the
provider may have received it. Unknown billing does not block resume and does
not require reconciliation. Per-decision cost evidence is optional and is not
summed into a run total.

Route, model, and effective endpoint are part of execution identity. Changing
any of these prevents resuming a run with different provider behavior.
Credential rotation does not change execution identity.

## References

- [TypeSafe API introduction](https://docs.typesafe.ai/introduction)
- [TypeSafe JavaScript SDK guide](https://docs.typesafe.ai/sdk/javascript)
- [TypeSafe JavaScript SDK v0.6.0 client](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/client.ts)
- [TypeSafe OpenAPI](https://api.typesafe.ai/openapi.json)
- [TypeSafe pricing announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [OpenRouter Decisions API reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request)
- [Microsoft CredWrite](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritea)
