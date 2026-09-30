# Local Laya adapter

The harness talks to a running Laya service over its local HTTP API. It does not start Python, download weights, or select a checkpoint implicitly. The operator starts and configures the local service separately.

## Configuration

Configure a running `/v1/systemone` endpoint with the intended checkpoint, `contextLimit`, `headLimit`, timeout, precision provenance, and a local `tokenizerJsonPath` plus its SHA-256 digest. The tokenizer asset must be the one loaded by that Laya checkpoint. The adapter checks the digest on load and records it in run identity; the operator is responsible for configuring the service with that same asset because the service does not report the tokenizer revision.

## Wire contract observed

The Laya service exposes `POST /v1/systemone`. The request carries an explicit `model`, `state`, and `questions` map. Choice uses `type: "choice"` and a `criteria` map; Score uses `type: "score"` with ordered rubric criteria; Noul uses `type: "noul"` with optional true/false criteria. A successful response has a top-level `model`, `answers`, `usage`, and `routing`. Choice answers carry `choice` and `probabilities`; Score answers carry `score`, `legend`, and `probabilities`; Noul answers carry `noul` (P(true)). `routing.model` identifies the selected checkpoint. The top-level model can be the generic `laya-rl-agent`, so the adapter checks the routed checkpoint rather than treating that generic name as the checkpoint identity.

The `/v1/systemone` service currently limits Score questions to 32 rubric levels. The adapter reports larger rubrics as overflow in measurement and rejects them before inference. This service limit is provider-specific; Sheg's task contract does not impose it on other providers. Verified against the upstream [service limit](https://github.com/NandhaKishorM/laya/blob/main/laya/serve.py) on 2026-09-30; check the installed service revision before use.

These fields were checked against the upstream [Laya service](https://github.com/NandhaKishorM/laya/blob/main/laya/serve.py), [router](https://github.com/NandhaKishorM/laya/blob/main/laya/router.py), and [agent](https://github.com/NandhaKishorM/laya/blob/main/laya/agent.py) on 2026-09-27. The repository is actively changing. A deployment must confirm its installed revision implements the same wire contract before use.

## Context admission

The service does not expose a pre-inference context-fit operation. Its reported input token usage arrives with inference, too late to prevent truncation. The adapter vendors Laya's TypeScript tokenizer and sequence builder from [revision `ec8409e`](https://github.com/NandhaKishorM/laya/commit/ec8409e542941bb4bb649d5fec00d4cec96ae024), including the repository's Apache-2.0 license and provenance notice. That upstream revision states its TypeScript implementation is byte-identical in behavior to the Python implementation.

Before every inference, the adapter runs the actual request state through the pinned tokenizer and Laya's sequence builder. It rejects options beyond Laya's 48-token cap, question head truncation under `headLimit`, or state truncation under `contextLimit`. An unavailable tokenizer, checksum mismatch, or overflow prevents the HTTP inference call. It never silently trims or summarizes the respondent's trajectory.

The fit count measures input tokens. It is machine-independent for the same tokenizer JSON and request; GPU capacity, service configuration, and checkpoint compatibility still determine whether inference succeeds. This fit check does not replace an operator smoke test against the configured Laya service.

## Provenance and failure behavior

- A successful result retains the generic served `model` and the exact `routing.model` as `checkpoint`.
- `usage.input_tokens` and `usage.output_tokens` are retained when supplied. The preflight count is kept separately by the fit result.
- Confidence is copied without converting it into Jev's confidence semantics or applying a Jev threshold.
- Choice, Score, and Noul remain distinct wire and report types. The adapter validates the response against the authored task, including rubric-level distribution keys and score bounds, before recording a decision.
- Local inference returns no hosted cost evidence.
- A transport failure has unknown execution status. HTTP and invalid-response failures are not retried; the adapter makes at most one inference request.
- The configured checkpoint is sent explicitly. The adapter rejects a response routed to another checkpoint and never falls back to a different provider.

Routine tests use fake transport and do not download weights or start a GPU runtime.
