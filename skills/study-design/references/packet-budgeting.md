# Decision packet budgeting

This guide describes decision packets and the file-backed journey CLI. The v0.3.0 MCP accepts direct polls and follow-ons with one or more independent questions, plus finite sequence or response-routed journey requests. Optionally use `run_inspect` to measure the exact request and preview journey paths. `run_start` validates the request itself. It does not expose draft variant batching.

Use this guide when deciding whether a draft task or complete journey can fit the configured provider. Sheg compiles a fresh, stateless decision packet for each respondent/question evaluation. Jev may receive a question group as one provider request when the measured batch fits; local Laya splits independent groups into one question per request.

## What goes into one task input

At each decision point the packet includes:

```text
provider request framing
+ respondent perspective (five prose fields)
+ stimulus text currently in scope
+ current task ID/instructions and every offered stable option ID/description
+ trajectory summary (prior choices, their meanings, and exposed stimulus IDs)
+ provider request envelope and serialization
```

The answer key, study purpose, archetype definitions, variation metadata, other arms, and unexposed graph stimulus text are not sent. The provider's framing and serialized envelope also consume input capacity, so the prose field caps are only a limit on one component of the whole packet.

The history is not just the last few turns. It contains prior choices and their meanings plus exposure IDs, allowing a later task to refer to an earlier decision even when it was several steps ago. Prior stimulus text is not repeated just because it appeared earlier: expose the item again in a graph if the respondent needs its full text at a later decision. No automatic relevance pruning or compaction is active today.

Stimulus scope depends on presentation:

- In a sequence, the current compiler includes all arm items in scope at each task. Keep sequence items bounded with that packet behavior in mind.
- In a graph, a task receives text exposed since the preceding decision. Earlier exposure and choices remain represented in trajectory metadata.

## Current provider assumptions

| Provider | Measurement | Effective fit behavior |
| --- | --- | --- |
| Laya | The pinned Laya tokenizer and sequence builder measure the compiled request locally. The fit count uses the tokenizer asset and request, not GPU speed. | Uses the configured context limit, currently 1,024 tokens in the supported local setup, plus the configured question head limit and Laya's 48-token per-option limit. A packet can fail due to truncation or option constraints even when arithmetic context headroom is positive. |
| Jev | Estimates the serialized request as `ceil(UTF-8 bytes / 3)`; this is not an exact Jev tokenizer count. | Uses the existing 32,768-token context estimate with a 20% reserve, giving an effective estimated input ceiling of 26,214 tokens. A fit is useful design guidance, not a provider guarantee. |

Laya token count for the same request and tokenizer does not depend on the machine. GPU, checkpoint, and service configuration affect whether and how quickly inference runs. Jev's estimate also does not depend on the local machine. Provider configuration determines the limits being assessed.

For both providers distinguish:

- **fits**: the provider measurer says the request fits its configured rules;
- **overflow**: a measured/estimated request violates a context, head, or option constraint;
- **unavailable**: the configured measurement cannot establish fit, for example because the tokenizer asset is missing or mismatched.

Do not turn unavailable into fit or infer success only from non-negative token headroom. Keep the provider's measurement method and reason with the result.

## Efficient authoring

Keep each input component only as large as its purpose requires. Preserve the author's exact stimulus and question; explain which component is creating pressure and offer choices such as shorter stimulus beats, a different presentation, or a different provider. Never silently cut stimulus, task text, or history to force a fit.

For profiles, include only perspective details that could affect the answer. The five profile fields each allow at most 500 characters and together allow at most 1,500 characters. These are schema safeguards, not writing targets. Profiles produced by an agent should be concise by default rather than arbitrarily filling the allowance.

## Iterate from one task to the full study

1. For a direct MCP request, optionally use `run_inspect` after choosing the exact material, profiles, questions, provider, and call limit when a fit preview would help. It measures context fit for each compiled respondent/question evaluation packet without inference.
2. If using the file-backed journey CLI, use `preflight` to walk all respondents and possible choice paths at every task. It reports where a provider stops fitting, including the packet and route, or whether a provider measurement is unavailable.
3. Use CLI `check` for deterministic minimum/maximum reachable decision-call bounds and whether the configured `maxCalls` covers the maximum. The call limit bounds physical provider attempts, including retries.

Request authoring, schema validation, `run_inspect`, journey preview, and CLI preflight do not require an inference call. `run_start` starts the direct request; CLI `start` and `resume` run file-backed journeys.
