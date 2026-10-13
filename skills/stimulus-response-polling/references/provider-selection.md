# Let Sheg select providers or pin a study design

Every study request chooses exactly one routing mode. Set `provider` to pin one configuration for the whole request. Set `providerSelection: {}` to let Sheg select for each eligible unit. Selection requires an enabled, configured, ready provider that supports the question type and required input capability, fits the complete packet, and fits the remaining call allowance.

An agent may pin an eligible provider for a unit, supply request `preferredOrder`, or define comparison locks. Sheg honors an eligible unit pin first, then request preference, then saved user preference. With no preference, it favors eligible local execution with no provider invoice; otherwise it uses lowest estimated cost only when published rates are comparable. Unknown or incomparable prices remain unknown and preserve stable catalogue order. Estimates do not guarantee actual billing or model quality.

Use comparison locks when members must share a provider and model, or when the study intentionally varies one dimension. A provider or model change is a treatment change. Keep the model fixed when comparing respondents or stimuli unless the study explicitly tests provider or model effects. A capability requirement, such as pixel inspection, can constrain that choice.

Automatic follow-on routing resolves each selected source context independently. Follow-on `comparisonLocks` are currently rejected because their respondent/question handles do not uniquely identify the frozen source contexts; pin one provider for the whole follow-on or omit the lock until context-specific comparison handles are supported.

Sheg batches independent questions that share one frozen respondent state, or splits them when provider fit requires it. Set `providerSelection.batching: "singleton"` when separate calls are part of the design. The `maxCalls` ceiling includes splits and retries.

Use `provider_settings` through MCP or `provider-settings --request <json>` through the CLI to read or revision-check the provider catalogue and preference order. Settings never contain credentials. Manage keys only through `provider_credential` or `provider-credential`.

Inspection reports initial automatic choices, fit and readiness evidence, preferences, locks, and cost evidence. Later journey units are marked unresolved while their respondent-specific context is unknown; Sheg selects again when each unit is reached and records the actual provider and served model. Consult [Native Cloudflare Clef](native-clef.md) for pixel capability and image limits.
