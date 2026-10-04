# Decision packet budgeting

Use this reference to assess provider fit for a direct poll, follow-on, or journey. `run_inspect` validates and measures a proposed MCP request without inference or run creation. `run_start` performs admission checks itself. The file-backed CLI uses `preflight --manifest` for a complete authored study; it does not expose draft-variant batching.

Sheg compiles a stateless packet for each respondent/question evaluation. Independent questions share the same frozen state. Jev may batch them into one physical request when that request fits; local Laya sends one question per request.

## Packet contents

A packet contains the respondent's five perspective fields, material in scope, the typed question, and trajectory metadata. Choice includes every offered option ID and description; Score includes the ordered rubric; Noul includes its proposition and optional true/false criteria. Provider framing and serialization also consume capacity.

Study purpose, answer keys, archetype definitions, variation metadata, other arms, and unexposed material stay outside the model input.

New journeys use cumulative material: each question sees the exact text of every distinct item exposed so far on that respondent's path, in first-exposure order. A sequence exposes all items before asking tasks. A graph may interleave exposure and questions or branch, but uses the same material rule. `responseHistory: include` retains prior typed answers and their meanings; `omit` removes those answers while retaining exposed material and exposure metadata. Saved runs continue under their recorded compiler semantics.

## Provider measurement

| Provider configuration | Measurement | Admission rule |
| --- | --- | --- |
| Local Laya | The pinned tokenizer and sequence builder measure the complete request locally. | Configured context and question-head limits, plus the 48-token per-option limit. The default context limit is 1,024 tokens. Truncation or option constraints can fail even with positive arithmetic headroom. |
| Jev OpenRouter, `typesafe/jev-1.13` | Estimated tokens: `ceil(serialized UTF-8 bytes / 3)`. | 32,768-token bound with a 20% reserve, giving an estimated input threshold of 26,214 tokens. |
| Jev native TypeSafe, `jev-latest` | The same byte estimate, using native route evidence. | Conservative 32,000-token bound on the complete request with a 20% reserve, giving an estimated input threshold of 25,600 tokens. |

Jev estimates are not exact tokenizer counts or guarantees of provider acceptance. Unknown models remain unavailable until supported context evidence is added. Preserve the measurement method and reason when reporting `fits`, `overflow`, or `unavailable`; unavailable does not mean fit.

Journey inspection walks reachable paths and reports fit with packet identifiers, not a complete topology or material preview. When variable prior answers prevent exhaustive measurement, it reports that limitation. Every actual packet is checked before inference, so an inspection report does not guarantee that all later packets will fit.

## Authoring within the budget

Keep components as large as their purpose requires. Preserve the user's exact stimulus and question. Explain which component exceeds capacity and propose a design or provider change; never silently trim material, question text, or history to force admission.

Profiles should contain perspective details that could affect an answer. Each prose field allows 500 characters and the five together allow 1,500. These are safeguards, not targets to fill.

For the CLI, `node dist/cli.js preflight --manifest ...` measures the exact frozen cohort or an explicitly selected synthetic profile sample. `node dist/cli.js check --config ...` validates inputs and reports reachable decision-call bounds. For MCP polls and follow-ons, `run_inspect` reports the physical-call minimum after provider batching or splitting. `maxCalls` limits physical attempts, including retries and uncertain dispatches, rather than the number of answers.
