# Boundary drift

When a contract is implemented through more than one entry path, keep validation and failure scope aligned at the shared execution boundary. A valid batch execution may retain question-local answer failures; invalid provider identity or attempt evidence invalidates the execution even when no answer is usable. For one provider, share transport, retry, envelope, and execution accounting while keeping wire-answer decoding specific. For one application service, keep exhaustive view dispatch shared across entrypoints.

Apply this guard when changing provider single/batch paths, execution validation, retries, or CLI/MCP service dispatch. Preserve typed, bounded diagnostics and the distinct answer/report contracts. Do not force different wire formats or genuinely different public results into one abstraction.

Observed during dev.16 in commits `58a68c3c60d580b818d11fe72557093e47229177` and `4a51516ec3a152c69a3483dab7f694fcefd7de74`. These references identify corrected cases; discoverability and effectiveness remain to be assessed in later work.
