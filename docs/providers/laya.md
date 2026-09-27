# Local Laya adapter

The harness talks to a running Laya service over its local HTTP API. It does not start Python, download weights, or select a checkpoint implicitly. The operator starts and configures the local service separately.

## Configuration

Configure a running `/v1/systemone` endpoint with the intended checkpoint, context limit, timeout, and precision provenance. The adapter refuses inference unless a checkpoint-matched `FitMeasurer` is available. It does not assume a built-in tokenizer or launch a local model. Live Laya/GPU verification is an opt-in operator action after a compatible fit measurer is available.

## Wire contract observed

The Laya service exposes `POST /v1/systemone`. The request carries an explicit `model`, `state`, and `questions` map. A choice question has `type: "choice"`, `instructions`, and a `criteria` map. A successful response has a top-level `model`, `answers`, `usage`, and `routing`; a choice answer carries `choice`, `probabilities`, and optionally `confidence`. `routing.model` identifies the selected checkpoint. The top-level model can be the generic `laya-rl-agent`, so the adapter checks the routed checkpoint rather than treating that generic name as the checkpoint identity.

These fields were checked against the upstream [Laya service](https://github.com/NandhaKishorM/laya/blob/main/laya/serve.py), [router](https://github.com/NandhaKishorM/laya/blob/main/laya/router.py), and [agent](https://github.com/NandhaKishorM/laya/blob/main/laya/agent.py) on 2026-09-27. The repository is actively changing. A deployment must confirm its installed revision implements the same wire contract before use.

## Context admission

The observed service does not expose a pre-inference context-fit operation. Its reported input token usage arrives with the inference result, which is too late to prevent truncation. The model runtime composes an encoded question prefix and state, then limits the state tokens to the remaining `max_len` budget. Checking only the raw state length would also miss option and instruction tokens.

The adapter therefore requires a `FitMeasurer` that uses the configured checkpoint's tokenizer and the service's exact request rendering and limits. It must return the checkpoint identity, full rendered token count, and effective limit. A different checkpoint, a limit mismatch, an unavailable measurement, or a count above the limit produces `unsupported-input`; the adapter makes no inference request. The harness does not approximate tokenizer counts or silently trim, summarize, or omit visible state.

No production `FitMeasurer` is bundled yet. The upstream [laya-ts source package](https://github.com/NandhaKishorM/laya/tree/main/laya-ts) contains matching TypeScript tokenizer and sequence helpers, but it is not currently published as an npm package. The adapter does not depend on an unversioned Git source. Until a reviewed, pinned tokenizer integration or service-side fit endpoint is provided, Laya runs stop as `unsupported-input: context-unmeasurable` before inference. This is an explicit capability boundary, not a successful Laya integration smoke test.

## Provenance and failure behavior

- A successful result retains the generic served `model` and the exact `routing.model` as `checkpoint`.
- `usage.input_tokens` and `usage.output_tokens` are retained when supplied. The preflight count is kept separately by the fit result.
- Confidence is copied without converting it into Jev's confidence semantics or applying a Jev threshold.
- Successful local inference is marked `not_billed`; no zero-dollar charge is invented.
- A transport failure has unknown execution status. HTTP and invalid-response failures are not retried; the adapter makes at most one inference request.
- The configured checkpoint is sent explicitly. The adapter rejects a response routed to another checkpoint and never falls back to a different provider.

Routine tests use fake transport and do not download weights or start a GPU runtime.
