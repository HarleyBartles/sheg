# Run and recover a poll

For a new run, first read [prepare and trace](prepare-and-trace.md) and call `poll_check` with the exact manifest, frozen cohort, provider, and budgets. Resolve validation errors before considering `poll_start`. `poll_check` is keyless and makes no inference call.

Before `poll_start`, report provider, arm count, distinct respondent count, respondent-arm cell count, output directory, maximum calls, and hosted spend limits. For Jev, obtain explicit user authorization for the paid run unless authorization already covers this exact study and these caps.

- Keep one provider for the run. Jev requires both `maxUsd` and `maxPerCallUsd`.
- Read the secret only from the environment variable named by `keyEnv`. Never ask the user to paste a key into chat, store it in a manifest, or include it in output.
- Laya requires a checkpoint-matched context fit measurer. If fit cannot be verified, the adapter must return unsupported input without dispatching. Do not trim content, change providers, or claim the inference ran.

`poll_start` returns a run ID. Use `poll_status` to inspect progress. Call `poll_cancel` when cancellation is requested. After interruption, inspect unpriced-charge state and reconcile unknown hosted charges before `poll_resume`.
