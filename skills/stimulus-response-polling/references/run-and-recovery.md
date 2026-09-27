# Run and recover a poll

For a new run, first read [prepare and trace](prepare-and-trace.md) and call `poll_check` with the exact manifest, frozen cohort, provider, and budgets. Resolve validation errors before considering `poll_start`. `poll_check` is keyless and makes no inference call.

Before `poll_start`, report provider, arm count, distinct respondent count, respondent-arm cell count, output directory, maximum calls, and hosted spend limits. For Jev, obtain explicit user authorization for the paid run unless authorization already covers this exact study and these caps.

- Keep one provider for the run. Jev requires both `maxUsd` and `maxPerCallUsd`.
- Read the secret only from the environment variable named by `keyEnv`. Never ask the user to paste a key into chat, store it in a manifest, or include it in output. `poll_start` and `poll_resume` reject a missing Jev key before launching; `poll_check` remains keyless.
- Laya requires a checkpoint-matched context fit measurer. If fit cannot be verified, the adapter must return unsupported input without dispatching. Do not trim content, change providers, or claim the inference ran.

`poll_start` returns a run ID. Use `poll_status` to inspect progress. Call `poll_cancel` when cancellation is requested.

If a stopped run has `budget.blocked: true` and `unpricedReservations > 0`, inspect the provider billing record for the total actual USD charge of **all** unresolved calls. Obtain the user's verified total, including zero only when the provider confirms no charge. Do not guess from `reservedUsd`, set zero as a convenience, or resume while the charge remains unknown. Call `poll_reconcile` with `outputDirectory`, `runId`, and `unpricedUsd` set to that verified total. The CLI equivalent is `reconcile --output <dir> --run-id <id> --unpriced-usd <verified-total>`. Reconciliation accepts stopped partial, failed, or cancelled runs, records the amount without restoring spent calls, and returns the updated budget. Inspect that budget, then use `poll_resume` for a partial or failed run only when its remaining call and spend allowance permits. A cancelled run remains cancelled after reconciliation. If billing cannot be verified, leave the run blocked.
